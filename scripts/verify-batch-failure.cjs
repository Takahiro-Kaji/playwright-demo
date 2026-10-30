'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
for (const mode of ['cleanup', 'timeout']) {
  const env = { ...process.env, BATCH_SIZE: '2', ...(mode === 'cleanup' ? { BATCH_VERIFY_CLEANUP: '1' } : { BATCH_VERIFY_TIMEOUT: '1' }) };
  const result = spawnSync(process.execPath, ['scripts/local-batch.cjs'], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8', timeout: 180000 });
  assert.equal(result.status, 1, `${mode}: runner must exit nonzero`);
  const report = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-results/batch-report.json')));
  const entry = report.suites[0].specs[0].tests[0].results[0];
  const item = entry.attachments.find((a) => a.name === 'batch-evidence.json');
  const evidence = JSON.parse(Buffer.from(item.body, 'base64'));
  assert.equal(evidence.batchStopped, true);
  if (mode === 'cleanup') {
    assert.match(evidence.businessErrors[0].message, /injected business failure/);
    assert.match(evidence.cleanupErrors[0], /injected cleanup failure/);
    assert.equal(evidence.cleanup, 'failed');
  } else {
    assert.match(evidence.businessErrors[0].message, /timeout/i);
    assert.equal(evidence.cleanup, 'completed');
  }
  console.log(`${mode}: original failure, process stop and cleanup evidence verified`);
}
