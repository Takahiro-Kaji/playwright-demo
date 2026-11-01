'use strict';
const { test, expect, request } = require('@playwright/test');
const fs = require('node:fs');
const url = process.env.SSO_UI_URL;
const state = process.env.SSO_STATE;
if (!url || !state) throw Error('SSO_UI_URL and SSO_STATE are required');
const target = new URL(url);
if (target.protocol !== 'https:' || target.pathname !== '/' || target.search || target.hash || target.username || target.password) throw Error('SSO_UI_URL must be an HTTPS origin ending in /');
if (!fs.existsSync(state)) throw Error('SSO state file is missing');

test('unauthenticated UI and API requests are not forwarded', async () => {
  const client = await request.newContext({ maxRedirects: 0 });
  try {
    for (const [path, method] of [['/', 'GET'], ['/api/items', 'POST']]) {
      const result = await client.fetch(new URL(path, target).href, { method, data: method === 'POST' ? {} : undefined });
      expect(result.status()).toBe(302);
      const location = result.headers().location || '';
      expect(new URL(location).pathname).toBe('/oauth2/authorize');
    }
  } finally { await client.dispose(); }
});

test.use({ storageState: state });
test('saved SSO state allows the UI and API in a new context', async ({ page }) => {
  // Do not submit a valid item or record response bodies or credentials.
  await page.goto(url);
  await expect(page).toHaveURL(url);
  await expect(page.getByTestId('item-create')).toBeVisible();
  const status = await page.evaluate(async () => (await fetch('/api/items', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', redirect: 'manual',
  })).status);
  expect(status).toBe(400);
});
