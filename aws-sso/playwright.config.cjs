'use strict';
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.cjs',
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: { channel: 'chrome', headless: true, trace: 'off', screenshot: 'off', video: 'off' },
});
