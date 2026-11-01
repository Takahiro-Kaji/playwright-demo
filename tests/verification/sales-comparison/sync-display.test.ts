import { test } from "node:test";
import { strict as assert } from "node:assert";
import { syncDisplayMatches } from "../../targets/sales/sync-display.ts";
const f1 = [
  { productCode: "P001", name: "ペン", price: 120, quantity: 5, version: 1 },
  { productCode: "P002", name: "ノート", price: 300, quantity: 2, version: 1 },
];
const texts = ["ペン 120円 在庫5受注", "ノート 300円 在庫2受注"];
test("同期中の表示検証器は混在、誤表示、500、例外、操作不能を検出", () => {
  const check = (
    rows: unknown = f1,
    t: string[] = texts,
    e: boolean[] = [true, true, true],
    status = 200,
    errors: string[] = [],
    http: number[] = [],
  ) => syncDisplayMatches(rows, t, e, status, errors, http);
  assert.equal(check(), true);
  assert.equal(check([{ ...f1[0], quantity: 3 }, f1[1]]), false);
  assert.equal(check(f1, [texts[0], "誤ったP002"]), false);
  assert.equal(check(f1, texts, [true, false, true]), false);
  assert.equal(check(f1, texts, [true, true, true], 500), false);
  assert.equal(
    check(f1, texts, [true, true, true], 200, ["page error"]),
    false,
  );
  assert.equal(check(f1, texts, [true, true, true], 200, [], [500]), false);
});
