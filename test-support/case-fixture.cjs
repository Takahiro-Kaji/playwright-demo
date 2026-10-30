'use strict';
const { test: base } = require('@playwright/test');
const { compareAndSet, probe } = require('../helpers/mock-control.cjs');
const { restoreMocks } = require('../helpers/restore-mocks.cjs');
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
    if (result.errors.length || attachmentError) throw new AggregateError([...result.errors, ...(attachmentError ? [attachmentError] : [])], 'Mock restoration or evidence failed');
  }, { auto: true, timeout: 60_000 }],
});
module.exports = { test };
