import { test as base } from "@playwright/test";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  loadJournal,
  requireThat as check,
  saveJournal,
} from "../../tests/aws-sales/environment.ts";
import { localEnvironment } from "./local-adapter.ts";
import { business, type Harness } from "../../tests/aws-sales/harness.ts";
import { scenarios } from "../../tests/aws-sales/scenarios.ts";
import { acquireTestLock, releaseTestLock } from "../../tests/aws-sales/db.ts";
import { verifyAuthPage } from "../../test-support/auth/fixture.ts";
const file = process.env.AWS_SALES_LOCAL_JOURNAL || ".local/aws-sales-qa/local-journal.json";
const test = base.extend<{ h: Harness }>({
  h: [
    async ({ browser }, use, info) => {
      const j = loadJournal(file),
        env = localEnvironment(file, j);
      check(j.phase === "prepared" && !j.blocked, "LOCAL_RECOVERY_REQUIRED");
      const child = spawn(
        "kubectl",
        [
          "--context",
          j.config.context,
          "-n",
          j.namespace,
          "port-forward",
          "--address=127.0.0.1",
          "service/sales-app",
          ":8080",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const closed = new Promise<void>((r) => child.once("close", () => r()));
      const port = await new Promise<number>((ok, no) => {
        const timer = setTimeout(
          () => no(Error("LOCAL_FORWARD_TIMEOUT")),
          10000,
        );
        child.on("error", () => {
          clearTimeout(timer);
          no(Error("LOCAL_FORWARD_FAILED"));
        });
        child.stdout.on("data", (b) => {
          const m = b.toString().match(/127\.0\.0\.1:(\d+)/);
          if (m) {
            clearTimeout(timer);
            ok(Number(m[1]));
          }
        });
        child.stderr.on("data", () => {});
      });
      const context = await browser.newContext({
        storageState: JSON.parse(readFileSync(j.config.stateFile, "utf8")),
        serviceWorkers: "block",
      });
      await context.route("https://local.example.test/**", async (route) => {
        if (!route.request().headers().cookie?.includes("local-qa=local-only"))
          return route.fulfill({ status: 401, body: "login" });
        const u = new URL(route.request().url());
        const response = await fetch(`http://127.0.0.1:${port}${u.pathname}`, {
          method: route.request().method(),
          body: route.request().postData() || undefined,
          headers:
            route.request().method() === "POST"
              ? { "content-type": "application/json" }
              : {},
          signal: AbortSignal.timeout(10000),
        });
        await route.fulfill({
          status: response.status,
          contentType: response.headers.get("content-type") || "text/plain",
          body: Buffer.from(await response.arrayBuffer()),
        });
      });
      const page = await context.newPage();
      await verifyAuthPage(page, {
        target: j.config.url,
        expected: j.config.url,
        selector: "#refresh",
        state: j.config.stateFile,
      });
      const db = await env.pool(),
        lock = await acquireTestLock(db);
      const h: Harness = {
        env,
        db,
        page,
        context,
        verdict: "unconfirmed",
        codes: [],
        afterActions: [],
      };
      try {
        await env.catalog("f1");
        await env.reset(db);
        await use(h);
      } finally {
        const errors: unknown[] = [];
        await context.close();
        child.kill("SIGTERM");
        await closed;
        for (const action of h.afterActions)
          try {
            await action();
          } catch (e) {
            errors.push(e);
          }
        try {
          await env.restore(db);
        } catch (e) {
          errors.push(e);
        }
        try {
          await releaseTestLock(lock);
        } catch (e) {
          errors.push(e);
        }
        await db.end();
        j.blocked = errors.length > 0;
        j.results.push({
          id: info.title.split(" ")[0],
          verdict: h.verdict,
          after: errors.length ? "failed" : "confirmed",
          codes: h.codes,
          observations: h.observations,
        });
        saveJournal(file, j);
        info.annotations.push(
          { type: "business", description: h.verdict },
          {
            type: "after",
            description: errors.length ? "failed" : "confirmed",
          },
        );
        if (errors.length)
          throw new AggregateError(errors, "LOCAL_AFTER_FAILED");
      }
    },
    { timeout: 360000 },
  ],
});
for (const s of scenarios)
  test(s.title, async ({ h }) => business(h, () => s.run(h)));
