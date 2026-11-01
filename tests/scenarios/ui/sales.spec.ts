import { test, expect } from '@playwright/test';
import { harness } from '../../targets/sales/harness.ts';

test('UI real learning HTTP success', async ({ page }) => {
  const h = await harness('upstream');
  try {
    await test.step('Given: F1を同期し画面を開く', async () => {
      expect(await h.batch()).toBe(0);
      await page.goto(h.app);
    });
    await test.step('When: 接続確認とP001の受注', async () => {
      await page.locator('#availability').click();
      await expect(page.locator('#availability-result')).toHaveText('接続可能');
      await page.locator('#refresh').click();
      await page.locator('[data-product-code="P001"]').click();
    });
    await test.step('Then: 画面と受注・在庫を照合', async () => {
      await expect(page.locator('#result')).toHaveText('受注しました');
      expect(h.query('SELECT product_code,quantity,unit_price,status FROM orders')).toEqual([{product_code:'P001',quantity:1,unit_price:120,status:'CREATED'}]);
      expect(h.query('SELECT p.version,i.quantity FROM products p JOIN inventory i USING(product_code) WHERE p.product_code=?','P001')).toEqual([{version:2,quantity:4}]);
    });
  } finally {
    await test.step('After: プロセス停止と専用DB削除', async () => { await h.cleanup(); });
  }
});

test('UI mock upstream unavailable', async ({ page }) => {
  const h = await harness('mock');
  let old: number | undefined;
  try {
    let before: unknown;
    await test.step('Given: F1とモック503', async () => {
      expect(await h.batch()).toBe(0);
      before = h.query('SELECT * FROM inventory ORDER BY product_code');
      old = await h.status();
      expect(await h.status(503)).toBe(503);
      expect((await fetch(h.upstream+'/catalog')).status).toBe(503);
    });
    await test.step('When: 外部接続を確認', async () => {
      await page.goto(h.app);
      const response = page.waitForResponse(r => r.url().endsWith('/api/availability'));
      await page.locator('#availability').click();
      expect((await response).status()).toBe(502);
    });
    await test.step('Then: エラー表示とDB不変', async () => {
      await expect(page.locator('#availability-result')).toHaveText('外部システムエラー');
      expect(h.query('SELECT * FROM inventory ORDER BY product_code')).toEqual(before);
      expect(h.query('SELECT * FROM orders')).toEqual([]);
    });
  } finally {
    await test.step('After: 設定を復元しプロセスを回収', async () => {
      const errors: unknown[] = [];
      if (old !== undefined) try {
        expect(await h.status(old)).toBe(old);
        expect((await fetch(h.upstream+'/catalog')).status).toBe(old);
      } catch (error) { errors.push(error); }
      try { await h.cleanup(errors.length > 0); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'AFTER_FAILED');
    });
  }
});
