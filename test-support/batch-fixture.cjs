'use strict';
const { test: base } = require('@playwright/test');
const fs = require('node:fs/promises');
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
    try { await info.attach('batch-evidence.json', { body: JSON.stringify(state.evidence, null, 2), contentType: 'application/json' }); }
    catch (e) { errors.push(e); }
    if (errors.length) throw new AggregateError(errors, 'Batch cleanup or evidence failed');
  }, { auto: true, timeout: 60000 }],
});
module.exports = { test };
