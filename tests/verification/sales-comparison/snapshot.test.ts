import { test } from "node:test";
import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { snapshotSales } from "../../targets/sales/snapshot.ts";

test("4表のsnapshotは商品名・価格・version・P002と他表の変化を検出", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE products(product_code TEXT,name TEXT,price INTEGER,version INTEGER); CREATE TABLE inventory(product_code TEXT,quantity INTEGER); CREATE TABLE sync_state(id INTEGER,catalog_version INTEGER); CREATE TABLE orders(order_id TEXT); INSERT INTO products VALUES('P001','ペン',120,1),('P002','ノート',300,1); INSERT INTO inventory VALUES('P001',5),('P002',2); INSERT INTO sync_state VALUES(1,1);`,
  );
  const before = snapshotSales(db);
  for (const sql of [
    "UPDATE products SET name='bad' WHERE product_code='P001'",
    "UPDATE products SET price=999 WHERE product_code='P001'",
    "UPDATE products SET version=2 WHERE product_code='P001'",
    "UPDATE products SET name='bad' WHERE product_code='P002'",
    "UPDATE inventory SET quantity=9 WHERE product_code='P002'",
    "UPDATE sync_state SET catalog_version=2",
    "INSERT INTO orders VALUES('unexpected')",
  ]) {
    db.exec(sql);
    assert.notDeepEqual(snapshotSales(db), before, sql);
    db.exec(
      "DELETE FROM products; INSERT INTO products VALUES('P001','ペン',120,1),('P002','ノート',300,1); DELETE FROM inventory; INSERT INTO inventory VALUES('P001',5),('P002',2); DELETE FROM sync_state; INSERT INTO sync_state VALUES(1,1); DELETE FROM orders;",
    );
  }
  assert.deepEqual(snapshotSales(db), before);
  db.close();
});
