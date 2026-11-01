import { test } from "node:test";
import { strict as assert } from "node:assert";
import { hasObservedOverlap } from "../../targets/sales/overlap.ts";
const attempt = {
  start: 10,
  response: 20,
  display: 30,
  status: 200,
  valid: true,
};
const first = { start: 11, end: 12, version: 1 },
  last = { start: 16, end: 17, version: 2 };
test("重なり判定は同一の正常な参照期間内の前後観測だけを採用", () => {
  assert.equal(hasObservedOverlap([attempt], [first, last]), true);
  assert.equal(
    hasObservedOverlap([attempt], [{ ...first, start: 9 }, last]),
    false,
  );
  assert.equal(
    hasObservedOverlap([attempt], [first, { ...last, start: 22, end: 23 }]),
    false,
  );
  assert.equal(
    hasObservedOverlap([{ ...attempt, start: null }], [first, last]),
    false,
  );
  assert.equal(
    hasObservedOverlap([{ ...attempt, valid: false }], [first, last]),
    false,
  );
  assert.equal(hasObservedOverlap([attempt], [last, first]), false);
  assert.equal(
    hasObservedOverlap([{ ...attempt, display: 15 }], [first, last]),
    false,
  );
});
