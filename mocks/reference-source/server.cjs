'use strict';
const http = require('node:http');
function createSource(records) {
  return http.createServer((req, res) => {
    if (req.url === '/broken') { res.writeHead(200, { 'content-type': 'application/json', 'content-length': 100 }); res.write('['); return res.destroy(); }
    if (req.url === '/invalid') { res.writeHead(200); return res.end('{'); }
    if (req.url !== '/records') { res.writeHead(404); return res.end(); }
    const body = JSON.stringify(records); res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }); res.end(body);
  });
}
module.exports = { createSource };
