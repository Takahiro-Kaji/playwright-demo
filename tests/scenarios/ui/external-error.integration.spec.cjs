'use strict';
const { expect } = require('@playwright/test');
const { randomUUID, createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('../../../test-support/case-fixture.cjs');
const { required, assertDeploymentReady } = require('../../../helpers/kubernetes.cjs');
const { regions } = require('../../../helpers/regions.cjs');
const { control, compareAndSet, probe } = require('../../../helpers/mock-control.cjs');
const { snapshotItems } = require('../../targets/demo-items/db.cjs');
const { createItem, assertFeedback } = require('../../targets/demo-items/ui.cjs');
const { expected } = require('../../targets/demo-items/expectations.cjs');

test.beforeAll(async () => {
  if (!['local', 'dev', 'test', 'staging'].includes(required('TEST_ENV'))) throw new Error('Non-production only');
  if (process.env.TEST_PROFILE === 'local') { if (required('TEST_ENV') !== 'local') throw new Error('Local profile requires local environment'); return; }
  for (const t of regions()) { await assertDeploymentReady('demo-app', t.context); await assertDeploymentReady('status-mock', t.context); }
});
test('a / both-unavailable', async ({ page, caseState }) => {
  const targets = regions(), key = `it-${randomUUID()}`, original = {}, configured = {};
  const evidence = caseState.evidence = { key, route: 'a', scenario: expected, before: null, after: null, mocks: {}, response: null, ui: { expected: expected.ui, actual: null } };
  caseState.summary = { caseId: 'a / both-unavailable', inputHash: createHash('sha256').update(JSON.stringify(expected)).digest('hex'), keyHash: createHash('sha256').update(key).digest('hex'), expected, ui: evidence.ui, http: null, db: { beforeCount: null, afterCount: null, observationMs: 2000 }, phase: 'given' };
  caseState.summaryFiles = ['tests/scenarios/ui/external-error.integration.spec.cjs', 'tests/targets/demo-items/db.cjs', 'tests/targets/demo-items/ui.cjs', 'tests/targets/demo-items/expectations.cjs', 'tests/cases.cjs', 'test-support/case-fixture.cjs', 'helpers/restore-mocks.cjs', 'helpers/mock-control.cjs', 'helpers/mysql.cjs'];
  // Given: capture both starting states, change only with ownership, and verify real responses and DB baseline.
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
  // When: operate fixed region A. Fault injection changes only the displayed text, on local profile.
  caseState.summary.phase = 'when';
  if (process.env.UI_VERIFY_WRONG_FEEDBACK === '1') {
    if (process.env.TEST_PROFILE !== 'local') throw new Error('UI fault injection requires the local profile');
    await page.route('**/form.js', async (route) => {
      const response = await route.fetch(); const source = await response.text();
      if (!source.includes('外部システムエラー')) throw new Error('Fault target not found');
      await route.fulfill({ response, body: source.replace('外部システムエラー', '注入した誤表示') });
    });
  }
  const response = await createItem(page, targets.find((t) => t.key === 'a').appUrl, key);
  // Then: HTTP, regional identity, visible UI and bounded DB non-update are separate checks.
  caseState.summary.phase = 'then';
  const headers = await response.allHeaders(); evidence.response = { status: response.status(), headers };
  caseState.summary.http = { status: response.status(), externalStatus: Number(headers['x-external-status']), appRegion: headers['x-app-region'], mockRegion: headers['x-mock-region'], mockVersion: headers['x-mock-version'], mockInstanceId: headers['x-mock-instance-id'] };
  expect(headers['x-app-region']).toBe(targets.find((t) => t.key === 'a').region);
  expect(response.status()).toBe(expected.httpStatus); expect(Number(headers['x-external-status'])).toBe(expected.mockStatus);
  expect(headers['x-mock-region']).toBe(targets.find((t) => t.key === 'a').region);
  expect(headers['x-mock-version']).toBe(String(configured.a.version)); expect(headers['x-mock-instance-id']).toBe(configured.a.instanceId);
  await assertFeedback(page, expected.ui, evidence.ui);
  const until = Date.now() + 2000;
  do { evidence.after = await snapshotItems(key); caseState.summary.db.afterCount = evidence.after.length; expect(evidence.after).toEqual(evidence.before); await delay(250); } while (Date.now() < until);
  for (const t of targets) expect(await control(t), 'Mock changed/restarted during the test').toEqual(configured[t.key]);
  // After: the shared fixture restores owned changes, verifies probes, and saves the result.
});
