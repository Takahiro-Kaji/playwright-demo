'use strict';
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({ testDir: '.', testMatch: 'runner.spec.cjs', outputDir: '../../test-results/verification', workers: 1, retries: 0, maxFailures: 1, reporter: [['json']], timeout: 1000 });
