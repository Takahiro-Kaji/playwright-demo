'use strict';
const http = require('node:http');
const fs = require('node:fs');


const PORT = Number(process.env.PORT || '8080');
const MOCK_URL = process.env.MOCK_URL || 'http://status-mock:8081';
const TEST_KEY_PATTERN = /^it-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const APP_REGION = process.env.APP_REGION || 'local';
let pool;

function database() {
  if (!pool) {
    const caFile = process.env.DB_CA_FILE;
    if (!caFile) throw new Error('DB_CA_FILE is required for authenticated TLS');
    pool = require('mysql2/promise').createPool({
      host: process.env.DB_HOST,
      port: 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'integration_demo',
      ssl: { ca: fs.readFileSync(caFile), rejectUnauthorized: true },
      connectionLimit: 4,
      connectTimeout: 7000,
    });
  }
  return pool;
}

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>結合試験デモ</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<h1>結合試験デモ</h1><p>EKS アプリ → モックHTTP → RDS MySQL</p>
<form id="item-form"><label>テストキー <input required data-testid="item-test-key" name="testKey"></label>

<button type="submit" data-testid="item-create">登録</button></form>
<p role="status" aria-live="polite" data-state="idle" data-testid="item-create-result"></p>
<script src="/form.js" defer></script></body></html>`;

const FORM_JS = `document.getElementById('item-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = document.querySelector('[data-testid="item-create-result"]');
  const form = event.currentTarget;
  result.setAttribute('role', 'status');
  result.setAttribute('aria-live', 'polite');
  result.dataset.state = 'loading';
  result.textContent = '登録中';
  try {
    const response = await fetch('/api/items', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({testKey:form.elements.testKey.value})
    });
    if (response.ok) {
      result.dataset.state = 'success';
      result.textContent = '作成しました';
    } else {
      result.setAttribute('role', 'alert');
      result.setAttribute('aria-live', 'assertive');
      result.dataset.state = 'error';
      result.textContent = response.status === 502 ? '外部システムエラー' : '登録できませんでした';
    }
  } catch (_) {
    result.setAttribute('role', 'alert');
    result.setAttribute('aria-live', 'assertive');
    result.dataset.state = 'error';
    result.textContent = '通信エラー';
  }
});`;

async function parseJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 8192) throw new Error('payload-too-large');
  }
  return JSON.parse(body);
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

function createHandler({ region = APP_REGION, db = database, mockUrl = MOCK_URL } = {}) {
return async function handler(req, res) {
  res.setHeader('x-app-region', region);
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ready: true });
  if (req.method === 'GET' && (path === '/' || path === '/items/new')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'none'; object-src 'none'" });
    return res.end(PAGE);
  }
  if (req.method === 'GET' && path === '/form.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(FORM_JS);
  }
  if (req.method === 'POST' && path === '/api/items') {
    let data;
    try {
      data = await parseJson(req);
    } catch (_) { return json(res, 400, { error: 'invalid-json' }); }
    if (!data || typeof data.testKey !== 'string' || !TEST_KEY_PATTERN.test(data.testKey) || Object.keys(data).some((k) => k !== 'testKey')) {
      return json(res, 400, { error: 'invalid-request' });
    }
    let response;
    try {
      response = await fetch(`${mockUrl}/status`, {
        signal: AbortSignal.timeout(3000), redirect: 'manual',
      });
    } catch (_) { return json(res, 502, { error: 'mock-unreachable' }); }
    res.setHeader('x-external-status', String(response.status));
    for (const name of ['x-mock-region', 'x-mock-version', 'x-mock-instance-id']) {
      res.setHeader(name, response.headers.get(name) || 'missing');
    }
    await response.arrayBuffer();
    if (response.headers.get('x-mock-region') !== region) return json(res, 502, { error: 'wrong-mock-region' });
    if (!response.ok) return json(res, 502, { error: 'external-system-unavailable', externalStatus: response.status });
    try {
      await db().execute('INSERT INTO items (test_key, status) VALUES (?, ?)', [data.testKey, 'CREATED']);
    } catch (error) {
      console.error('Insert failed:', error.code || error.message);
      return json(res, error.code === 'ER_DUP_ENTRY' ? 409 : 500, { error: 'database-insert-failed' });
    }
    return json(res, 201, { status: 'CREATED', testKey: data.testKey });
  }
  return json(res, 404, { error: 'not-found' });
};
}
const handler = createHandler();

if (require.main === module) {
  http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      console.error('Unexpected request error:', error.message);
      if (!res.headersSent) json(res, 500, { error: 'internal-error' });
      else res.destroy();
    });
  }).listen(PORT, '0.0.0.0', () => console.log(`Demo app listening on ${PORT}`));
}
module.exports = { handler, createHandler, TEST_KEY_PATTERN, FORM_JS };
