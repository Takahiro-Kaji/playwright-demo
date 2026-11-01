'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createMock } = require('../services/status-mock/server.cjs');
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
module.exports = { listen, close };
