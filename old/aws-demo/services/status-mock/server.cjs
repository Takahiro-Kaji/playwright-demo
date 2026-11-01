'use strict';
const http = require('node:http');
const { randomUUID, timingSafeEqual } = require('node:crypto');

// One process/Pod per region. State is intentionally transient and starts at 200.
function createMock({ region, token, initialStatus = 200 } = {}) {
  if (!region || typeof token !== 'string' || token.length < 32) throw new Error('Region and a 32+ character admin token are required');
  if (!Number.isInteger(initialStatus) || initialStatus < 200 || initialStatus > 599) throw new Error('Invalid initial status');
  const instanceId = randomUUID();
  let status = initialStatus;
  let version = 0;
  const state = () => ({ region, status, version, instanceId });
  function headers() {
    return { 'cache-control': 'no-store', 'x-mock-region': region,
      'x-mock-version': String(version), 'x-mock-instance-id': instanceId };
  }
  function business(req, res) {
    const url = new URL(req.url, 'http://mock');
    let code = 404;
    if (req.method === 'GET' && url.pathname === '/healthz') code = 200;
    if (req.method === 'GET' && url.pathname === '/status') code = url.search ? 400 : status;
    res.writeHead(code, { ...headers(), 'content-length': '0' });
    res.end(); // No business payload. Query parameters cannot override configured status.
  }
  function reply(res, code, value) {
    const body = JSON.stringify(value);
    res.writeHead(code, { ...headers(), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }
  async function admin(req, res) {
    const provided = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return reply(res, 401, { error: 'unauthorized' });
    if (req.url !== '/admin/status') return reply(res, 404, { error: 'not-found' });
    if (req.method === 'GET') return reply(res, 200, state());
    if (req.method !== 'PUT') return reply(res, 405, { error: 'method-not-allowed' });
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 1024) return reply(res, 413, { error: 'too-large' });
      }
      const data = JSON.parse(body);
      if (!data || Object.keys(data).some((k) => k !== 'status') || !Number.isInteger(data.status) || data.status < 200 || data.status > 599) {
        return reply(res, 400, { error: 'status-must-be-integer-200-to-599' });
      }
      status = data.status;
      version += 1;
      return reply(res, 200, state());
    } catch (_) { return reply(res, 400, { error: 'invalid-json' }); }
  }
  return { business, admin, state };
}
if (require.main === module) {
  const mock = createMock({ region: process.env.APP_REGION, token: process.env.MOCK_ADMIN_TOKEN });
  const servers = [
    http.createServer(mock.business).listen(Number(process.env.PORT || 8081), '0.0.0.0'),
    http.createServer((req, res) => mock.admin(req, res).catch(() => { res.writeHead(500); res.end(); }))
      .listen(Number(process.env.ADMIN_PORT || 8082), '0.0.0.0'),
  ];
  for (const server of servers) { server.requestTimeout = 5000; server.headersTimeout = 5000; }
  process.on('SIGTERM', () => { for (const server of servers) server.close(); });
}
module.exports = { createMock };
