'use strict';
// A disposable, loopback-only environment. Only children created here are stopped.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { startLocalMysql } = require('../test-support/local-mysql.cjs');
const { createMock } = require('../services/status-mock/server.cjs');
const { createHandler } = require('../services/demo-app/server.cjs');
const mysql = require('../services/demo-app/node_modules/mysql2/promise');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'play-right-local-'));
const children = [];
const servers = [];
const pools = [];
let stopMysql, runnerStatus;
const runId = randomUUID();
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
});
async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function main() {
  const localMysql = await startLocalMysql();
  stopMysql = localMysql.stop;
  if (interrupted) throw new Error('Interrupted');
  const { port, optionsFile: cnf } = localMysql.connection;
  const { optionsFile: _optionsFile, ...dbConnection } = localMysql.connection;
  const setup = await mysql.createConnection(dbConnection);
  await setup.execute('CREATE TABLE items (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, test_key VARCHAR(64) NOT NULL UNIQUE, status VARCHAR(32) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  await setup.end();
  const token = randomBytes(32).toString('hex');
  const curl = path.join(tmp, 'curl.conf'); fs.writeFileSync(curl, `header = "Authorization: Bearer ${token}"\n`, { mode: 0o600 });
  const env = { ...process.env, UI_RUN_ID: runId, TEST_PROFILE: 'local', TEST_ENV: 'local', MYSQL_HOST: '127.0.0.1', MYSQL_PORT: String(port), MYSQL_DATABASE: 'integration_demo', MYSQL_USER: 'local_test', MYSQL_OPTIONS_FILE: cnf, MOCK_CURL_CONFIG: curl };
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
  runnerStatus = interrupted ? 1 : code;
  process.exitCode = runnerStatus;
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  const cleanupErrors = [];
  for (const pool of pools) { try { await pool.end(); } catch (error) { cleanupErrors.push(error); } }
  for (const server of servers) { try { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } catch (error) { cleanupErrors.push(error); } }
  for (const child of children) if (!child.spawnError && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise((resolve) => child.once('exit', resolve)); }
    } catch (error) { cleanupErrors.push(error); }
  }
  try { if (stopMysql) await stopMysql(); } catch (error) { cleanupErrors.push(error); }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  const environmentCleanup = cleanupErrors.length ? 'failed' : 'completed';
  if (cleanupErrors.length) { for (const error of cleanupErrors) console.error(error); process.exitCode = 1; }
  const file = path.resolve('.local', 'runs', runId, 'case-summary.json');
  if (fs.existsSync(file)) {
    try {
      const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
      summary.environmentCleanup = environmentCleanup;
      summary.runnerStatus = runnerStatus === undefined ? 'unconfirmed' : runnerStatus === 0 ? 'passed' : 'failed';
      fs.writeFileSync(`${file}.partial`, JSON.stringify(summary, null, 2), { mode: 0o600 }); fs.renameSync(`${file}.partial`, file);
      console.log(`UI summary: ${file}`);
    } catch (error) { console.error('Unable to finalize UI summary:', error.message); process.exitCode = 1; }
  }
});
