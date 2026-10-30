'use strict';
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({ testDir: '.', testMatch: 'full-import.integration.spec.cjs', timeout: 180000, workers: 1, retries: 0, maxFailures: 1, outputDir: '../../../test-results/batch', reporter: [['list'], ['json', { outputFile: '../../../test-results/batch-report.json' }]] });
