'use strict';
const { expect } = require('@playwright/test');
async function createItem(page, base, key) {
  await page.goto(`${base}/items/new`);
  await page.getByTestId('item-test-key').fill(key);
  const pending = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/items' && r.request().method() === 'POST' && r.request().postDataJSON()?.testKey === key);
  await page.getByTestId('item-create').click();
  return pending;
}
async function assertFeedback(page, expected, evidence) {
  const feedback = page.getByTestId('item-create-result');
  await expect(feedback, 'Expected UI feedback must be visible').toBeVisible();
  // Record observed attributes before assertions, including when the UI differs.
  evidence.actual = { text: await feedback.innerText(), role: await feedback.getAttribute('role'), state: await feedback.getAttribute('data-state'), live: await feedback.getAttribute('aria-live') };
  await expect(feedback, 'Wrong user-visible message').toHaveText(expected.text);
  await expect(feedback, 'Wrong accessibility role').toHaveAttribute('role', expected.role);
  await expect(feedback, 'Wrong UI state').toHaveAttribute('data-state', expected.state);
  await expect(feedback, 'Wrong live-region priority').toHaveAttribute('aria-live', expected.live);
}
module.exports = { createItem, assertFeedback };
