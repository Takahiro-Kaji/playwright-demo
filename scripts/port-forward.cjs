'use strict';
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const context = execFileSync('terraform', [`-chdir=${root}/infra`, 'output', '-raw', 'cluster_name'], { encoding: 'utf8' }).trim();
const forwards = [
  ['demo-app', 'svc/demo-app', '18080:8080'],
  ['db-tunnel', 'svc/db-tunnel', '13306:3306'],
];
let shuttingDown = false;
const children = forwards.map(([label, name, ports]) => {
  const child = spawn('kubectl', [
    '--context', context, '-n', 'integration-demo', 'port-forward', name, ports,
    '--address', '127.0.0.1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (b) => process.stdout.write(`[${label}] ${b.toString()}`));
  }
  child.on('error', (e) => { console.error(`[${label}] ${e.message}`); shutdown(1); });
  child.on('exit', (code) => { if (!shuttingDown) shutdown(code || 1); });
  return child;
});
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) if (child && child.exitCode === null) child.kill('SIGTERM');
  process.exitCode = code;
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
console.log('Local ports: http://127.0.0.1:18080 and MySQL 127.0.0.1:13306. Ctrl+C stops forwarding.');
