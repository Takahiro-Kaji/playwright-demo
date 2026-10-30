'use strict';
const fs = require('node:fs');
const { test } = require('../../test-support/case-fixture.cjs');
const mode = process.env.VERIFY_FAILURE;
test('injected failure', async ({ caseState }) => {
  test.setTimeout(500);
  for (const key of ['a', 'b']) {
    const target = { key, region: key };
    caseState.changes.push({ target, original: { region: key, status: 200, version: 0, instanceId: key }, configured: { region: key, status: 503, version: 1, instanceId: key } });
  }
  caseState.compareAndSet = async (target, status) => {
    fs.appendFileSync(process.env.VERIFY_ATTEMPTS, `${target.key}\n`);
    if ((mode === 'cleanup' || mode === 'combined')) throw new Error('injected cleanup failure');
    return { region: target.key, status, version: 2, instanceId: target.key };
  };
  caseState.probe = async () => ({ status: 200 });
  if ((mode === 'precondition' || mode === 'combined')) throw new Error('injected precondition failure');
  if (mode === 'timeout') await new Promise((resolve) => setTimeout(resolve, 5000));
});
test('sentinel must never run', async () => { fs.writeFileSync(process.env.VERIFY_SENTINEL, 'executed'); });
