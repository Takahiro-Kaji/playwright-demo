'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { restoreMocks, throwFailures } = require('../helpers/restore-mocks.cjs');
const a = { key: 'a', region: 'A' };
const b = { key: 'b', region: 'B' };
function change(target, status = 200) {
  const original = { region: target.region, status, version: 4, instanceId: `instance-${target.key}` };
  const configured = { ...original, status: 503, version: 5 };
  return { target, original, configured, configuredProbe: { status: 503 } };
}
function restored(target, status, expected) { return { ...expected, status, version: expected.version + 1 }; }

test('restores each original status using atomic preconditions and saves successful evidence', async () => {
  const changes = [change(a), change(b, 429)];
  const calls = [];
  const result = await restoreMocks(changes,
    async (target, status, expected) => {
      calls.push([target.key, status, expected]);
      return restored(target, status, expected);
    },
    async (target, state) => ({ status: state.status, region: target.region }));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(calls, [['b', 429, changes[1].configured], ['a', 200, changes[0].configured]]);
  assert.deepEqual(result.evidence.map((e) => [e.target.key, e.original.status, e.configured.status,
    e.restored.status, e.probe.configured.status, e.probe.restored.status, e.failedStage, e.outcome]),
  [['b', 429, 503, 429, 503, 429, null, 'restored'], ['a', 200, 503, 200, 503, 200, null, 'restored']]);
  assert.doesNotThrow(() => JSON.stringify(result.evidence));
});

test('wrong restoration and failed probe retain their stages and still attempt every target', async () => {
  const seen = [];
  const probeError = new Error('probe failed');
  probeError.probe = { status: 429 };
  const { errors, evidence } = await restoreMocks([change(a), change(b)],
    async (target, status, expected) => {
      seen.push(target.key);
      return restored(target, target === b ? 200 + 1 : status, expected);
    }, async () => { throw probeError; });
  assert.deepEqual(seen, ['b', 'a']);
  assert.equal(errors.length, 2);
  assert.equal(errors[1].cause, probeError);
  assert.deepEqual(evidence.map((e) => e.failedStage), ['verify-restored', 'probe']);
  assert.deepEqual(evidence[1].probe.restored, { status: 429 });
  assert.throws(() => throwFailures(undefined, errors), /restoration failed/);
});

test('unknown configuration ownership never sends restoration, including lost PUT response', async () => {
  const lostResponse = new Error('PUT committed but response was lost');
  lostResponse.ownershipUnknown = true;
  const unknown = { ...change(b), configured: undefined, configureError: lostResponse };
  const calls = [];
  const { errors, evidence } = await restoreMocks([change(a), unknown],
    async (...args) => { calls.push(args[0].key); return restored(...args); }, async () => ({ status: 200 }));
  assert.deepEqual(calls, ['a']);
  assert.equal(errors.length, 1);
  assert.equal(evidence[0].outcome, 'ownership-unknown');
  assert.equal(evidence[0].failedStage, 'ownership');
  assert.equal(evidence[0].configured, null);
  assert.equal(evidence[0].restored, null);
  assert.equal(evidence[0].configureError.ownershipUnknown, true);
});

test('configuration with restarted instance or unexplained version is not treated as owned', async () => {
  for (const configured of [{ ...change(a).configured, instanceId: 'new-instance' },
    { ...change(a).configured, version: 7 }]) {
    const { errors, evidence } = await restoreMocks([{ ...change(a), configured }],
      async () => { assert.fail('must not write'); }, async () => assert.fail('must not probe'));
    assert.equal(errors.length, 1);
    assert.equal(evidence[0].outcome, 'ownership-unknown');
  }
});

test('atomic conflict leaves the other owner state in evidence and preserves the original error', async () => {
  const conflict = new Error('another run changed the mock');
  conflict.code = 'MOCK_STATE_CONFLICT';
  conflict.currentState = { ...change(a).configured, status: 429, version: 9 };
  const business = new Error('wrong UI');
  const { errors, evidence } = await restoreMocks([change(a)], async () => { throw conflict; },
    async () => assert.fail('must not probe a refused restore'));
  assert.equal(evidence[0].outcome, 'conflict');
  assert.equal(evidence[0].failedStage, 'restore');
  assert.equal(evidence[0].current.status, 429);
  assert.equal(evidence[0].restored, null);
  assert.equal(errors[0].cause, conflict);
  assert.throws(() => throwFailures(business, errors), (error) => {
    assert.deepEqual(error.errors, [business, ...errors]);
    return true;
  });
});

test('lost restoration response is unconfirmed and never retried; remaining targets still run', async () => {
  const calls = [];
  const { errors, evidence } = await restoreMocks([change(a), change(b)], async (target, status, expected) => {
    calls.push(target.key);
    if (target === b) {
      const error = new Error('restore response lost'); error.ownershipUnknown = true; throw error;
    }
    return restored(target, status, expected);
  }, async () => ({ status: 200 }));
  assert.deepEqual(calls, ['b', 'a']);
  assert.equal(errors.length, 1);
  assert.equal(evidence[0].outcome, 'ownership-unknown');
  assert.equal(evidence[0].restored, null);
  assert.equal(evidence[1].outcome, 'restored');
});

test('business error identity is retained without cleanup failure', () => {
  const business = new Error('wrong UI');
  assert.throws(() => throwFailures(business, []), (error) => error === business);
  assert.doesNotThrow(() => throwFailures(undefined, []));
});
