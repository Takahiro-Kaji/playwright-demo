'use strict';
// A disposable, loopback-only environment. Only children created here are stopped.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createMock } = require('../services/status-mock/server.cjs');
const { createHandler } = require('../services/demo-app/server.cjs');
const mysql = require('../services/demo-app/node_modules/mysql2/promise');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'play-right-local-'));
const children = [];
const servers = [];
const pools = [];
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
});
function command(cmd, args, input) {
  const result = spawnSync(cmd, args, { input, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${cmd} failed: ${result.stderr}`);
  return result.stdout;
}
async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function main() {
  const data = path.join(tmp, 'data'); fs.mkdirSync(data);
  const socket = path.join(tmp, 'mysql.sock');
  command('mysqld', ['--no-defaults', '--initialize-insecure', `--datadir=${data}`]);
  if (interrupted) throw new Error('Interrupted');
  const port = await freePort();
  const daemon = spawn('mysqld', ['--no-defaults', `--datadir=${data}`, `--socket=${socket}`, `--port=${port}`, '--bind-address=127.0.0.1', '--mysqlx=0', `--pid-file=${tmp}/mysql.pid`, `--log-error=${tmp}/mysql.log`], { stdio: 'ignore' });
  children.push(daemon);
  daemon.on('error', (error) => { daemon.spawnError = error; });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (daemon.spawnError) throw daemon.spawnError;
    if (daemon.exitCode !== null) throw new Error('Disposable MySQL exited before readiness');
    if (spawnSync('mysqladmin', ['--no-defaults', `--socket=${socket}`, '-u', 'root', 'ping'], { stdio: 'ignore' }).status === 0) { ready = true; break; }
    await delay(200);
  }
  if (!ready) throw new Error('Disposable MySQL did not start');
  command('mysql', ['--no-defaults', `--socket=${socket}`, '-u', 'root'], "CREATE DATABASE integration_demo; CREATE TABLE integration_demo.items (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, test_key VARCHAR(64) NOT NULL UNIQUE, status VARCHAR(32) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE USER 'local_test'@'127.0.0.1' IDENTIFIED BY 'local_test_password'; GRANT ALL ON integration_demo.* TO 'local_test'@'127.0.0.1';");
  const cnf = path.join(tmp, 'client.cnf'); fs.writeFileSync(cnf, '[client]\npassword=local_test_password\n', { mode: 0o600 });
  const token = randomBytes(32).toString('hex');
  const curl = path.join(tmp, 'curl.conf'); fs.writeFileSync(curl, `header = "Authorization: Bearer ${token}"\n`, { mode: 0o600 });
  const env = { ...process.env, TEST_PROFILE: 'local', TEST_ENV: 'local', MYSQL_HOST: '127.0.0.1', MYSQL_PORT: String(port), MYSQL_DATABASE: 'integration_demo', MYSQL_USER: 'local_test', MYSQL_OPTIONS_FILE: cnf, MOCK_CURL_CONFIG: curl };
  for (const key of ['A', 'B']) {
    const region = `local-${key.toLowerCase()}`;
    const mock = createMock({ region, token });
    const mockUrl = await listen(mock.business);
    const adminUrl = await listen((req, res) => mock.admin(req, res).catch(() => { res.writeHead(500); res.end(); }));
    const pool = mysql.createPool({ host: '127.0.0.1', port, user: 'local_test', password: 'local_test_password', database: 'integration_demo' }); pools.push(pool);
    const handler = createHandler({ region, mockUrl, db: () => pool });
    const appUrl = await listen((req, res) => { res.setHeader('x-routed-region', region); return handler(req, res).catch((error) => { console.error(error); res.destroy(); }); });
    Object.assign(env, { [`REGION_${key}`]: region, [`MOCK_URL_${key}`]: mockUrl, [`MOCK_ADMIN_URL_${key}`]: adminUrl, [`APP_URL_${key}`]: appUrl });
  }
  // The 503 demonstration pins region A; use it as the random route as well.
  env.BASE_URL = env.APP_URL_A;
  const args = ['test', '--reporter=list,json', ...process.argv.slice(2)];
  env.PLAYWRIGHT_JSON_OUTPUT_NAME = path.join(__dirname, '../test-results/local-e2e-report.json');
  const runnerPath = process.env.LOCAL_E2E_VERIFY_SPAWN_FAILURE === '1' ? path.join(tmp, 'missing-runner') : path.join(__dirname, '../node_modules/.bin/playwright');
  const runner = spawn(runnerPath, args, { env, stdio: 'inherit' }); children.push(runner);
  const code = await new Promise((resolve, reject) => { runner.on('error', (error) => { runner.spawnError = error; reject(error); }); runner.on('exit', (status) => resolve(status ?? 1)); });
  process.exitCode = interrupted ? 1 : code;
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const pool of pools) await pool.end().catch(() => {});
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  for (const child of children) if (!child.spawnError && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise((resolve) => child.once('exit', resolve)); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});
