'use strict';
const http = require('node:http');
const { randomInt } = require('node:crypto');
// Local test ingress, not an AWS global load balancer. No retry/failover/stickiness.
function createRouter(targets, choose = () => randomInt(2)) {
  if (targets.length !== 2 || new Set(targets.map((t) => t.region)).size !== 2) throw new Error('Exactly two distinct regions required');
  for (const t of targets) {
    const u = new URL(t.url);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1') throw new Error('Router targets must be loopback HTTP port-forwards');
  }
  return http.createServer((req, res) => {
    const target = targets[choose()];
    if (!target) { res.writeHead(500); return res.end(); }
    // Use only incoming path/query, never let absolute URLs replace the target host.
    const pathname = new URL(req.url, 'http://router').pathname;
    const search = new URL(req.url, 'http://router').search;
    const dest = new URL(target.url);
    const headers = { ...req.headers, host: dest.host, connection: 'close' };
    delete headers['x-routed-region'];
    const upstream = http.request(dest, { path: pathname + search, method: req.method, headers }, (response) => {
      res.writeHead(response.statusCode, { ...response.headers, 'cache-control': 'no-store', 'x-routed-region': target.region });
      response.pipe(res);
    });
    upstream.setTimeout(15000, () => upstream.destroy(new Error('upstream-timeout')));
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'x-routed-region': target.region, 'cache-control': 'no-store' });
      res.end(); // Never redirect/retry a failed write to the other region.
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });
}
module.exports = { createRouter };
