'use strict';
const { test: base } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const test = base.extend({
  batchState: [async ({}, use, info) => {
    const state = { evidence: { scope: 'all rows in dedicated parents and children tables', input: null, batch: null, differences: null, checks: [], cleanup: 'unconfirmed', measurement: null }, db: null, work: null, batch: null };
    await use(state);
    const errors = [];
    let stopped = false;
    try { if (state.batch) await state.batch.stop(); stopped = true; } catch (e) { errors.push(e); }
    if (stopped) {
      try { if (state.db) await state.db.end(); } catch (e) { errors.push(e); }
      try { if (state.work) await fs.rm(state.work, { recursive: true, force: true }); } catch (e) { errors.push(e); }
    } else errors.push(new Error('Batch still running; DB and snapshot retained for recovery'));
    if (process.env.BATCH_VERIFY_CLEANUP === '1') errors.push(new Error('injected cleanup failure'));
    state.evidence.businessErrors = info.errors.map((e) => ({ message: e.message, stack: e.stack }));
    state.evidence.verdict = info.errors.length ? 'FAIL' : 'PASS';
    state.evidence.cleanup = errors.length ? 'failed' : 'completed';
    state.evidence.cleanupErrors = errors.map(String);
    state.evidence.batchStopped = stopped;
    let attachmentStatus = 'saved';
    try {
      if (process.env.BATCH_VERIFY_ATTACH === '1') throw new Error('injected attachment failure');
      await info.attach('batch-evidence.json', { body: JSON.stringify(state.evidence, null, 2), contentType: 'application/json' });
    } catch (e) { attachmentStatus = 'failed'; errors.push(e); }
    try {
      const files = ['demo/reference-sync/sync.cjs', 'tests/targets/demo-reference/target.cjs', 'tests/scenarios/batch/full-import.integration.spec.cjs', 'test-support/http-snapshot.cjs', 'test-support/batch-fixture.cjs', 'test-support/local-mysql.cjs', 'scripts/local-batch.cjs', 'mocks/reference-source/server.cjs'];
      const codeHashes = {};
      for (const file of files) codeHashes[file] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
      const e = state.evidence;
      const businessFailures = info.errors.map((error) => {
        const message = error.message || '';
        return { phase: e.phase || 'setup', kind: /timeout/i.test(message) ? 'timeout' : /Batch exited/i.test(message) ? 'batch-process' : /expect\(/i.test(message) ? 'assertion' : 'scenario-error' };
      });
      const summary = { runId: path.basename(process.env.BATCH_RUN_DIR), codeHashes, scope: e.scope, input: e.input, batch: e.batch, differences: e.differences, checks: e.checks, verdict: e.verdict, businessFailures, cleanup: e.cleanup, cleanupErrors: e.cleanupErrors.map(() => 'cleanup-error'), attachmentStatus, batchStopped: e.batchStopped, measurement: e.measurement, environmentCleanup: 'pending', runnerStatus: 'pending' };
      const file = path.join(process.env.BATCH_RUN_DIR, 'case-summary.json');
      await fs.writeFile(`${file}.partial`, JSON.stringify(summary, null, 2), { mode: 0o600 });
      await fs.rename(`${file}.partial`, file);
    } catch (e) { errors.push(e); }
    if (errors.length) throw new AggregateError(errors, 'Batch cleanup or evidence failed');
  }, { auto: true, timeout: 60000 }],
});
module.exports = { test };
