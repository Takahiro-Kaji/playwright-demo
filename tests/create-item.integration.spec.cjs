'use strict';
const { expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { assertDeploymentReady, required } = require('../helpers/kubernetes.cjs');
const { regions } = require('../helpers/regions.cjs');
const { control, compareAndSet, probe } = require('../helpers/mock-control.cjs');
const { snapshotItems } = require('../helpers/mysql.cjs');
const cases = require('./cases.cjs');

const { test } = require('../test-support/case-fixture.cjs');
test.beforeAll(async () => {
  if (!['local', 'dev', 'test', 'staging'].includes(required('TEST_ENV'))) throw new Error('Non-production only');
  if (process.env.TEST_PROFILE === 'local') {
    if (required('TEST_ENV') !== 'local') throw new Error('Local profile requires local environment');
    return;
  }
  for (const region of regions()) {
    await assertDeploymentReady('demo-app', region.context);
    await assertDeploymentReady('status-mock', region.context);
  }
});
// No serial-group dependencies: each case validates its own preconditions and restores changed settings.
// Additional pinned runs prove both regional paths. Random samples alone cannot guarantee coverage.
for (const route of ['random', 'a', 'b']) for (const scenario of cases) {
  if (route === 'a' && ['both-unavailable', 'both-ok'].includes(scenario.id)) continue; // Migrated to scenarios/ui.
  test(`${route} / ${scenario.id}`, async ({ page, caseState }) => {
    const targets = regions();
    const key = `it-${randomUUID()}`;
    const original = {};
    const configured = {};
    const changes = caseState.changes;
    const evidence = caseState.evidence = { key, route, scenario, before: null, after: null, mocks: {}, response: null, ui: null };
      // Given: establish both mocks and the DB baseline before any UI operation.
      for (const t of targets) original[t.key] = await control(t);
      for (const t of targets) {
        if (scenario.changeStatus !== null) {
          const change = { target: t, original: original[t.key] };
          changes.push(change); // An unknown response is recorded without a blind restore.
          try { configured[t.key] = change.configured = await compareAndSet(t, scenario.changeStatus, original[t.key]); }
          catch (error) { change.configureError = error; throw error; }
        } else configured[t.key] = original[t.key];
        expect(configured[t.key].status, `${t.region}: precondition`).toBe(scenario.mockStatus);
        const change = changes.find((item) => item.target.key === t.key);
        try {
          evidence.mocks[t.key] = { state: configured[t.key], probe: await probe(t, configured[t.key]) };
          if (change) change.configuredProbe = evidence.mocks[t.key].probe;
        } catch (error) {
          if (change && error.probe) change.configuredProbe = error.probe;
          throw error;
        }
      }
      if (scenario.db === 'before-after') {
        evidence.before = await snapshotItems(key);
        expect(evidence.before).toEqual([]); // New UUID; comparison is isolated from other tests.
      }
      // When: operate the real UI.
      const base = route === 'random' ? required('BASE_URL') : targets.find((t) => t.key === route).appUrl;
      await page.goto(`${base}/items/new`);
      await page.getByTestId('item-test-key').fill(key);
      // Match identity, not status: a wrong status must fail an assertion, not become a timeout.
      const responsePromise = page.waitForResponse((r) => {
        if (new URL(r.url()).pathname !== '/api/items' || r.request().method() !== 'POST') return false;
        return r.request().postDataJSON()?.testKey === key;
      });
      await page.getByTestId('item-create').click();
      const response = await responsePromise;
      // Then: independently check HTTP, UI, DB, and mock identity.
      const headers = await response.allHeaders();
      evidence.response = { status: response.status(), headers };
      const actual = targets.find((t) => t.region === headers['x-app-region']);
      expect(actual, 'Unknown response region').toBeTruthy();
      if (route === 'random') expect(headers['x-routed-region']).toBe(actual.region);
      else expect(actual.key).toBe(route);
      expect(response.status()).toBe(scenario.httpStatus);
      expect(Number(headers['x-external-status'])).toBe(scenario.mockStatus);
      expect(headers['x-mock-region']).toBe(actual.region);
      expect(headers['x-mock-version']).toBe(String(configured[actual.key].version));
      expect(headers['x-mock-instance-id']).toBe(configured[actual.key].instanceId);
      // UI is an independent acceptance criterion. A correct API status alone is not a PASS.
      const feedback = page.getByTestId('item-create-result');
      await expect(feedback, 'Expected UI feedback must be visible').toBeVisible();
      await expect(feedback, 'Wrong user-visible message').toHaveText(scenario.ui.text);
      await expect(feedback, 'Wrong accessibility role').toHaveAttribute('role', scenario.ui.role);
      await expect(feedback, 'Wrong UI state').toHaveAttribute('data-state', scenario.ui.state);
      await expect(feedback, 'Wrong live-region priority').toHaveAttribute('aria-live', scenario.ui.live);
      evidence.ui = {
        expected: scenario.ui,
        actual: {
          text: await feedback.innerText(),
          role: await feedback.getAttribute('role'),
          state: await feedback.getAttribute('data-state'),
          live: await feedback.getAttribute('aria-live'),
        },
      };
      const success = scenario.httpStatus === 201;
      if (scenario.db !== 'none') {
        if (success) {
          await expect.poll(async () => {
            evidence.after = await snapshotItems(key);
            return evidence.after.length;
          }, { timeout: 15000, intervals: [250, 500, 1000] }).toBe(1);
          expect(evidence.after[0]).toMatchObject({ testKey: key, status: 'CREATED' });
          if (scenario.db === 'before-after') expect(evidence.after.length - evidence.before.length).toBe(1);
        } else {
          // Do not pass on the first COUNT=0. Observe the full bounded no-change window.
          const until = Date.now() + 2000;
          do {
            evidence.after = await snapshotItems(key);
            expect(evidence.after).toEqual(evidence.before || []);
            await delay(250);
          } while (Date.now() < until);
        }
      }
      for (const t of targets) expect(await control(t), 'Mock changed/restarted during the test').toEqual(configured[t.key]);
  });
}
