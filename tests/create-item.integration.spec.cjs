'use strict';
const { test, expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');
const { assertDeploymentReady, required } = require('../helpers/kubernetes.cjs');
const { countCreatedItems } = require('../helpers/mysql.cjs');

function assertTestEnvironment() {
  const env = required('TEST_ENV').toLowerCase();
  if (!['local', 'dev', 'test', 'staging'].includes(env)) {
    throw new Error('Only local/dev/test/staging environments are allowed by this template. Production testing is disabled.');
  }
  const url = new URL(required('BASE_URL'));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('BASE_URL must use http or https');
  // This guard is not proof that a target is non-production; confirm the URL,
  // cluster context and database endpoint before running the script.
}

test('UI作成 → Kubernetes状態 → 外部DB保存を検証', async ({ page }, testInfo) => {
  assertTestEnvironment();
  const testKey = `it-${randomUUID()}`;
  await testInfo.attach('test-key.txt', { body: testKey, contentType: 'text/plain' });

  await test.step('1. Kubernetes Deployment の正常稼働を確認', async () => {
    const app = await assertDeploymentReady();
    const mock = await assertDeploymentReady(process.env.MOCK_DEPLOYMENT || 'status-mock');
    await testInfo.attach('deployment-summary.json', {
      body: JSON.stringify({ app, mock }, null, 2),
      contentType: 'application/json',
    });
  });

  await test.step('2. Playwright でテストデータを登録', async () => {
    // EXAMPLE UI ONLY: update the path and data-testid values for your application.
    await page.goto('/items/new');
    await page.getByTestId('item-test-key').fill(testKey);
    await page.getByTestId('item-create').click();
    await expect(page.getByTestId('item-create-result')).toContainText('作成しました');
  });

  await test.step('3. mysql CLI で永続化されたレコードを検証', async () => {
    // Poll for async data propagation, without arbitrary fixed sleeps.
    await expect.poll(
      () => countCreatedItems(testKey),
      {
        message: `Expected exactly one CREATED record for test data ${testKey}`,
        intervals: [500, 1_000, 2_000],
        timeout: 20_000,
      },
    ).toBe(1);
  });
});


test('モックが503を返したらUIは失敗し、MySQLに登録されない', async ({ page }) => {
  assertTestEnvironment();
  const testKey = `it-${randomUUID()}`;
  await assertDeploymentReady(process.env.MOCK_DEPLOYMENT || 'status-mock');
  await page.goto('/items/new');
  await page.getByTestId('item-test-key').fill(testKey);
  await page.getByTestId('mock-status').selectOption('503');
  await page.getByTestId('item-create').click();
  await expect(page.getByTestId('item-create-result')).toContainText('外部システムエラー');
  await expect.poll(() => countCreatedItems(testKey), {
    message: `Mock 503 must prevent DB writes for ${testKey}`,
    intervals: [250, 500, 1_000], timeout: 5_000,
  }).toBe(0);
});
