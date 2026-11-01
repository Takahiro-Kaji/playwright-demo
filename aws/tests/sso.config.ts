import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'sso.spec.ts', workers: 1, retries: 0,
  reporter: 'list', use: { browserName: 'chromium', channel: 'chrome', headless: true, trace: 'off', screenshot: 'off', video: 'off' } });
