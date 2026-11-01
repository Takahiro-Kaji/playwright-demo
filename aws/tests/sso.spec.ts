import { test, expect, request } from '@playwright/test';
import { awsSsoConfig } from '../../tests/aws-sales/config.ts';
import { openProbeDatabase, probeOrder } from './order-probe.ts';

// Given: 未認証。 When: UI を開く。 Then: Cognito へ。 After: context を閉じる。
test('未認証 UI は Cognito に遷移する', async ({ browser }) => {
  const c = awsSsoConfig(); const context = await browser.newContext();
  try {
    const page = await context.newPage(); await page.goto(c.target);
    await expect(page).toHaveURL(new RegExp(`^https://${c.cognitoDomain.replaceAll('.', '\\.')}\/`));
  } catch { throw Error("AWS_SSO_CHECK_FAILED"); } finally { await context.close(); }
});

// Given: 専用 DB 行。 When: 未認証受注。 Then: Cognito へ。 After: DB を復元し全行を比較。
test('未認証受注は処理されず DB を復元する', async () => {
  test.setTimeout(300_000);
  const c = awsSsoConfig();
  const anon = await request.newContext({ maxRedirects: 0 });
  let db: Awaited<ReturnType<typeof openProbeDatabase>> | undefined;
  try {
    try { db = await openProbeDatabase(); } catch { throw Error("PROBE_DB_CONNECTION_FAILED"); }
    await probeOrder(db, async code => {
      const response = await anon.post(new URL('/api/orders', c.target).href, { timeout: 15_000, data: { productCode: code, quantity: 1, version: 1 } });
      if (response.status() !== 302) throw Error('UNEXPECTED_STATUS');
      const location = new URL(response.headers().location);
      if (location.protocol !== 'https:' || location.hostname !== c.cognitoDomain || location.pathname !== '/oauth2/authorize') throw Error('UNEXPECTED_REDIRECT');
    });
  } finally { await anon.dispose(); if (db) await db.end(); }
});

// Given: 保存済み認証。 When: 新 context で画面と API を利用。 Then: 商品表示。 After: context を閉じる。
test('保存済み状態で画面と商品 API を利用する', async ({ browser }) => {
  const c = awsSsoConfig(); const context = await browser.newContext({ storageState: c.state });
  try {
    const page = await context.newPage(); await page.goto(c.target); await expect(page).toHaveURL(c.expected);
    await page.locator('#refresh').click(); await expect(page.locator('#products')).not.toBeEmpty();
    expect(await page.evaluate(async () => (await fetch('/api/products')).status)).toBe(200);
  } catch { throw Error("AWS_SSO_CHECK_FAILED"); } finally { await context.close(); }
});
