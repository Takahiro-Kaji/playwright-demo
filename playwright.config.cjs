'use strict';
require('dotenv').config();
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.integration.spec.cjs',
  testIgnore: ['**/scenarios/batch/**', '**/scenarios/cross-feature/**'],
  timeout: 240_000,
  expect: { timeout: 15_000 },
  workers: 1,
  maxFailures: 1, // Stop before any later case can adopt a failed cleanup state.
  retries: 0, // Do not duplicate UI data creation on a failed test.
  forbidOnly: Boolean(process.env.CI),
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    baseURL: process.env.BASE_URL,
    browserName: 'chromium',
    channel: 'chrome', // Real installed Google Chrome; not bundled Chromium.
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
});
