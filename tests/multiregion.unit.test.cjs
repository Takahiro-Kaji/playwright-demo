'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createMock } = require('../services/status-mock/server.cjs');
const { createHandler } = require('../services/demo-app/server.cjs');
const { createRouter } = require('../helpers/random-router.cjs');
const { control, probe } = require('../helpers/mock-control.cjs');
const { runCommand } = require('../helpers/run-command.cjs');
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }

test('Two apps share one DB adapter; actual curl changes a regional mock; router preserves observed status', async () => {
  const token = '1'.repeat(64);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-test-'));
  const config = path.join(tmp, 'curl.conf');
  fs.writeFileSync(config, `header = "Authorization: Bearer ${token}"\n`, { mode: 0o600 });
  const old = process.env.MOCK_CURL_CONFIG;
  process.env.MOCK_CURL_CONFIG = config;
  const rows = [], servers = [], regions = [];
  const db = () => ({ execute: async (_sql, values) => { rows.push(values); return [{}]; } });
  try {
    for (const region of ['region-a', 'region-b']) {
      const mock = createMock({ region, token });
      const business = http.createServer(mock.business), admin = http.createServer(mock.admin);
      servers.push(business, admin);
      const target = { region, mockUrl: await listen(business), adminUrl: await listen(admin) };
      const app = http.createServer(createHandler({ region, db, mockUrl: target.mockUrl }));
      servers.push(app); target.url = await listen(app); regions.push(target);
    }
    const original = await control(regions[1]);
    const state = await control(regions[1], 503); // Runs real curl, not a substituted mock command.
    await probe(regions[1], state);
    assert.equal((await control(regions[0])).status, 200);
    let next = 0;
    const router = createRouter(regions, () => next++ % 2); // Deterministic branch coverage; production uses crypto.randomInt.
    servers.push(router); const ingress = await listen(router);
    for (const [expected, region, count] of [[201, 'region-a', 1], [502, 'region-b', 1]]) {
      const response = await fetch(`${ingress}/api/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ testKey: `it-${randomUUID()}` }) });
      assert.equal(response.status, expected);
      assert.equal(response.headers.get('x-routed-region'), region);
      assert.equal(response.headers.get('x-app-region'), region);
      assert.equal(response.headers.get('x-mock-region'), region);
      assert.equal(Number(response.headers.get('x-external-status')), expected === 201 ? 200 : 503);
      assert.equal(rows.length, count);
    }
    await control(regions[1], original.status);
    assert.equal((await control(regions[1])).status, 200);
    const bad = await fetch(`${regions[0].url}/api/items`, { method: 'POST', body: JSON.stringify({ testKey: `it-${randomUUID()}`, mockStatus: 200 }) });
    assert.equal(bad.status, 400); // App caller cannot choose the mock response.
  } finally {
    for (const server of servers.reverse()) await close(server);
    if (old === undefined) delete process.env.MOCK_CURL_CONFIG; else process.env.MOCK_CURL_CONFIG = old;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('Router rejects public hosts and identical region labels', () => {
  assert.throws(() => createRouter([{ region: 'a', url: 'http://example.com' }, { region: 'b', url: 'http://127.0.0.1:1' }]));
  assert.throws(() => createRouter([{ region: 'a', url: 'http://127.0.0.1:1' }, { region: 'a', url: 'http://127.0.0.1:2' }]));
});
test('Command helper handles failure and timeout without shell evaluation', async () => {
  assert.equal((await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(echo unsafe)'])).stdout, '$(echo unsafe)');
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.exit(9)']), /exited with 9/);
  await assert.rejects(runCommand(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 30 }), /timed out/);
});
