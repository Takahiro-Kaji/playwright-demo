'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { runCommand } = require('../helpers/run-command.cjs');
const { createRouter } = require('../helpers/random-router.cjs');
const children = [];
let router;
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  if (router) { router.close(); router.closeAllConnections(); }
  for (const child of children) child.kill('SIGTERM');
  const kill = setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); }, 3000);
  kill.unref();
  process.exitCode = code;
}
function forward(context, service, ports) {
  return new Promise((resolve, reject) => {
    const child = spawn('kubectl', ['--context', context, '-n', 'integration-demo', 'port-forward',
      `svc/${service}`, ports, '--address', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const timer = setTimeout(() => reject(new Error(`Port-forward timeout: ${context}/${service}`)), 30000);
    let log = '';
    child.stdout.on('data', (data) => {
      process.stdout.write(`[${context}/${service}] ${data}`);
      log += data.toString();
      if (log.includes(`Forwarding from 127.0.0.1:${ports.split(':')[0]}`)) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', (data) => process.stderr.write(`[${context}/${service}] ${data}`));
    child.on('error', (e) => { clearTimeout(timer); reject(e); stop(1); });
    child.on('exit', () => { clearTimeout(timer); reject(new Error(`Port-forward stopped: ${context}/${service}`)); if (!closing) stop(1); });
  });
}
async function main() {
  const root = path.resolve(__dirname, '..');
  const out = JSON.parse((await runCommand('terraform', [`-chdir=${root}/infra`, 'output', '-json'])).stdout);
  const a = out.cluster_name.value, b = out.secondary_cluster_name.value;
  await Promise.all([
    forward(a, 'demo-app', '18081:8080'), forward(b, 'demo-app', '18082:8080'),
    forward(a, 'status-mock', '19081:8081'), forward(b, 'status-mock', '19082:8081'),
    forward(a, 'status-mock-admin', '19181:8082'), forward(b, 'status-mock-admin', '19182:8082'),
    forward(a, 'db-tunnel', '13306:3306'),
  ]);
  if (closing) return;
  router = createRouter([
    { region: out.region.value, url: 'http://127.0.0.1:18081' },
    { region: out.secondary_region.value, url: 'http://127.0.0.1:18082' },
  ]);
  router.on('error', (e) => { console.error(e.message); stop(1); });
  router.listen(18080, '127.0.0.1', () => console.log('Random ingress ready on 127.0.0.1:18080; Ctrl+C stops all forwards.'));
}
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
main().catch((e) => { console.error(e.message); stop(1); });
