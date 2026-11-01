// Verification only: real production fixture + local fake DB/cluster and a routed Chrome page.
import { readResponseJson } from "../../aws-sales/support/response-body.ts";
import type { Response } from "@playwright/test";
import {
  uiTest as production,
  business,
} from "../../aws-sales/support/harness.ts";
import { TargetVerifier } from "../../aws-sales/environment/target-verifier.ts";
import { SalesDatabase } from "../../aws-sales/database/database.ts";
import { UpstreamCatalog } from "../../aws-sales/upstream/catalog.ts";
import { Environment } from "../../aws-sales/environment/lifecycle.ts";
import { Cluster } from "../../aws-sales/environment/cluster.ts";
import { loadJournal } from "../../aws-sales/environment/state.ts";
import { writeFileSync } from "node:fs";
// ログ取得失敗も注入し、実クラスタへ接続せず後処理の継続を確認する。
Cluster.prototype.verify = async () => {
  throw Error("INJECTED_LOG_FAILURE");
};
TargetVerifier.prototype.verifyUi = async () => {
  if (process.env.TARGET_MARKER)
    writeFileSync(process.env.TARGET_MARKER, "verified");
};
SalesDatabase.prototype.pool = async () =>
  ({
    getConnection: async () => ({
      query: async (sql: string) => [
        [
          sql.includes("GET_LOCK")
            ? { acquired: 1 }
            : sql.includes("RELEASE_LOCK")
              ? { released: 1 }
              : { held: 1 },
        ],
      ],
      release() {},
      destroy() {},
    }),
    end: async () => {},
  }) as any;
SalesDatabase.prototype.verifyOwner = async () => {};
UpstreamCatalog.prototype.useFixture = async () => {};
SalesDatabase.prototype.reset = async () => {};
Environment.prototype.restore = async () => {
  if (process.env.INJECT_BODY === "timeout") return;
  throw Error("INJECTED_RESTORE_FAILURE");
};
const test = production.extend({
  browser: async ({ browser }, use) => {
    const original = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
      const context = await original(options);
      await context.route("https://test.example.com/**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body:
            process.env.UI_AUTH_MODE === "expired"
              ? "<div>login</div>"
              : '<button id="refresh">商品表示</button>',
        }),
      );
      return context;
    };
    try {
      await use(browser);
    } finally {
      browser.newContext = original;
    }
  },
});
test("UI-01 本体と後処理に故障を注入する", async ({ uiHarness: h }) =>
  business(h, async () => {
    if (process.env.INJECT_BODY === "1") throw Error("INJECTED_BODY_FAILURE");
    if (process.env.INJECT_BODY === "timeout")
      await readResponseJson(
        { finished: () => new Promise(() => {}) } as Response,
        30,
      );
  }));
test("UI-02 復元失敗後は実行しない", async () => {
  writeFileSync(process.env.STOP_MARKER!, "unexpected");
});
