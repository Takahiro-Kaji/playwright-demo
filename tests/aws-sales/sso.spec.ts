import { test as anonymous, expect, request } from '@playwright/test';
import { test as authenticated } from '../../test-support/auth/fixture.ts';
import { awsSsoConfig } from './config.ts';

anonymous('未認証UIと受注APIはCognitoにリダイレクトされる', async () => {
  const config = awsSsoConfig();
  const client = await request.newContext({maxRedirects:0});
  try {
    for (const [path,method] of [['/','GET'],['/api/orders','POST']] as const) {
      const response=await client.fetch(new URL(path,config.target).href,{method,...(method==='POST'?{data:{}}:{})});
      let matches=false;
      try { const location=new URL(response.headers().location || ''); matches=location.protocol==='https:' && location.hostname===config.cognitoDomain && location.pathname==='/oauth2/authorize'; } catch {}
      expect(response.status()).toBe(302);
      expect(matches).toBe(true);
    }
  } finally { await client.dispose(); }
});
authenticated.beforeAll(() => { awsSsoConfig(); });
authenticated('保存した認証で販売管理画面と受注APIを利用できる', async ({page}) => {
  const config=awsSsoConfig();
  try {
    await page.goto(config.target);
    await expect(page).toHaveURL(config.expected);
    await page.locator('#refresh').click();
    await expect(page.locator('#products')).toContainText('ペン');
    const status=await page.evaluate(async () => (await fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:'{}',redirect:'manual'})).status);
    expect(status).toBe(400);
  } catch { throw Error('AWS_SALES_SSO_CHECK_FAILED'); }
});
