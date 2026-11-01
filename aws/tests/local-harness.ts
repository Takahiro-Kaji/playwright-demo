import { spawn } from "node:child_process";
import { loadJournal } from "../../tests/aws-sales/environment/state.ts";
import { localEnvironment } from "./local-adapter.ts";
import { createHarnessTests } from "../../tests/aws-sales/support/harness.ts";
export function createLocalHarnessTests() {
  const file =
    process.env.AWS_SALES_LOCAL_JOURNAL ||
    ".local/aws-sales-qa/local-journal.json";
  process.env.AWS_SALES_JOURNAL = file;
  const { test: batchTest, uiTest: uiBase } =
    createHarnessTests(localEnvironment);
  const uiTest = uiBase.extend({
    browser: async ({ browser }, use) => {
      const j = loadJournal(file);
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
      const original = browser.newContext.bind(browser);
      try {
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
        browser.newContext = async (options) => {
          const c = await original(options);
          await c.route("https://local.example.test/**", async (route) => {
            if (
              !route.request().headers().cookie?.includes("local-qa=local-only")
            )
              return route.fulfill({ status: 401, body: "login" });
            const u = new URL(route.request().url());
            const response = await fetch(
              `http://127.0.0.1:${port}${u.pathname}`,
              {
                method: route.request().method(),
                body: route.request().postData() || undefined,
                headers:
                  route.request().method() === "POST"
                    ? { "content-type": "application/json" }
                    : {},
                signal: AbortSignal.timeout(10000),
              },
            );
            await route.fulfill({
              status: response.status,
              contentType: response.headers.get("content-type") || "text/plain",
              body: Buffer.from(await response.arrayBuffer()),
            });
          });
          return c;
        };
        await use(browser);
      } finally {
        browser.newContext = original;
        child.kill("SIGTERM");
        await closed;
      }
    },
  });

  return { test: batchTest, uiTest };
}
