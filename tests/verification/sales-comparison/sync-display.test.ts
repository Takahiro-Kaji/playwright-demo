import { test } from "node:test";
import { strict as assert } from "node:assert";
import { syncDisplayMatches } from "../../targets/sales/sync-display.ts";
const dataset1 = [
  { productCode: "S0001", name: "商品1", price: 100, quantity: 5, version: 1 },
  { productCode: "S0002", name: "商品2", price: 101, quantity: 5, version: 1 },
];
const dataset2 = dataset1.map((row) => ({ ...row, quantity: 3, version: 2 }));
const text1 = ["商品1 100円 在庫5受注", "商品2 101円 在庫5受注"];
const text2 = ["商品1 100円 在庫3受注", "商品2 101円 在庫3受注"];
const choices = [
  { rows: dataset1, texts: text1 },
  { rows: dataset2, texts: text2 },
];
test("同期中の全表示検証器は混在、誤表示、500、例外、操作不能を検出", () => {
  const check = (
    rows: unknown = dataset1,
    t: string[] = text1,
    e: boolean[] = [true, true, true],
    status = 200,
    errors: string[] = [],
    http: number[] = [],
  ) => syncDisplayMatches(rows, t, e, status, errors, http, choices);
  assert.equal(check(), true);
  assert.equal(check(dataset2, text2), true);
  assert.equal(check([dataset2[0], dataset1[1]]), false);
  assert.equal(check(dataset1, [text1[0], "誤表示"]), false);
  assert.equal(check(dataset1, text1, [true, false, true]), false);
  assert.equal(check(dataset1, text1, [true, true, true], 500), false);
  assert.equal(
    check(dataset1, text1, [true, true, true], 200, ["page error"]),
    false,
  );
  assert.equal(check(dataset1, text1, [true, true, true], 200, [], [500]), false);
});
