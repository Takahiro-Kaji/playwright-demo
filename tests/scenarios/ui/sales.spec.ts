import { test, expect } from "@playwright/test";
import { settleAfter } from "../../../test-support/after.ts";
import { harness } from "../../targets/sales/harness.ts";

test("UI real learning HTTP success", async ({ page }) => {
  const h = await harness("upstream");
  try {
    await test.step("Given: F1を同期し画面を開く", async () => {
      expect(await h.batch()).toBe(0);
      await page.goto(h.app);
    });
    await test.step("When: 接続確認とP001の受注", async () => {
      await page.getByRole("button", { name: "外部接続確認" }).click();
      await expect(page.locator("#availability-result")).toHaveText("接続可能");
      await page.getByRole("button", { name: "商品表示" }).click();
      const response = page.waitForResponse((r) =>
        r.url().endsWith("/api/orders"),
      );
      await page.locator('[data-product-code="P001"]').click();
      expect((await response).status()).toBe(201);
    });
    await test.step("Then: 画面と受注・在庫を照合", async () => {
      await expect(page.locator("#result")).toHaveText("受注しました");
      expect(
        h.query("SELECT product_code,quantity,unit_price,status FROM orders"),
      ).toEqual([
        {
          product_code: "P001",
          quantity: 1,
          unit_price: 120,
          status: "CREATED",
        },
      ]);
      expect(
        h.query(
          "SELECT p.version,i.quantity FROM products p JOIN inventory i USING(product_code) WHERE p.product_code=?",
          "P001",
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
    await test.step("After: プロセス停止と専用DB削除", async () => {
      try {
        await h.cleanup();
      } catch (error) {
        throw new Error("After失敗", { cause: error });
      }
    });
  }
});

test("UI mock upstream unavailable", async ({ page }) => {
  const h = await harness("mock");
  let old: number | undefined;
  try {
    let before: unknown;
    await test.step("Given: F1とモック503", async () => {
      expect(await h.batch()).toBe(0);
      before = h.snapshot();
      old = await h.status();
      expect(await h.status(503)).toBe(503);
      expect((await fetch(h.upstream + "/catalog")).status).toBe(503);
    });
    await test.step("When: 外部接続を確認", async () => {
      await page.goto(h.app);
      const response = page.waitForResponse((r) =>
        r.url().endsWith("/api/availability"),
      );
      await page.getByRole("button", { name: "外部接続確認" }).click();
      expect((await response).status()).toBe(502);
    });
    await test.step("Then: エラー表示とDB不変", async () => {
      await expect(page.locator("#availability-result")).toHaveText(
        "外部システムエラー",
      );
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
