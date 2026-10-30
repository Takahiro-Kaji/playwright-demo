'use strict';
const assert = require('node:assert/strict');

function errorEvidence(error) {
  return { name: error.name, message: error.message, ...(error.code ? { code: error.code } : {}),
    ...(error.ownershipUnknown ? { ownershipUnknown: true } : {}) };
}

// Register a change BEFORE sending PUT; set configured only after a valid success
// reply. Unknown ownership requires manual recovery, never an unconditional PUT.
// compareAndSet must atomically check the configured instance/version/status at
// the server. A preflight GET followed by an unconditional PUT is insufficient.
async function restoreMocks(changes, compareAndSet, probe) {
  const errors = [];
  const evidence = [];
  for (const change of [...changes].reverse()) {
    const { target, original, configured } = change;
    const record = { target: { key: target.key, region: target.region },
      original: original ? { ...original } : null, configured: configured ? { ...configured } : null,
      restored: null, probe: { configured: change.configuredProbe || null, restored: null },
      outcome: 'unconfirmed', failedStage: null, failures: [],
      ...(change.configureError ? { configureError: errorEvidence(change.configureError) } : {}) };
    evidence.push(record);
    let stage = 'ownership';
    try {
      assert.ok(original && configured, 'Mock change ownership is unknown; restoration was not attempted');
      assert.equal(original.region, target.region, 'Original mock region differs');
      assert.equal(configured.region, target.region, 'Configured mock region differs');
      assert.ok(typeof original.instanceId === 'string' && original.instanceId.length > 0, 'Original mock identity is missing');
      assert.equal(configured.instanceId, original.instanceId, 'Mock restarted during configuration');
      assert.ok(Number.isSafeInteger(original.version) && Number.isSafeInteger(configured.version)
        && configured.version === original.version + 1, 'Configured mock version does not establish ownership');
      stage = 'restore';
      const state = await compareAndSet(target, original.status, configured);
      record.restored = state;
      stage = 'verify-restored';
      assert.equal(state.region, target.region, 'Restored mock region differs');
      assert.equal(state.instanceId, configured.instanceId, 'Restored mock instance differs');
      assert.equal(state.version, configured.version + 1, 'Restored mock version differs');
      assert.equal(state.status, original.status, 'Restored status differs');
      stage = 'probe';
      record.probe.restored = await probe(target, state);
      record.outcome = 'restored';
    } catch (error) {
      record.failedStage = stage;
      record.outcome = stage === 'ownership' || error.ownershipUnknown ? 'ownership-unknown'
        : error.code === 'MOCK_STATE_CONFLICT' ? 'conflict' : 'failed';
      if (error.currentState) record.current = error.currentState;
      if (error.probe) record.probe.restored = error.probe;
      record.failures.push({ stage, error: errorEvidence(error) });
      const failure = new Error(`${target.region}: ${error.message}`, { cause: error });
      failure.stage = stage;
      failure.targetKey = target.key;
      errors.push(failure);
    }
  }
  return { errors, evidence };
}

function throwFailures(businessError, cleanupErrors) {
  if (businessError && cleanupErrors.length) {
    throw new AggregateError([businessError, ...cleanupErrors], 'Scenario and mock restoration failed');
  }
  if (businessError) throw businessError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Mock restoration failed');
}
module.exports = { restoreMocks, throwFailures };
