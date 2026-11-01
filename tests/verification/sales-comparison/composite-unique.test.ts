import { test } from "node:test";
import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import {
  compareCompanyProducts,
  compareCompanyProductRows,
  companyProductKey,
  type CompanyProduct,
} from "../../targets/sales/compare-company-products.ts";

// 商品コードP001が同じでも会社が違えば別の行。期待値は実データから作らず固定する。
const expected: CompanyProduct[] = [
  { company_code: "C001", product_code: "P001", name: "ペン", price: 120 },
  { company_code: "C001", product_code: "P002", name: "ノート", price: 300 },
  { company_code: "C002", product_code: "P001", name: "ペン", price: 150 },
];
const companies = ["C001", "C002"];
function create() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE company_products (
      company_code TEXT NOT NULL,
      product_code TEXT NOT NULL,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      UNIQUE (company_code, product_code)
    );
    INSERT INTO company_products VALUES
      ('C002','P001','ペン',150),
      ('C001','P002','ノート',300),
      ('C001','P001','ペン',120),
      ('C999','P001','対象外の商品',999);
  `);
  return db;
}

test("複合キーで同じ商品コードを会社ごとに区別し、並び順が違っても一致する", () => {
  const db = create();
  try {
    assert.deepEqual(compareCompanyProducts(db, expected, companies), []);
    assert.deepEqual(
      compareCompanyProductRows([...expected].reverse(), expected),
      [],
    );
    // 単一列でなく、2列の組み合わせがDBでもユニークになる。
    assert.throws(
      () =>
        db.exec("INSERT INTO company_products VALUES('C001','P001','重複',1)"),
      /UNIQUE constraint failed/,
    );
  } finally {
    db.close();
  }
});

test("複合キーの欠落・余剰・値違いと会社の誤りをSQL取得から検出する", () => {
  const key = companyProductKey(expected[0]);
  const mutations: [string, string][] = [
    [
      "DELETE FROM company_products WHERE company_code='C001' AND product_code='P001'",
      `product:missing:${key}`,
    ],
    [
      "INSERT INTO company_products VALUES('C001','P003','追加',50)",
      'product:extra:["C001","P003"]',
    ],
    [
      "UPDATE company_products SET price=999 WHERE company_code='C001' AND product_code='P001'",
      `product:value:${key}`,
    ],
    [
      "UPDATE company_products SET name='誤り' WHERE company_code='C001' AND product_code='P001'",
      `product:value:${key}`,
    ],
    [
      "UPDATE company_products SET company_code='C002' WHERE company_code='C001' AND product_code='P002'",
      'product:missing:["C001","P002"]',
    ],
  ];
  for (const [sql, difference] of mutations) {
    const db = create();
    try {
      db.exec(sql);
      assert.ok(
        compareCompanyProducts(db, expected, companies).includes(difference),
        difference,
      );
    } finally {
      db.close();
    }
  }
});

test("実データ・期待値の複合キー重複をMapへの上書き前に検出する", () => {
  // JOINの誤り等で取得結果が重複した場合も、照合器で見逃さない。
  const duplicate = [...expected, { ...expected[0] }];
  const key = companyProductKey(expected[0]);
  assert.ok(
    compareCompanyProductRows(duplicate, expected).includes(
      `actual:duplicate:${key}`,
    ),
  );
  assert.ok(
    compareCompanyProductRows(expected, duplicate).includes(
      `expected:duplicate:${key}`,
    ),
  );
});

test("コード内に区切り文字があっても異なる複合キーを混同しない", () => {
  const rows: CompanyProduct[] = [
    { company_code: "A:B", product_code: "C", name: "商品1", price: 100 },
    { company_code: "A", product_code: "B:C", name: "商品2", price: 200 },
  ];
  assert.notEqual(companyProductKey(rows[0]), companyProductKey(rows[1]));
  assert.deepEqual(compareCompanyProductRows([...rows].reverse(), rows), []);
});

test("会社指定の省略と対象外会社の期待値を拒否する", () => {
  const db = create();
  try {
    assert.throws(
      () => compareCompanyProducts(db, expected, []),
      /COMPANY_CODES_REQUIRED/,
    );
    assert.throws(
      () => compareCompanyProducts(db, expected, ["C001"]),
      /EXPECTED_COMPANY_OUTSIDE_TARGET/,
    );
  } finally {
    db.close();
  }
});
