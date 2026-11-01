import { test } from "node:test";
import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { snapshotSales } from "../../targets/sales/snapshot.ts";

const scope = "test-abc:";
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE products(product_code TEXT,name TEXT,price INTEGER,active INTEGER,version INTEGER);
    CREATE TABLE inventory(product_code TEXT,quantity INTEGER);
    CREATE TABLE sales_sync_scopes(scope TEXT,catalog_version INTEGER);
    CREATE TABLE orders(order_id TEXT,product_code TEXT,quantity INTEGER,unit_price INTEGER,status TEXT);
    INSERT INTO products VALUES('test-abc:P001','ペン',120,1,1),('test-abc:P002','ノート',300,1,1),('test-def:P001','他ケース',100,1,1);
    INSERT INTO inventory VALUES('test-abc:P001',5),('test-abc:P002',2),('test-def:P001',9);
    INSERT INTO sales_sync_scopes VALUES('test-abc:',1),('test-def:',1);
  `);
  return db;
}

test("受注snapshotはscope内全商品の値・欠落・新規受注を検出する", () => {
  const db = setup();
  try {
    const before = snapshotSales(db, scope, { kind: "order" });
    for (const sql of [
      "UPDATE products SET name='bad' WHERE product_code='test-abc:P001'",
      "UPDATE products SET price=999 WHERE product_code='test-abc:P001'",
      "UPDATE products SET active=0 WHERE product_code='test-abc:P001'",
      "UPDATE products SET version=2 WHERE product_code='test-abc:P001'",
      "UPDATE inventory SET quantity=9 WHERE product_code='test-abc:P001'",
      "DELETE FROM inventory WHERE product_code='test-abc:P001'",
      "DELETE FROM products WHERE product_code='test-abc:P001'",
      "UPDATE products SET price=999 WHERE product_code='test-abc:P002'",
      "UPDATE inventory SET quantity=0 WHERE product_code='test-abc:P002'",
      "INSERT INTO orders VALUES('other','test-abc:P002',1,300,'CREATED')",
      "INSERT INTO products VALUES('test-abc:P003','追加',50,1,1)",
      "INSERT INTO orders VALUES('new','test-abc:P001',1,120,'CREATED')",
    ]) {
      const changed = setup();
      changed.exec(sql);
      assert.notDeepEqual(
        snapshotSales(changed, scope, { kind: "order" }),
        before,
        sql,
      );
      changed.close();
    }
  } finally {
    db.close();
  }
});

test("受注snapshotは他スコープ・同期世代を取得しない", () => {
  const db = setup();
  try {
    const before = snapshotSales(db, scope, { kind: "order" });
    db.exec(`
      UPDATE products SET price=999 WHERE product_code='test-def:P001';
      UPDATE inventory SET quantity=0 WHERE product_code='test-def:P001';
      INSERT INTO orders VALUES('other','test-def:P001',1,100,'CREATED');
      DROP TABLE sales_sync_scopes;
    `);
    assert.deepEqual(snapshotSales(db, scope, { kind: "order" }), before);
    assert.deepEqual(
      before.products.map((p) => p.product_code),
      [scope + "P001", scope + "P002"],
    );
  } finally {
    db.close();
  }
});

test("同期snapshotはscope内の追加・在庫・同期世代を検出し、受注表を取得しない", () => {
  const db = setup();
  try {
    const before = snapshotSales(db, scope, { kind: "sync" });
    db.exec(
      "DROP TABLE orders; UPDATE sales_sync_scopes SET catalog_version=2 WHERE scope='test-def:'",
    );
    assert.deepEqual(snapshotSales(db, scope, { kind: "sync" }), before);
    for (const sql of [
      "INSERT INTO products VALUES('test-abc:P003','追加',50,1,1)",
      "UPDATE inventory SET quantity=0 WHERE product_code='test-abc:P002'",
      "UPDATE sales_sync_scopes SET catalog_version=2 WHERE scope='test-abc:'",
    ]) {
      const changed = setup();
      changed.exec(sql);
      assert.notDeepEqual(
        snapshotSales(changed, scope, { kind: "sync" }),
        before,
        sql,
      );
      changed.close();
    }
  } finally {
    db.close();
  }
});

test("空のscopeを拒否し、SQL失敗後は再取得できる", () => {
  const db = setup();
  try {
    assert.throws(
      () => snapshotSales(db, "", { kind: "sync" }),
      /SCOPE_REQUIRED/,
    );
    db.exec("ALTER TABLE orders RENAME TO saved_orders");
    assert.throws(
      () => snapshotSales(db, scope, { kind: "order" }),
      /no such table/,
    );
    db.exec("ALTER TABLE saved_orders RENAME TO orders");
    assert.doesNotThrow(() => snapshotSales(db, scope, { kind: "order" }));
  } finally {
    db.close();
  }
});
