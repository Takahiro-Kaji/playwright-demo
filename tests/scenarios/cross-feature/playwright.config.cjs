'use strict';
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({ testDir: '.', testMatch: 'read-during-sync.integration.spec.cjs', timeout: 180000, workers: 1, retries: 0, maxFailures: 1, outputDir: '../../../test-results/cross', reporter: [['list'], ['json', { outputFile: '../../../test-results/cross-report.json' }]], use: { browserName: 'chromium', channel: 'chrome', headless: true } });
