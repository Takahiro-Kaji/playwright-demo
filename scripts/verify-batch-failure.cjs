'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
for (const mode of ['cleanup', 'timeout', 'attachment']) {
  const flag = { cleanup: 'BATCH_VERIFY_CLEANUP', timeout: 'BATCH_VERIFY_TIMEOUT', attachment: 'BATCH_VERIFY_ATTACH' }[mode];
  const env = { ...process.env, BATCH_SIZE: '2', [flag]: '1' };
  const result = spawnSync(process.execPath, ['scripts/local-batch.cjs'], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8', timeout: 180000 });
  assert.equal(result.status, 1, `${mode}: runner must exit nonzero`);
  const match = result.stdout.match(/Batch summary: (.+\/case-summary\.json)/);
  assert.ok(match, `${mode}: persistent summary missing`);
  const summary = JSON.parse(fs.readFileSync(match[1]));
  assert.equal(summary.runnerStatus, 'failed');
  assert.equal(summary.environmentCleanup, 'completed');
  assert.equal(summary.batchStopped, true);
  if (mode === 'cleanup') {
    assert.equal(summary.businessFailures[0].kind, 'scenario-error');
    assert.equal(summary.cleanup, 'failed');
  } else if (mode === 'timeout') {
    assert.equal(summary.businessFailures[0].kind, 'timeout');
    assert.equal(summary.businessFailures[0].phase, 'when');
    assert.equal(summary.cleanup, 'completed');
  } else {
    assert.equal(summary.verdict, 'PASS');
    assert.equal(summary.attachmentStatus, 'failed');
  }
  console.log(`${mode}: persistent failure classification, process stop and nonzero exit verified`);
}
