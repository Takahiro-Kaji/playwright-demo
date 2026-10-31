'use strict';
const { expect } = require('@playwright/test');
const { randomUUID, createHash } = require('node:crypto');
const { test } = require('../../../test-support/case-fixture.cjs');
const { required, assertDeploymentReady } = require('../../../helpers/kubernetes.cjs');
const { regions } = require('../../../helpers/regions.cjs');
const { control, compareAndSet, probe } = require('../../../helpers/mock-control.cjs');
const { snapshotItems } = require('../../targets/demo-items/db.cjs');
const { createItem, assertFeedback } = require('../../targets/demo-items/ui.cjs');
const { success: expected } = require('../../targets/demo-items/expectations.cjs');

test.beforeAll(async () => {
  if (!['local', 'dev', 'test', 'staging'].includes(required('TEST_ENV'))) throw new Error('Non-production only');
  if (process.env.TEST_PROFILE === 'local') { if (required('TEST_ENV') !== 'local') throw new Error('Local profile requires local environment'); return; }
  for (const t of regions()) { await assertDeploymentReady('demo-app', t.context); await assertDeploymentReady('status-mock', t.context); }
});
test('a / both-ok', async ({ page, caseState }) => {
  const targets = regions(), key = `it-${randomUUID()}`, original = {}, configured = {};
  const evidence = caseState.evidence = { key, route: 'a', scenario: expected, before: null, after: null, mocks: {}, response: null, ui: { expected: expected.ui, actual: null } };
  caseState.summary = { caseId: 'a / both-ok', inputHash: createHash('sha256').update(JSON.stringify(expected)).digest('hex'), keyHash: createHash('sha256').update(key).digest('hex'), expected, ui: evidence.ui, http: null, db: { beforeCount: null, afterCount: null, delta: null, keyMatches: null, statusMatches: null, idIsString: null }, phase: 'given' };
  caseState.summaryFiles = ['tests/scenarios/ui/success.integration.spec.cjs', 'tests/targets/demo-items/db.cjs', 'tests/targets/demo-items/ui.cjs', 'tests/targets/demo-items/expectations.cjs', 'tests/cases.cjs', 'test-support/case-fixture.cjs', 'helpers/restore-mocks.cjs', 'helpers/mock-control.cjs', 'helpers/mysql.cjs', 'scripts/local-e2e.cjs', 'services/demo-app/server.cjs'];
  // Given: save both starting states, conditionally set 200, verify real responses and DB baseline.
  for (const t of targets) original[t.key] = await control(t);
  for (const t of targets) {
    const change = { target: t, original: original[t.key] }; caseState.changes.push(change);
    try { configured[t.key] = change.configured = await compareAndSet(t, expected.changeStatus, original[t.key]); }
    catch (error) { change.configureError = error; throw error; }
    expect(configured[t.key].status, `${t.region}: precondition`).toBe(expected.mockStatus);
    try { evidence.mocks[t.key] = { state: configured[t.key], probe: await probe(t, configured[t.key]) }; change.configuredProbe = evidence.mocks[t.key].probe; }
    catch (error) { if (error.probe) change.configuredProbe = error.probe; throw error; }
  }
  evidence.before = await snapshotItems(key); caseState.summary.db.beforeCount = evidence.before.length;
  expect(evidence.before).toEqual([]);
  // When: create through the real fixed-region A UI.
  caseState.summary.phase = 'when';
  const response = await createItem(page, targets.find((t) => t.key === 'a').appUrl, key);
  // Then: independently check HTTP, identity, UI and the UUID-scoped DB row.
  caseState.summary.phase = 'then';
  const headers = await response.allHeaders(); evidence.response = { status: response.status(), headers };
  caseState.summary.http = { status: response.status(), externalStatus: Number(headers['x-external-status']), appRegion: headers['x-app-region'], mockRegion: headers['x-mock-region'], mockVersion: headers['x-mock-version'], mockInstanceId: headers['x-mock-instance-id'] };
  expect(headers['x-app-region']).toBe(targets.find((t) => t.key === 'a').region);
  expect(response.status()).toBe(expected.httpStatus); expect(Number(headers['x-external-status'])).toBe(expected.mockStatus);
  expect(headers['x-mock-region']).toBe(targets.find((t) => t.key === 'a').region);
  expect(headers['x-mock-version']).toBe(String(configured.a.version)); expect(headers['x-mock-instance-id']).toBe(configured.a.instanceId);
  await assertFeedback(page, expected.ui, evidence.ui);
  await expect.poll(async () => { evidence.after = await snapshotItems(key); caseState.summary.db.afterCount = evidence.after.length; return evidence.after.length; }, { timeout: 15000, intervals: [250, 500, 1000] }).toBe(1);
  const row = evidence.after[0];
  Object.assign(caseState.summary.db, { delta: evidence.after.length - evidence.before.length, keyMatches: row.testKey === key, statusMatches: row.status === 'CREATED', idIsString: typeof row.id === 'string' });
  expect(caseState.summary.db.delta).toBe(1); expect(row.testKey).toBe(key); expect(typeof row.id).toBe('string');
  if (row.status !== 'CREATED') caseState.failureKind = 'db-status-mismatch';
  expect(row.status, 'Wrong item status').toBe('CREATED');
  for (const t of targets) expect(await control(t), 'Mock changed/restarted during the test').toEqual(configured[t.key]);
  // After: the shared fixture restores owned changes, verifies probes, and saves the result.
});
