/** 画面から実HTTP正常・モック障害を確かめるテスト。各testをGiven→When→Then→Afterの順に読む。 */
import { test, expect } from "../../../test-support/auth/fixture.ts";
import { settleAfter } from "../../../test-support/after.ts";
import { harness } from "../../targets/sales/harness.ts";

// 各testのasync関数はPromiseを返し、awaitはその結果または失敗を待つ。
// { page }はPlaywrightがケースごとに用意するページfixtureを受け取る書き方。
// test.stepは処理をレポート上で区切る。Given→When→Then→Afterの流れを追える。
// 通常値のexpectはその時点の値を比較し、locatorへのexpectは条件成立まで再試行する。
// locatorのclickは操作可能な状態を自動待機するが、任意の処理がすべて完了する保証ではない。
// annotationは業務判定や後片付けの状態をレポーターに渡して集計するために付ける。
// UI-01: 契約のF1ではP001は単価120、在庫5、version 1。数量1の受注後は在庫4、version 2。
test("UI real learning HTTP success", async ({ page }) => {
  const h = await harness("upstream");
  let orderId: string;
  let ordersBefore: ReturnType<typeof h.query>;
  try {
    await test.step("Given: F1を同期し画面を開く", async () => {
      expect(await h.batch()).toBe(0);
      await page.goto(h.app);
    });
    await test.step("When: 接続確認とP001の受注", async () => {
      await page.getByRole("button", { name: "外部接続確認" }).click();
      await expect(page.locator("#availability-result")).toHaveText("接続可能");
      await page.getByRole("button", { name: "商品表示" }).click();
      // 既存の受注を含め、クリック直前の全レコードを保存する。
      ordersBefore = h.query("SELECT * FROM orders ORDER BY order_id");
      // 応答がクリック直後に届いても取り逃さないよう、待機Promiseを先に登録する。
      const response = page.waitForResponse((r) =>
        r.url().endsWith("/api/orders"),
      );
      await page.locator(`[data-product-code="${h.code("P001")}"]`).click();
      const result = await response;
      expect(result.status()).toBe(201);
      orderId = (await result.json()).orderId;
      expect(orderId).toEqual(expect.any(String));
    });
    await test.step("Then: 画面と受注・在庫を照合", async () => {
      await expect(page.locator("#result")).toHaveText("受注しました");
      expect(
        h.query(
          "SELECT product_code,quantity,unit_price,status FROM orders WHERE order_id=?",
          orderId,
        ),
      ).toEqual([
        {
          product_code: h.code("P001"),
          quantity: 1,
          unit_price: 120,
          status: "CREATED",
        },
      ]);
      const ordersAfter = h.query("SELECT * FROM orders ORDER BY order_id");
      const beforeIds = new Set(ordersBefore.map((row) => row.order_id));
      const addedOrders = ordersAfter.filter(
        (row) => !beforeIds.has(row.order_id),
      );
      // 全体で1件増え、追加されたIDが今回の受注IDと一致する。
      expect(ordersAfter).toHaveLength(ordersBefore.length + 1);
      expect(addedOrders.map((row) => row.order_id)).toEqual([orderId]);
      // 元からあった受注は、削除・更新されていない。
      expect(ordersAfter.filter((row) => beforeIds.has(row.order_id))).toEqual(
        ordersBefore,
      );
      expect(
        h.query(
          "SELECT p.version,i.quantity FROM products p JOIN inventory i USING(product_code) WHERE p.product_code=?",
          h.code("P001"),
        ),
      ).toEqual([{ version: 2, quantity: 4 }]);
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
    await test.step("After: プロセス停止と今回のデータだけ削除", async () => {
      try {
        await h.cleanup();
      } catch (error) {
        throw new Error("After失敗", { cause: error });
      }
    });
  }
});

// UI-02: 商品表示後に外部IFを500・502・503にし、各値で受注失敗の画面とDB不変を調べる。
// 値ごとに独立したtestを登録し、準備から後片付けまで実行する。
for (const status of [500, 502, 503]) {
  test(`UI mock upstream unavailable (${status})`, async ({ page }) => {
    const h = await harness("mock");
    let old: number | undefined;
    try {
      let before: unknown;
      await test.step(`Given: F1の商品表示とモック${status}`, async () => {
        expect(await h.batch()).toBe(0);
        await page.goto(h.app);
        await page.getByRole("button", { name: "商品表示" }).click();
        await expect(
          page.locator(`[data-product-code="${h.code("P001")}"]`),
        ).toBeVisible();
        // snapshotはWhen前の実状態。固定期待値とは異なり、変更されなかったかの比較に使う。
        before = h.snapshot();
        old = await h.status();
        expect(await h.status(status)).toBe(status);
        expect((await fetch(h.upstream + "/catalog")).status).toBe(status);
      });
      await test.step("When: 外部IF障害中にP001を受注", async () => {
        const response = page.waitForResponse((r) =>
          r.url().endsWith("/api/orders"),
        );
        await page.locator(`[data-product-code="${h.code("P001")}"]`).click();
        const result = await response;
        expect(result.status()).toBe(502);
        expect(await result.json()).toEqual({ error: "UPSTREAM_UNAVAILABLE" });
      });
      await test.step("Then: エラー表示と受注・在庫・version不変", async () => {
        await expect(page.locator("#result")).toHaveText("外部システムエラー");
        expect(h.snapshot()).toEqual(before);
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
      await test.step("After: 設定を復元しプロセスを回収", async () => {
        // finallyは本体失敗時も実行。復元失敗後も停止を試し、問題があればDBを保持する。
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
