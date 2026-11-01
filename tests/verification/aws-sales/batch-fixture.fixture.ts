// Proves the production batch fixture does not ask Playwright for a browser.
import { test as batchTest, business } from "../../aws-sales/harness.ts";
import { Environment } from "../../aws-sales/lifecycle.ts";
import { writeFileSync } from "node:fs";
Environment.prototype.verifyBatchTarget = async () => {
  writeFileSync(process.env.TARGET_MARKER!, "verified");
};
Environment.prototype.verifyTarget = async () => {
  throw Error("UI_TARGET_MUST_NOT_BE_USED");
};
Environment.prototype.pool = async () =>
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
Environment.prototype.dbOwner = async () => {};
Environment.prototype.catalog = async () => {};
Environment.prototype.reset = async () => {};
Environment.prototype.restore = async () => {};
const test = batchTest.extend({
  browser: async ({}, use) => {
    writeFileSync(process.env.BROWSER_MARKER!, "unexpected");
    throw Error("BROWSER_MUST_NOT_START");
  },
});
for (const id of ["BATCH-01", "BATCH-02"])
  test(`${id} fixture without authentication`, async ({ h }) =>
    business(h, async () => {
      if ("page" in h || "context" in h)
        throw Error("BATCH_MUST_NOT_RECEIVE_UI_OBJECT");
    }));
