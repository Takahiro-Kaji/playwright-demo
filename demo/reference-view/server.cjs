'use strict';
const http = require('node:http');
// A normal read-only demo of the synchronized parent records, not timing instrumentation.
function createReferenceView(db) {
  return http.createServer(async (req, res) => {
    try {
      if (req.url === '/reference' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'" });
        return res.end('<!doctype html><html lang="ja"><meta charset="utf-8"><title>参照デモ</title><h1>親データ参照</h1><button data-testid="refresh">参照</button><p data-testid="result" data-state="idle" role="status"></p><script src="/reference.js" defer></script></html>');
      }
      if (req.url === '/reference.js' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        return res.end(`document.querySelector('[data-testid="refresh"]').addEventListener('click', async () => { const result = document.querySelector('[data-testid="result"]'); result.dataset.state = 'loading'; try { const r = await fetch('/api/reference'); if (!r.ok) throw Error('request failed'); const body = await r.json(); result.textContent = '親データ: ' + body.count + '件'; result.dataset.state = 'ready'; } catch (_) { result.textContent = '参照できません'; result.dataset.state = 'error'; } });`);
      }
      if (req.url === '/api/reference' && req.method === 'GET') {
        const [rows] = await db.query('SELECT COUNT(*) AS count FROM parents');
        const body = JSON.stringify({ count: rows[0].count });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
        return res.end(body);
      }
      res.writeHead(404); res.end();
    } catch (_) { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
}
module.exports = { createReferenceView };
