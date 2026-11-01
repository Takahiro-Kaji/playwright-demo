import { appendFileSync } from "node:fs";
import {
  createHarnessTests,
  business,
  Unconfirmed,
} from "../../aws-sales/harness.ts";
import { Environment } from "../../aws-sales/lifecycle.ts";
import { ids } from "../../aws-sales/reporter.ts";

class FakeEnvironment extends Environment {
  async verifyBatchTarget() {}
  async pool() {
    return {
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
    } as any;
  }
  async dbOwner() {}
  async catalog() {}
  async reset() {}
  async restore() {
    if (process.env.SEQUENCE_CASE === "after" && this.j.results.length === 4)
      throw Error("INJECTED_RESTORE_FAILURE");
  }
}
const { test } = createHarnessTests(
  (file, journal) => new FakeEnvironment(file, journal),
);
for (const id of ids) {
  test(`${id} sequence`, async ({ h }) => {
    appendFileSync(process.env.SEQUENCE_MARKER!, `${id}\n`);
    await business(h, async () => {
      if (
        id === "CROSS-01" &&
        ["unconfirmed", "after"].includes(process.env.SEQUENCE_CASE!)
      )
        throw new Unconfirmed("OVERLAP_NOT_OBSERVED");
      if (id === "CROSS-01" && process.env.SEQUENCE_CASE === "failure")
        throw Error("INJECTED_BODY_FAILURE");
    });
  });
}
