'use strict';
const { test: base } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { compareAndSet, probe } = require('../helpers/mock-control.cjs');
const { restoreMocks } = require('../helpers/restore-mocks.cjs');
// Persist only the identity and status needed to audit restoration, never arbitrary response headers.
function safeState(value) {
  return value ? { region: value.region, status: value.status, version: value.version, instanceId: value.instanceId } : null;
}
function safeProbe(value) {
  return value ? { status: value.status, region: value.headers?.['x-mock-region'], version: value.headers?.['x-mock-version'], instanceId: value.headers?.['x-mock-instance-id'] } : null;
}
function safeRestoration(records) {
  return records.map((r) => ({ target: r.target, original: safeState(r.original), configured: safeState(r.configured), restored: safeState(r.restored), probe: { configured: safeProbe(r.probe?.configured), restored: safeProbe(r.probe?.restored) }, outcome: r.outcome, failedStage: r.failedStage, failures: r.failures.map((failure) => ({ stage: failure.stage, kind: failure.error?.code || failure.error?.name || 'error' })) }));
}
const test = base.extend({
  caseState: [async ({}, use, info) => {
    const state = { changes: [], evidence: {} };
    await use(state);
    const result = await restoreMocks(state.changes, state.compareAndSet || compareAndSet, state.probe || probe);
    state.evidence.restoration = result.evidence;
    state.evidence.businessErrors = info.errors.map((error) => ({ message: error.message, stack: error.stack }));
    state.evidence.cleanupErrors = result.errors.map((error) => ({ message: error.message, stack: error.stack }));
    let attachmentError;
    try { await info.attach('case-evidence.json', { body: JSON.stringify(state.evidence, null, 2), contentType: 'application/json' }); }
    catch (error) { attachmentError = error; }
    let summaryError;
    if (state.summary) {
      try {
        const id = process.env.UI_RUN_ID || randomUUID();
        if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid UI run ID');
        const dir = path.resolve('.local', 'runs', id); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const codeHashes = {};
        for (const file of state.summaryFiles) codeHashes[file] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
        const failures = info.errors.map((error) => ({ phase: state.summary.phase, kind: state.failureKind || (/Wrong user-visible message/.test(error.message || '') ? 'ui-text-mismatch' : /timeout/i.test(error.message || '') ? 'timeout' : 'scenario-error') }));
        const summary = { runId: id, ...state.summary, codeHashes, verdict: info.errors.length ? 'FAIL' : 'PASS', businessFailures: failures, restoration: safeRestoration(result.evidence), cleanup: result.errors.length ? 'failed' : 'completed', attachmentStatus: attachmentError ? 'failed' : 'saved', runnerStatus: 'pending', environmentCleanup: 'pending' };
        const file = path.join(dir, 'case-summary.json');
        await fs.writeFile(`${file}.partial`, JSON.stringify(summary, null, 2), { mode: 0o600 }); await fs.rename(`${file}.partial`, file);
      } catch (error) { summaryError = error; }
    }
    if (result.errors.length || attachmentError || summaryError) throw new AggregateError([...result.errors, ...(attachmentError ? [attachmentError] : []), ...(summaryError ? [summaryError] : [])], 'Mock restoration or evidence failed');
  }, { auto: true, timeout: 60_000 }],
});
module.exports = { test };
