'use strict';
const { test, expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { assertDeploymentReady, required } = require('../helpers/kubernetes.cjs');
const { regions } = require('../helpers/regions.cjs');
const { control, probe } = require('../helpers/mock-control.cjs');
const { snapshotItems } = require('../helpers/mysql.cjs');
const cases = require('./cases.cjs');

async function attach(info, name, value) {
  await info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
}
test.beforeAll(async () => {
  if (!['local', 'dev', 'test', 'staging'].includes(required('TEST_ENV'))) throw new Error('Non-production only');
  for (const region of regions()) {
    await assertDeploymentReady('demo-app', region.context);
    await assertDeploymentReady('status-mock', region.context);
  }
});
// No serial-group dependencies: each case validates its own preconditions and restores changed settings.
// Additional pinned runs prove both regional paths. Random samples alone cannot guarantee coverage.
for (const route of ['random', 'a', 'b']) for (const scenario of cases) {
  test(`${route} / ${scenario.id}`, async ({ page }, info) => {
    const targets = regions();
    const key = `it-${randomUUID()}`;
    const original = {};
    const configured = {};
    const changed = [];
    const evidence = { key, route, scenario, before: null, after: null, mocks: {}, response: null };
    try {
      for (const t of targets) original[t.key] = await control(t);
      for (const t of targets) {
        if (scenario.change && Object.hasOwn(scenario.change, t.key)) {
          changed.push(t); // Restore even if a PUT reaches the mock but its reply is lost.
          configured[t.key] = await control(t, scenario.change[t.key]);
        } else configured[t.key] = original[t.key];
        expect(configured[t.key].status, `${t.region}: precondition`).toBe(scenario.mock[t.key]);
        evidence.mocks[t.key] = { state: configured[t.key], probe: await probe(t, configured[t.key]) };
      }
      if (scenario.db === 'before-after') {
        evidence.before = await snapshotItems(key);
        expect(evidence.before).toEqual([]); // New UUID; comparison is isolated from other tests.
      }
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
      const headers = await response.allHeaders();
      evidence.response = { status: response.status(), headers, body: await response.text() };
      const actual = targets.find((t) => t.region === headers['x-app-region']);
      expect(actual, 'Unknown response region').toBeTruthy();
      if (route === 'random') expect(headers['x-routed-region']).toBe(actual.region);
      else expect(actual.key).toBe(route);
      expect(response.status()).toBe(scenario.http[actual.key]);
      expect(Number(headers['x-external-status'])).toBe(scenario.mock[actual.key]);
      expect(headers['x-mock-region']).toBe(actual.region);
      expect(headers['x-mock-version']).toBe(String(configured[actual.key].version));
      expect(headers['x-mock-instance-id']).toBe(configured[actual.key].instanceId);
      const success = scenario.http[actual.key] === 201;
      await expect(page.getByTestId('item-create-result')).toContainText(success ? '作成しました' : '外部システムエラー');
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
    } finally {
      const cleanupErrors = [];
      for (const t of changed.reverse()) {
        try { await control(t, original[t.key].status); }
        catch (e) { cleanupErrors.push(`${t.region}: ${e.message}`); }
      }
      evidence.cleanupErrors = cleanupErrors;
      await attach(info, 'case-evidence.json', evidence);
      if (cleanupErrors.length) throw new Error(`Mock restore failed: ${cleanupErrors.join('; ')}`);
    }
  });
}
