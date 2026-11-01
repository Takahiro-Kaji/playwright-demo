import {
  test as base,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";
import type { Pool, PoolConnection } from "mysql2/promise";
import { readFileSync } from "node:fs";
import { Environment } from "./lifecycle.ts";
import {
  exclusive,
  loadJournal,
  saveJournal,
  requireThat as check,
  type CaseResult,
  errorCodes,
} from "./environment.ts";
import { acquireTestLock, releaseTestLock, verifyTestLock } from "./db.ts";
import { verifyAuthPage } from "../../test-support/auth/fixture.ts";

export class Unconfirmed extends Error {}
export type BaseHarness = {
  env: Environment;
  db: Pool;
  verdict: CaseResult["verdict"];
  codes: string[];
  afterActions: Array<() => Promise<void>>;
  observations?: unknown;
  differences?: Record<string, number>;
};
export type Harness = BaseHarness & { page: Page; context: BrowserContext };
type UiSession = { page: Page; context: BrowserContext };
export async function business(h: BaseHarness, fn: () => Promise<void>) {
  try {
    await fn();
    h.verdict = "passed";
  } catch (e) {
    h.verdict = e instanceof Unconfirmed ? "unconfirmed" : "failed";
    h.codes.push(
      ...(e instanceof Unconfirmed ? ["OVERLAP_UNCONFIRMED"] : errorCodes(e)),
    );
    throw Error(
      h.verdict === "unconfirmed" ? "AWS_CASE_UNCONFIRMED" : "AWS_CASE_FAILED",
    );
  }
}
export function createHarnessTests(
  create: (
    file: string,
    j: import("./environment.ts").Journal,
  ) => Environment = (file, j) => new Environment(file, j),
) {
  const common = base.extend<{
    h: BaseHarness;
    uiSession: UiSession | undefined;
  }>({
    uiSession: async ({}, use) => {
      await use(undefined);
    },
    h: [
      async ({ uiSession }, use, info: TestInfo) => {
        const file = process.env.AWS_SALES_JOURNAL;
        check(file, "AWS_SALES_JOURNAL_REQUIRED");
        const unlock = exclusive(file);
        let db: Pool | undefined,
          lock: PoolConnection | undefined,
          context: BrowserContext | undefined,
          h: BaseHarness | undefined,
          env: Environment | undefined,
          safe = false;
        const errors: unknown[] = [];
        try {
          const j = loadJournal(file);
          check(j.phase === "prepared" && !j.blocked, "RUN_REQUIRES_RECOVERY");
          env = create(file, j);
          await base.step(
            "Given: 設定・保存認証・AWS対象・所有関係の確認",
            async () => {
              context = uiSession?.context;
              if (uiSession) await env!.verifyTarget();
              else await env!.verifyBatchTarget();
              db = await env!.pool();
              await env!.dbOwner(db);
              lock = await acquireTestLock(db);
              await verifyTestLock(lock);
              safe = true;
              // Mark active before the first mutation, so a killed process cannot be rerun silently.
              j.blocked = true;
              saveJournal(file, j);
              h = {
                env: env!,
                db,
                verdict: "unconfirmed",
                codes: [],
                afterActions: [],
              };
              await env!.catalog("f1");
              await env!.reset(db);
            },
          );
          await use(h!);
        } catch {
          if (h && h.verdict === "unconfirmed" && !h.codes.length) {
            h.verdict = "failed";
            h.codes.push("SETUP_OR_BODY_FAILED");
          }
          throw Error("AWS_BUSINESS_TEST_FAILED");
        } finally {
          try {
            await base.step(
              "After: 画面回収・上流復元・DB全件復元・Job停止確認",
              async () => {
                // Closing the page first prevents a late UI request from racing restoration.
                if (context)
                  try {
                    await context.close();
                  } catch (e) {
                    errors.push(e);
                  }
                let canRestore = safe;
                if (safe && lock)
                  try {
                    await verifyTestLock(lock);
                  } catch (e) {
                    errors.push(e);
                    canRestore = false;
                  }
                if (h && canRestore)
                  for (const action of h.afterActions)
                    try {
                      await action();
                    } catch (e) {
                      errors.push(e);
                    }
                if (canRestore && env && db)
                  try {
                    await env.restore(db);
                  } catch (e) {
                    errors.push(e);
                  }
                if (safe && !canRestore && env)
                  try {
                    await env.stopJobs();
                  } catch (e) {
                    errors.push(e);
                  }
                if (lock)
                  try {
                    await releaseTestLock(lock);
                  } catch (e) {
                    errors.push(e);
                  }
                if (db)
                  try {
                    await db.end();
                  } catch (e) {
                    errors.push(e);
                  }
                if (env) {
                  env.j.blocked = safe
                    ? errors.length > 0 || (env.j.blocked && h === undefined)
                    : env.j.blocked;
                  // Restore() must not erase a Job-stop failure; it sets blocked itself.
                  if (
                    safe &&
                    !errors.length &&
                    h &&
                    !h.codes.includes("STOP_UNCONFIRMED")
                  )
                    env.j.blocked = false;
                  const result: CaseResult = {
                    id: info.title.split(" ")[0],
                    verdict: h?.verdict || "failed",
                    after: errors.length ? "failed" : "confirmed",
                    codes: h?.codes || ["SETUP_FAILED"],
                    observations: h?.observations,
                    differences: h?.differences,
                  };
                  if (errors.length)
                    result.codes.push(
                      "AFTER_FAILED",
                      ...errors.flatMap(errorCodes),
                    );
                  env.j.results.push(result);
                  saveJournal(file, env.j);
                  info.annotations.push(
                    { type: "business", description: result.verdict },
                    { type: "after", description: result.after },
                    { type: "safe-codes", description: result.codes.join(",") },
                  );
                }
                if (errors.length) throw Error("AWS_AFTER_FAILED");
              },
            );
          } finally {
            unlock();
          }
        }
      },
      { timeout: 360000 },
    ],
  });

  const uiTest = common.extend<{ uiHarness: Harness }>({
    uiSession: [
      async ({ browser }, use) => {
        const file = process.env.AWS_SALES_JOURNAL;
        check(file, "AWS_SALES_JOURNAL_REQUIRED");
        const j = loadJournal(file);
        let state;
        try {
          state = JSON.parse(readFileSync(j.config.stateFile, "utf8"));
          check(
            Array.isArray(state.cookies) && Array.isArray(state.origins),
            "AUTH_STATE_INVALID",
          );
        } catch {
          throw Error("AUTH_STATE_UNAVAILABLE");
        }
        const context = await browser.newContext({
          storageState: state,
          serviceWorkers: "block",
        });
        try {
          const page = await context.newPage();
          await verifyAuthPage(page, {
            state: j.config.stateFile,
            target: j.config.url,
            expected: j.config.url,
            selector: "#refresh",
          });
          await use({ context, page });
        } finally {
          await context.close();
        }
      },
      { scope: "test", timeout: 45000 },
    ],
    uiHarness: async ({ h, uiSession }, use) => {
      check(uiSession, "UI_SESSION_REQUIRED");
      await use(Object.assign(h, uiSession));
    },
  });
  return { test: common, uiTest };
}
const defaults = createHarnessTests();
export const test = defaults.test;
export const uiTest = defaults.uiTest;
