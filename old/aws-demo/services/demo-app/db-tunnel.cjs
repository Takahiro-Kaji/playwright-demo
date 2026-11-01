'use strict';
// Temporary port-forward target for a private RDS endpoint. NO credentials are kept here.
// Only expose this workload through a ClusterIP service; do not add a LoadBalancer.
const net = require('node:net');
const host = process.env.RDS_HOST;
const port = Number(process.env.LOCAL_PORT || 3306);
if (!host || !/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error('RDS_HOST is required');
net.createServer((incoming) => {
  const upstream = net.connect(3306, host);
  incoming.on('error', () => upstream.destroy());
  upstream.on('error', () => incoming.destroy());
  incoming.pipe(upstream);
  upstream.pipe(incoming);
}).listen(port, '0.0.0.0', () => console.log(`Database TCP bridge listening on ${port}`));
