'use strict';
const { test: base } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const test = base.extend({
  crossState: [async ({}, use, info) => {
    const state = { db: null, batch: null, work: null, evidence: { scope: 'dedicated demo parent count and full parent/child tables', ui: 'unconfirmed', overlap: 'unconfirmed', attempts: [], finalComparison: 'unconfirmed', finalUi: 'unconfirmed', batch: 'unconfirmed', cleanup: 'unconfirmed', mockRestoration: 'not-required' } };
    await use(state);
    const errors = []; let stopped = false;
    try { if (state.batch) await state.batch.stop(); stopped = true; } catch (e) { errors.push(e); }
    if (stopped) {
      try { if (state.db) await state.db.end(); } catch (e) { errors.push(e); }
      try { if (state.work) await fs.rm(state.work, { recursive: true, force: true }); } catch (e) { errors.push(e); }
    } else errors.push(new Error('Batch not stopped; DB and data retained'));
    const e = state.evidence; e.cleanup = errors.length ? 'failed' : 'completed'; e.batchStopped = stopped;
    e.failureKinds = info.errors.map((err) => /OVERLAP_UNCONFIRMED/.test(err.message || '') ? 'overlap-unconfirmed' : /timeout/i.test(err.message || '') ? 'timeout' : 'scenario-failure');
    let attachmentStatus = 'saved';
    try { await info.attach('cross-evidence.json', { body: JSON.stringify(e, null, 2), contentType: 'application/json' }); } catch (error) { attachmentStatus = 'failed'; errors.push(error); }
    try {
      const files = ['demo/reference-view/server.cjs', 'demo/reference-sync/sync.cjs', 'tests/targets/demo-reference/target.cjs', 'tests/targets/demo-reference/ui.cjs', 'tests/scenarios/cross-feature/read-during-sync.integration.spec.cjs', 'test-support/cross-fixture.cjs', 'scripts/local-cross.cjs'];
      const codeHashes = {}; for (const file of files) codeHashes[file] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
      const summary = { runId: path.basename(process.env.BATCH_RUN_DIR), codeHashes, ...e, attachmentStatus, environmentCleanup: 'pending', runnerStatus: 'pending' };
      const file = path.join(process.env.BATCH_RUN_DIR, 'case-summary.json');
      await fs.writeFile(`${file}.partial`, JSON.stringify(summary, null, 2), { mode: 0o600 }); await fs.rename(`${file}.partial`, file);
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Cross-feature cleanup or evidence failed');
  }, { auto: true, timeout: 60000 }],
});
module.exports = { test };
