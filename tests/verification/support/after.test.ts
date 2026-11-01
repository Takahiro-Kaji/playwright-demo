import { test } from "node:test";
import { strict as assert } from "node:assert";
import { settleAfter } from "../../../test-support/after.ts";

test("復元失敗後も停止を試み両方の失敗を保持する", async () => {
  const calls: string[] = [];
  const errors = await settleAfter([
    async () => {
      calls.push("restore");
      throw Error("restore failed");
    },
    async () => {
      calls.push("stop");
      throw Error("stop unconfirmed");
    },
  ]);
  assert.deepEqual(calls, ["restore", "stop"]);
  assert.deepEqual(errors.map(String), [
    "Error: restore failed",
    "Error: stop unconfirmed",
  ]);
});
