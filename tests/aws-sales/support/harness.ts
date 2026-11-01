import {
  test as base,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";
import type { Pool } from "mysql2/promise";
import { readFileSync } from "node:fs";
import { Environment } from "../environment/lifecycle.ts";
import {
  exclusive,
  loadJournal,
  assertCondition,
  type CaseResult,
  errorCodes,
} from "../environment/state.ts";
import { HarnessSession, type EnvironmentFactory } from "./harness-session.ts";
import { verifyAuthPage } from "../../../test-support/auth/fixture.ts";

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
    if (e instanceof Unconfirmed)
      base.skip(true, "Business result unconfirmed");
    throw Error("AWS_CASE_FAILED");
  }
}
export function createHarnessTests(
  create: EnvironmentFactory = (file, j) => new Environment(file, j),
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
        assertCondition(file, "AWS_SALES_JOURNAL_REQUIRED");
        const unlock = exclusive(file);
        const session = new HarnessSession(file, create, uiSession);
        try {
          session.initialize();
          const h = await base.step(
            "Given: 設定・保存認証・AWS対象・所有関係の確認",
            () => session.prepare(),
          );
          await use(h);
        } catch {
          session.markFailed();
          throw Error("AWS_BUSINESS_TEST_FAILED");
        } finally {
          try {
            await base.step(
              "After: 画面回収・上流復元・DB全件復元・Job停止確認",
              () => session.finish(info),
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
        assertCondition(file, "AWS_SALES_JOURNAL_REQUIRED");
        const j = loadJournal(file);
        let state;
        try {
          state = JSON.parse(readFileSync(j.config.stateFile, "utf8"));
          assertCondition(
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
      assertCondition(uiSession, "UI_SESSION_REQUIRED");
      await use(Object.assign(h, uiSession));
    },
  });
  return { test: common, uiTest };
}
const defaults = createHarnessTests();
export const test = defaults.test;
export const uiTest = defaults.uiTest;
