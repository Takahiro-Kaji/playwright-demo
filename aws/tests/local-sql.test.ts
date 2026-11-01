// ローカルkind用の結合検証。実際のMySQL 8.4とKubernetes Jobを使用する。
import { test } from "node:test";
import { strict as a } from "node:assert";
import { loadJournal } from "../../tests/aws-sales/environment/state.ts";
import { localEnvironment } from "./local-adapter.ts";
import { expectedFixture } from "../../tests/aws-sales/upstream/fixtures.ts";
import { acquireTestLock, releaseTestLock } from "../../tests/aws-sales/database/test-lock.ts";
import { compareMysql, snapshotMysql } from "../../tests/aws-sales/database/rows.ts";
const file =
  process.env.AWS_SALES_LOCAL_JOURNAL ||
  ".local/aws-sales-qa/local-journal.json";
test("実SQLの故障・権限制限・復元・実Jobの期限切れ停止を確認する", async () => {
  const j = loadJournal(file),
    env = localEnvironment(file, j),
    db = await env.database.pool(),
    lock = await acquireTestLock(db);
  try {
    await env.restore(db);
    const want = expectedFixture("f1");
    const faults: Array<[string, string, string]> = [
      [
        "UPDATE products SET price=121 WHERE product_code='P001'",
        "UPDATE products SET price=120 WHERE product_code='P001'",
        "product:value:",
      ],
      [
        "UPDATE products SET version=-1 WHERE product_code='P001'",
        "UPDATE products SET version=1 WHERE product_code='P001'",
        "product:version:",
      ],
      [
        "DELETE FROM inventory WHERE product_code='P001'",
        "INSERT INTO inventory VALUES ('P001',5)",
        "inventory:missing:",
      ],
      [
        "INSERT INTO products VALUES ('EXTRA','extra',1,1,1)",
        "DELETE FROM products WHERE product_code='EXTRA'",
        "product:extra:",
      ],
      [
        "UPDATE sync_state SET catalog_version=2 WHERE id=1",
        "UPDATE sync_state SET catalog_version=1 WHERE id=1",
        "sync_state:value",
      ],
    ];
    for (const [inject, restore, code] of faults) {
      await db.query(inject);
      a.ok((await compareMysql(db, want)).some((c) => c.startsWith(code)));
      await db.query(restore);
      a.deepEqual(await compareMysql(db, want), []);
    }
    const id = "11111111-1111-4111-8111-111111111111";
    await db.execute("INSERT INTO orders VALUES (?, 'P002',1,120,'CREATED')", [
      id,
    ]);
    const wrong = {
      ...want,
      orders: [
        {
          order_id: id,
          product_code: "P001",
          quantity: 1,
          unit_price: 120,
          status: "CREATED",
        },
      ],
    };
    a.ok(
      (await compareMysql(db, wrong)).some((c) => c.startsWith("order:value:")),
    );
    await db.execute("DELETE FROM orders WHERE order_id=?", [id]);
    const before = await snapshotMysql(db),
      c = await db.getConnection();
    try {
      await c.beginTransaction();
      await c.query(
        "UPDATE inventory SET quantity=0 WHERE product_code='P001'",
      );
      await c.rollback();
    } finally {
      c.release();
    }
    a.deepEqual(await snapshotMysql(db), before);
    await a.rejects(db.query("SELECT * FROM mysql.user"));
    await a.rejects(db.query("DELETE FROM aws_test_owner"));
    a.equal((await env.batches.run(1)).outcome, "timeout");
  } finally {
    try {
      await env.restore(db);
    } finally {
      await releaseTestLock(lock);
      await db.end();
    }
  }
});
