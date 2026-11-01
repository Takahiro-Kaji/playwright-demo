import { test } from "node:test";
import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import {
  compareCatalog,
  type ExpectedState,
} from "../../targets/sales/compare.ts";
const expected: ExpectedState = {
  products: [
    {
      productCode: "P001",
      name: "ペン",
      price: 120,
      active: true,
      quantity: 5,
      version: 1,
    },
  ],
  deleted: [
    {
      productCode: "OLD",
      name: "旧商品",
      price: 10,
      active: false,
      quantity: 0,
      version: 2,
    },
  ],
  catalogVersion: 1,
  orders: [
    {
      order_id: "order-1",
      product_code: "P001",
      quantity: 1,
      unit_price: 120,
      status: "CREATED",
    },
  ],
};
function create() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE products(product_code TEXT,name TEXT,price INTEGER,active INTEGER,version INTEGER);
    CREATE TABLE inventory(product_code TEXT,quantity INTEGER);
    CREATE TABLE sync_state(id INTEGER,catalog_version INTEGER);
    CREATE TABLE orders(order_id TEXT,product_code TEXT,quantity INTEGER,unit_price INTEGER,status TEXT);
    INSERT INTO products VALUES('P001','ペン',120,1,1),('OLD','旧商品',10,0,2);
    INSERT INTO inventory VALUES('P001',5),('OLD',0);
    INSERT INTO sync_state VALUES(1,1);
    INSERT INTO orders VALUES('order-1','P001',1,120,'CREATED');`);
  return db;
}
test("SQLから件数・キー・値・関連・version・同期・受注を照合し故障を検出", () => {
  const mutations: [string, string][] = [
    ["DELETE FROM products WHERE product_code='P001'", "product:missing:P001"],
    [
      "INSERT INTO products VALUES('P001','ペン',120,1,1)",
      "product:duplicate:P001",
    ],
    ["INSERT INTO products VALUES('P002','extra',1,1,1)", "product:extra:P002"],
    [
      "INSERT INTO products VALUES('SURPLUS','inactive',1,0,1); INSERT INTO inventory VALUES('SURPLUS',0)",
      "product:extra:SURPLUS",
    ],
    [
      "UPDATE products SET price=121 WHERE product_code='P001'",
      "product:value:P001",
    ],
    [
      "UPDATE inventory SET product_code='ORPHAN' WHERE product_code='P001'",
      "inventory:orphan:ORPHAN",
    ],
    [
      "UPDATE inventory SET quantity=2 WHERE product_code='OLD'",
      "inventory:value:OLD",
    ],
    [
      "UPDATE products SET version=3 WHERE product_code='P001'",
      "product:version:P001",
    ],
    ["UPDATE sync_state SET catalog_version=2", "sync_state:value"],
    ["UPDATE orders SET quantity=2", "order:value:order-1"],
    [
      "INSERT INTO orders VALUES('extra','P001',1,120,'CREATED')",
      "order:extra:extra",
    ],
  ];
  const ok = create();
  assert.deepEqual(compareCatalog(ok, expected), []);
  ok.close();
  for (const [sql, want] of mutations) {
    const db = create();
    try {
      db.exec(sql);
      assert.ok(compareCatalog(db, expected).includes(want), want);
    } finally {
      db.close();
    }
  }
  const db = create();
  try {
    assert.throws(
      () =>
        compareCatalog(db, {
          ...expected,
          deleted: [{ ...expected.deleted[0], quantity: 1 }],
        }),
      /INVALID_DELETION_EXPECTATION/,
    );
  } finally {
    db.close();
  }
});
