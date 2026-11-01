import { test } from "node:test";
import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { compareCatalog } from "../../targets/sales/compare.ts";
const expected = [
  { productCode: "P001", name: "ペン", price: 120, active: true, quantity: 5 },
];
function create() {
  const d = new DatabaseSync(":memory:");
  d.exec(
    "CREATE TABLE products(product_code TEXT,name TEXT,price INTEGER,active INTEGER); CREATE TABLE inventory(product_code TEXT,quantity INTEGER); INSERT INTO products VALUES('P001','ペン',120,1); INSERT INTO inventory VALUES('P001',5)",
  );
  return d;
}
test("SQLから復元・照合し欠落、重複、余剰、値、関連、削除漏れを検出", () => {
  const mutations: [string, string][] = [
    ["DELETE FROM products", "product:missing:P001"],
    [
      "INSERT INTO products VALUES('P001','ペン',120,1)",
      "product:duplicate:P001",
    ],
    ["INSERT INTO products VALUES('P002','extra',1,1)", "product:extra:P002"],
    ["UPDATE products SET price=121", "product:value:P001"],
    ["UPDATE inventory SET product_code='ORPHAN'", "inventory:orphan:ORPHAN"],
    [
      "INSERT INTO products VALUES('REMOVED','old',1,0); INSERT INTO inventory VALUES('REMOVED',2)",
      "product:deletion:REMOVED",
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
});
