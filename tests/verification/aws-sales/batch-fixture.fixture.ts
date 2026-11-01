// Proves the production batch fixture does not ask Playwright for a browser.
import { test as batchTest, business } from "../../aws-sales/support/harness.ts";
import { TargetVerifier } from "../../aws-sales/environment/target-verifier.ts";
import { SalesDatabase } from "../../aws-sales/database/database.ts";
import { UpstreamCatalog } from "../../aws-sales/upstream/catalog.ts";
import { Environment } from "../../aws-sales/environment/lifecycle.ts";
import { writeFileSync } from "node:fs";
TargetVerifier.prototype.verifyBatch = async () => {
  writeFileSync(process.env.TARGET_MARKER!, "verified");
};
TargetVerifier.prototype.verifyUi = async () => {
  throw Error("UI_TARGET_MUST_NOT_BE_USED");
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
Environment.prototype.restore = async () => {};
const test = batchTest.extend({
  browser: async ({}, use) => {
    writeFileSync(process.env.BROWSER_MARKER!, "unexpected");
    throw Error("BROWSER_MUST_NOT_START");
  },
});
for (const id of ["BATCH-01", "BATCH-02"])
  test(`${id} 認証なしでバッチ用の環境を利用できる`, async ({ h }) =>
    business(h, async () => {
      if ("page" in h || "context" in h)
        throw Error("BATCH_MUST_NOT_RECEIVE_UI_OBJECT");
    }));
