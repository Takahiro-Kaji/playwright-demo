/** 同期バッチの全件照合と上流障害を確かめる2ケース。固定期待値、各test、Afterの順に読む。 */
import { test, expect } from "@playwright/test";
import { settleAfter } from "../../../test-support/after.ts";
import { harness } from "../../targets/sales/harness.ts";
import { compareCatalog } from "../../targets/sales/compare.ts";
import { DatabaseSync } from "node:sqlite";

// asyncはPromiseを返し、awaitは完了した結果を受け取る。失敗した場合は例外になる。
// test.stepはレポートの区切り。通常値のexpectはその時点で比較し、annotationは判定集計に使う。
// F1の正解は実行前に固定する。取得した応答をそのまま正解にはしない。
const expected = [
  { productCode: "P001", name: "ペン", price: 120, active: true, quantity: 5 },
  {
    productCode: "P002",
    name: "ノート",
    price: 300,
    active: true,
    quantity: 2,
  },
];
// BATCH-01: 終了コードだけでなく、商品・在庫・関連など全体を固定期待と照合する。
test("batch real learning HTTP matches all rows", async () => {
  const h = await harness("upstream");
  try {
    await test.step("Given: 上流fixtureを実HTTPで確認", async () => {
      const upstream = await fetch(h.upstream + "/catalog");
      expect(upstream.status).toBe(200);
      expect((await upstream.json()).products).toEqual(
        h.scopedCatalog({ catalogVersion: 1, products: expected }).products,
      );
    });
    await test.step("When: 同期バッチを実行", async () => {
      expect(await h.batch()).toBe(0);
    });
    await test.step("Then: SQL取得から全件照合", async () => {
      const db = new DatabaseSync(h.db);
      try {
        expect(
          compareCatalog(
            db,
            {
              products: h
                .scopedCatalog({ catalogVersion: 1, products: expected })
                .products.map((p) => ({ ...p, version: 1 })),
              deleted: [],
              catalogVersion: 1,
              orders: [],
            },
            h.scope,
          ),
        ).toEqual([]);
      } finally {
        db.close();
      }
      expect(
        h.query(
          "SELECT * FROM inventory WHERE product_code GLOB ?",
          h.scope + "*",
        ),
      ).toHaveLength(2);
    });
    test
      .info()
      .annotations.push({ type: "case-status", description: "passed" });
  } catch (error) {
    if (test.info().expectedStatus !== "skipped")
      test
        .info()
        .annotations.push({ type: "case-status", description: "failed" });
    throw error;
  } finally {
    await test.step("After: プロセス回収", async () => {
      try {
        await h.cleanup();
      } catch (error) {
        throw new Error("After失敗", { cause: error });
      }
    });
  }
});

// BATCH-02: モックを503にし、実GETで障害を確認してから失敗と全表不変を調べる。
test("batch mock failure leaves all state unchanged", async () => {
  const h = await harness("mock");
  let old: number | undefined;
  let before: unknown, stock: unknown, state: unknown;
  try {
    await test.step("Given: F1と503応答", async () => {
      expect(await h.batch()).toBe(0);
      // これは不変比較の事前スナップショットであり、F1の固定期待値の代わりではない。
      before = h.query(
        "SELECT * FROM products WHERE product_code GLOB ? ORDER BY product_code",
        h.scope + "*",
      );
      stock = h.query(
        "SELECT * FROM inventory WHERE product_code GLOB ? ORDER BY product_code",
        h.scope + "*",
      );
      state = h.query("SELECT * FROM sales_sync_scopes WHERE scope=?", h.scope);
      old = await h.status();
      expect(await h.status(503)).toBe(503);
      expect((await fetch(h.upstream + "/catalog")).status).toBe(503);
    });
    await test.step("When: 同期を実行", async () => {
      expect(await h.batch()).not.toBe(0);
    });
    await test.step("Then: 対象データが不変", async () => {
      expect(
        h.query(
          "SELECT * FROM products WHERE product_code GLOB ? ORDER BY product_code",
          h.scope + "*",
        ),
      ).toEqual(before);
      expect(
        h.query(
          "SELECT * FROM inventory WHERE product_code GLOB ? ORDER BY product_code",
          h.scope + "*",
        ),
      ).toEqual(stock);
      expect(
        h.query("SELECT * FROM sales_sync_scopes WHERE scope=?", h.scope),
      ).toEqual(state);
      expect(
        h.query(
          "SELECT * FROM orders WHERE product_code GLOB ?",
          h.scope + "*",
        ),
      ).toEqual([]);
    });
    test
      .info()
      .annotations.push({ type: "case-status", description: "passed" });
  } catch (error) {
    if (test.info().expectedStatus !== "skipped")
      test
        .info()
        .annotations.push({ type: "case-status", description: "failed" });
    throw error;
  } finally {
    await test.step("After: モック復元とプロセス回収", async () => {
      const errors = await settleAfter([
        async () => {
          if (old !== undefined) {
            expect(await h.status(old)).toBe(old);
            expect((await fetch(h.upstream + "/catalog")).status).toBe(old);
          }
        },
        async (prior) => {
          await h.cleanup(prior.length > 0);
        },
      ]);
      if (errors.length) throw new AggregateError(errors, "After失敗");
    });
  }
});
