/** 同期バッチの全件照合と上流障害を確かめる2ケース。上流応答との比較、各test、Afterの順に読む。 */
import { test, expect } from "@playwright/test";
import { upstreamErrorStatuses } from "../../../test-support/cases.ts";
import { settleAfter } from "../../../test-support/after.ts";
import { harness } from "../../targets/sales/harness.ts";
import { compareCatalog } from "../../targets/sales/compare.ts";
import { DatabaseSync } from "node:sqlite";
import type { Catalog } from "../../../demo/sales/db.ts";

// asyncはPromiseを返し、awaitは完了した結果を受け取る。失敗した場合は例外になる。
// test.stepはレポートの区切り。通常値のexpectはその時点で比較し、annotationは判定集計に使う。
// BATCH-01: 件数・商品値は事前に決めず、実HTTPで取得した上流データとDB全件を照合する。
// IFはCatalog契約どおりで、取得からバッチ完了まで上流データが変わらない前提。
test("同期バッチの結果が取得した上流データ全件と一致する", async () => {
  const h = await harness("upstream");
  try {
    const catalog =
      await test.step("Given: 上流データを実HTTPで取得", async () => {
        const upstream = await fetch(h.upstream + "/catalog");
        expect(upstream.status).toBe(200);
        return (await upstream.json()) as Catalog;
      });
    await test.step("When: 同期バッチを実行", async () => {
      expect(await h.batch()).toBe(0);
    });
    await test.step("Then: SQL取得から上流データ全件と照合", async () => {
      const db = new DatabaseSync(h.db);
      try {
        expect(
          compareCatalog(
            db,
            {
              // 新規スコープへの初回同期なので、商品versionはすべて1。
              products: catalog.products.map((p) => ({ ...p, version: 1 })),
              deleted: [],
              catalogVersion: catalog.catalogVersion,
              orders: [],
            },
            h.scope,
          ),
        ).toEqual([]);
      } finally {
        db.close();
      }
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

// BATCH-02: 500・502・503ごとに準備・実行・不変確認・復元を独立して行う。
for (const status of upstreamErrorStatuses) {
  test(`外部IF障害時は同期に失敗し対象データが変わらない (${status})`, async () => {
    const h = await harness("mock");
    let old: number | undefined;
    let before: unknown;
    try {
      await test.step(`Given: データセット1と${status}応答`, async () => {
        expect(await h.batch()).toBe(0);
        // これは不変比較の事前スナップショットであり、データセット1の固定期待値の代わりではない。
        before = h.snapshot({ kind: "sync" });
        old = await h.status();
        expect(await h.status(status)).toBe(status);
        expect((await fetch(h.upstream + "/catalog")).status).toBe(status);
      });
      await test.step("When: 同期を実行", async () => {
        expect(await h.batch()).not.toBe(0);
      });
      await test.step("Then: 対象データが不変", async () => {
        expect(h.snapshot({ kind: "sync" })).toEqual(before);
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
}
