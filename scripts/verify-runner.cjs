'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-right-verify-'));
try {
  for (const mode of ['precondition', 'timeout', 'cleanup', 'combined']) {
    const sentinel = path.join(dir, `${mode}-sentinel`), attempts = path.join(dir, `${mode}-attempts`);
    const result = spawnSync(path.join(__dirname, '../node_modules/.bin/playwright'), ['test', '-c', 'tests/verification/playwright.config.cjs'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, VERIFY_FAILURE: mode, VERIFY_SENTINEL: sentinel, VERIFY_ATTEMPTS: attempts } });
    assert.equal(result.status, 1, `${mode}: runner must fail: ${result.stderr}`);
    assert.equal(fs.existsSync(sentinel), false, `${mode}: later test ran`);
    assert.deepEqual(fs.readFileSync(attempts, 'utf8').trim().split('\n').sort(), ['a', 'b']);
    const report = JSON.parse(result.stdout);
    const resultEntry = report.suites[0].specs[0].tests[0].results[0];
    const attachment = resultEntry.attachments.find((item) => item.name === 'case-evidence.json');
    assert.ok(attachment, `${mode}: evidence missing`);
    const evidence = JSON.parse(attachment.body ? Buffer.from(attachment.body, 'base64') : fs.readFileSync(attachment.path));
    assert.equal(evidence.restoration.length, 2, `${mode}: both restoration outcomes required`);
    if (mode !== 'cleanup') assert.ok(evidence.businessErrors.length, `${mode}: original failure missing`);
    if (mode === 'cleanup' || mode === 'combined') assert.equal(evidence.cleanupErrors.length, 2);
    console.log(`${mode}: failure, both cleanup attempts, evidence and sentinel stop verified`);
  }
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
