import { test, expect, request } from '@playwright/test';
import { awsSsoConfig } from '../../tests/aws-sales/config.ts';

// Given: 未認証。 When: UI を開く。 Then: Cognito へ。 After: context を閉じる。
test('未認証 UI は Cognito に遷移する', async ({ browser }) => {
  const c = awsSsoConfig(); const context = await browser.newContext();
  try {
    const page = await context.newPage(); await page.goto(c.target);
    await expect(page).toHaveURL(new RegExp(`^https://${c.cognitoDomain.replaceAll('.', '\\.')}\/`));
  } catch { throw Error("AWS_SSO_CHECK_FAILED"); } finally { await context.close(); }
});

// Given: 保存済み認証と商品。 When: 未認証で有効な受注を送る。 Then: redirect と商品不変。 After: 両 context を閉じる。
test('未認証受注は処理されず商品を変更しない', async () => {
  const c = awsSsoConfig();
  const auth = await request.newContext({ storageState: c.state });
  const anon = await request.newContext({ maxRedirects: 0 });
  try {
    const beforeResponse = await auth.get(new URL('/api/products', c.target).href);
    expect(beforeResponse.status()).toBe(200);
    const before = await beforeResponse.json(); const product = before.products.find((p: {quantity: number}) => p.quantity > 0);
    expect(product).toBeTruthy();
    const response = await anon.post(new URL('/api/orders', c.target).href, { data: { productCode: product.productCode, quantity: 1, version: product.version } });
    expect(response.status()).toBe(302);
    const location = new URL(response.headers().location);
    expect(location.protocol).toBe('https:'); expect(location.hostname).toBe(c.cognitoDomain); expect(location.pathname).toBe('/oauth2/authorize');
    const afterResponse = await auth.get(new URL('/api/products', c.target).href);
    expect(afterResponse.status()).toBe(200); expect(await afterResponse.json()).toEqual(before);
  } catch { throw Error("AWS_SSO_CHECK_FAILED"); } finally { await anon.dispose(); await auth.dispose(); }
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
