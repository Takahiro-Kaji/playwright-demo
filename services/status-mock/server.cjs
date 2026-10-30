'use strict';
const http = require('node:http');
const PORT = Number(process.env.PORT || 8081);

function handler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'content-length': '0' });
    return res.end();
  }
  if (req.method === 'GET' && url.pathname === '/status') {
    const raw = url.searchParams.get('code') || '200';
    if (!['200', '503'].includes(raw)) {
      res.writeHead(400, { 'content-length': '0' });
      return res.end();
    }
    // This is deliberately only a status code. No business response body/state.
    res.writeHead(Number(raw), { 'content-length': '0', 'cache-control': 'no-store' });
    return res.end();
  }
  res.writeHead(404, { 'content-length': '0' });
  res.end();
}

if (require.main === module) {
  http.createServer(handler).listen(PORT, '0.0.0.0', () => {
    console.log(`Status-only mock listening on ${PORT}`);
  });
}
module.exports = { handler };
