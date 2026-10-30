'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMock } = require('../services/status-mock/server.cjs');
const { control, compareAndSet, probe } = require('../helpers/mock-control.cjs');
const { restoreMocks } = require('../helpers/restore-mocks.cjs');
const { runCommand } = require('../helpers/run-command.cjs');
const token = '0'.repeat(64);
async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
function close(server) { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); }

test('Stateful status mock: auth, status switch, metadata, empty body, independent regions', async () => {
  const a = createMock({ region: 'region-a', token });
  const b = createMock({ region: 'region-b', token });
  const app = await listen(a.business), admin = await listen(a.admin);
  try {
    const first = await fetch(`${app.url}/status`);
    assert.equal(first.status, 200); assert.equal(await first.text(), '');
    assert.equal((await fetch(`${admin.url}/admin/status`)).status, 401);
    assert.equal((await fetch(`${app.url}/admin/status`)).status, 404);
    assert.equal((await fetch(`${app.url}/status?code=503`)).status, 400);
    const set = await fetch(`${admin.url}/admin/status`, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ status: 503 }) });
    const state = await set.json();
    assert.equal(set.status, 200); assert.equal(state.status, 503); assert.equal(state.version, 1);
    const failing = await fetch(`${app.url}/status`);
    assert.equal(failing.status, 503); assert.equal(await failing.text(), '');
    assert.equal(failing.headers.get('x-mock-instance-id'), state.instanceId);
    assert.equal((await fetch(`${app.url}/healthz`)).status, 200);
    assert.equal(b.state().status, 200);
    const invalid = await fetch(`${admin.url}/admin/status`, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: '{"status":999}' });
    assert.equal(invalid.status, 400); assert.equal(a.state().status, 503);
  } finally { await close(app.server); await close(admin.server); }
});
test('Startup rejects missing auth, region and invalid default', () => {
  assert.throws(() => createMock({ region: 'a', token: '' }));
  assert.throws(() => createMock({ token }));
  assert.throws(() => createMock({ region: 'a', token, initialStatus: 700 }));
});

test('atomic expected-state mutation refuses races, same-status changes, and restarted instances', async () => {
  const mock = createMock({ region: 'A', token });
  const admin = await listen(mock.admin);
  const put = (status, expected) => fetch(`${admin.url}/admin/status`, { method: 'PUT',
    headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ status, expected }) });
  try {
    const original = mock.state();
    const race = await Promise.all([put(503, original), put(429, original)]);
    assert.deepEqual(race.map((response) => response.status).sort(), [200, 409]);
    assert.equal(mock.state().version, 1);
    const foreignState = mock.state();
    const stale = await put(200, original);
    assert.equal(stale.status, 409);
    assert.deepEqual((await stale.json()).current, foreignState);
    assert.deepEqual(mock.state(), foreignState);
    const sameStatusUpdate = await put(foreignState.status, foreignState);
    assert.equal(sameStatusUpdate.status, 200);
    assert.equal((await put(200, foreignState)).status, 409);
    const restarted = createMock({ region: 'A', token, initialStatus: mock.state().status });
    const anotherInstance = { ...mock.state(), instanceId: restarted.state().instanceId };
    assert.equal((await put(200, anotherInstance)).status, 409);
    for (const expected of [null, {}, { ...mock.state(), version: '2' },
      { ...mock.state(), region: 'B' }, { ...mock.state(), status: mock.state().status === 429 ? 503 : 429 }]) {
      const previous = mock.state();
      const response = await put(200, expected);
      assert.ok([400, 409].includes(response.status));
      assert.deepEqual(mock.state(), previous);
    }
  } finally { await close(admin.server); }
});

test('real curl CAS restoration preserves foreign state, refuses restart, and records response loss', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-cas-'));
  const config = path.join(directory, 'curl.conf');
  fs.writeFileSync(config, `header = "Authorization: Bearer ${token}"\n`, { mode: 0o600 });
  const previousConfig = process.env.MOCK_CURL_CONFIG;
  process.env.MOCK_CURL_CONFIG = config;
  let mock = createMock({ region: 'A', token });
  const admin = await listen((req, res) => mock.admin(req, res));
  const app = await listen((req, res) => mock.business(req, res));
  const target = { key: 'a', region: 'A', adminUrl: admin.url, mockUrl: app.url };
  try {
    const original = await control(target);
    const configured = await compareAndSet(target, 503, original);
    const configuredProbe = await probe(target, configured);
    const successful = await restoreMocks([{ target, original, configured, configuredProbe }], compareAndSet, probe);
    assert.equal(successful.errors.length, 0);
    assert.equal(successful.evidence[0].restored.status, 200);
    assert.equal(successful.evidence[0].probe.restored.status, 200);

    const beforeRace = await control(target);
    const ours = await compareAndSet(target, 503, beforeRace);
    const theirs = await control(target, 429); // Existing unconditional client.
    const conflict = await restoreMocks([{ target, original: beforeRace, configured: ours }], compareAndSet, probe);
    assert.equal(conflict.errors.length, 1);
    assert.equal(conflict.evidence[0].outcome, 'conflict');
    assert.deepEqual(await control(target), theirs);
    assert.deepEqual(conflict.evidence[0].current, theirs);

    mock = createMock({ region: 'A', token, initialStatus: 503 });
    const restarted = mock.state();
    const restartResult = await restoreMocks([{ target, original: beforeRace, configured: ours }], compareAndSet, probe);
    assert.equal(restartResult.evidence[0].outcome, 'conflict');
    assert.deepEqual(mock.state(), restarted);

    const beforeLostResponse = await control(target);
    let configureError;
    try {
      await compareAndSet(target, 429, beforeLostResponse, async (...args) => {
        await runCommand(...args); // The server commits, then the caller loses its reply.
        throw new Error('injected response loss');
      });
      assert.fail('response loss must throw');
    } catch (error) { configureError = error; }
    assert.equal(configureError.ownershipUnknown, true);
    const committedWithoutReply = mock.state();
    assert.equal(committedWithoutReply.status, 429);
    const unknown = await restoreMocks([{ target, original: beforeLostResponse, configureError }], compareAndSet, probe);
    assert.equal(unknown.evidence[0].outcome, 'ownership-unknown');
    assert.equal(unknown.evidence[0].restored, null);
    assert.deepEqual(mock.state(), committedWithoutReply);

    const latestOriginal = await control(target);
    const latestConfigured = await compareAndSet(target, 503, latestOriginal);
    const lostRestore = await restoreMocks([{ target, original: latestOriginal, configured: latestConfigured }],
      (t, status, expected) => compareAndSet(t, status, expected, async (...args) => {
        await runCommand(...args); throw new Error('injected restore response loss');
      }), probe);
    assert.equal(lostRestore.evidence[0].outcome, 'ownership-unknown');
    assert.equal(lostRestore.evidence[0].restored, null);
    assert.equal(mock.state().status, latestOriginal.status);
    assert.equal(mock.state().version, latestConfigured.version + 1);
  } finally {
    if (previousConfig === undefined) delete process.env.MOCK_CURL_CONFIG;
    else process.env.MOCK_CURL_CONFIG = previousConfig;
    await close(app.server); await close(admin.server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
module.exports = { listen, close };
