import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { Pool, PoolConnection } from "mysql2/promise";
import { acquireTestLock, releaseTestLock, verifyTestLock } from "../../aws-sales/database/test-lock.ts";

function fake(query: () => Promise<unknown>) {
  const calls: string[] = [];
  const connection = {
    query,
    release() {
      calls.push("release");
    },
    destroy() {
      calls.push("destroy");
    },
  } as unknown as PoolConnection;
  return {
    calls,
    connection,
    pool: { getConnection: async () => connection } as Pool,
  };
}
test("ロック解放を確認した後だけ接続をプールに戻す", async () => {
  let count = 0;
  const f = fake(async () => [[count++ ? { released: 1 } : { acquired: 1 }]]);
  const c = await acquireTestLock(f.pool);
  assert.deepEqual(f.calls, []);
  await releaseTestLock(c);
  assert.deepEqual(f.calls, ["release"]);
});
test("ロックを取得できなければ接続を破棄する", async () => {
  const f = fake(async () => [[{ acquired: 0 }]]);
  await assert.rejects(acquireTestLock(f.pool), /AWS_TEST_LOCK_UNAVAILABLE/);
  assert.deepEqual(f.calls, ["destroy"]);
});
test("ロック取得が未確認なら接続を破棄しエラーを保持する", async () => {
  const cause = Error("connection lost");
  const f = fake(async () => {
    throw cause;
  });
  await assert.rejects(acquireTestLock(f.pool), (e) => e === cause);
  assert.deepEqual(f.calls, ["destroy"]);
});
test("ロック解放が未確認なら接続を破棄しエラーを保持する", async () => {
  const cause = Error("release failed");
  const f = fake(async () => {
    throw cause;
  });
  await assert.rejects(releaseTestLock(f.connection), (e) => e === cause);
  assert.deepEqual(f.calls, ["destroy"]);
  const g = fake(async () => [[{ released: null }]]);
  await assert.rejects(releaseTestLock(g.connection), /AWS_TEST_LOCK_LOST/);
  assert.deepEqual(g.calls, ["destroy"]);
});
test("接続破棄の失敗で元のクエリエラーを上書きしない", async () => {
  const cause = Error("original query failure");
  const connection = {
    query: async () => {
      throw cause;
    },
    destroy: () => {
      throw Error("destroy failure");
    },
    release: () => {
      throw Error("must not release");
    },
  } as unknown as PoolConnection;
  const pool = { getConnection: async () => connection } as Pool;
  await assert.rejects(acquireTestLock(pool), (error) => error === cause);
  await assert.rejects(releaseTestLock(connection), (error) => error === cause);
});
test("保持したロックを同じセッションで確認し失った接続を破棄する", async () => {
  const valid = fake(async () => [[{ held: 1 }]]);
  await verifyTestLock(valid.connection);
  assert.deepEqual(valid.calls, []);
  const lost = fake(async () => [[{ held: 0 }]]);
  await assert.rejects(verifyTestLock(lost.connection), /AWS_TEST_LOCK_LOST/);
  assert.deepEqual(lost.calls, ["destroy"]);
});
