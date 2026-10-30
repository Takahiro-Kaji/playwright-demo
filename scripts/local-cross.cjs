'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { startLocalMysql } = require('../test-support/local-mysql.cjs');
const mysqlDriver = require('../services/demo-app/node_modules/mysql2/promise');
const { createReferenceView } = require('../demo/reference-view/server.cjs');
const { createSource } = require('../mocks/reference-source/server.cjs');
const { setTimeout: delay } = require('node:timers/promises');
let mysql, server, view, pool, runner, credentials, runnerError, work, runDir, runnerStatus;
let interrupted = false;
function signalGroup(signal) {
  if (!runner || !runner.pid) return;
  try { process.kill(-runner.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
}
function groupAlive() {
  if (!runner || !runner.pid) return false;
  try { process.kill(-runner.pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  signalGroup('SIGTERM');
});
async function main() {
  runDir = path.resolve('.local', 'runs', randomUUID());
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  mysql = await startLocalMysql();
  if (interrupted) throw new Error('Interrupted');
  const count = 30000;
  if (!Number.isInteger(count) || ![2, 30000].includes(count)) throw new Error('BATCH_SIZE must be 2 or 30000');
  const records = count === 2 ? require('../tests/targets/demo-reference/data/small.json') : Array.from({ length: 15000 }, (_, i) => ({ id: (9007199254740993n + BigInt(i)).toString(), destination: i % 2 ? 'west' : 'east', label: `p${i}`, note: i % 2 ? '' : null, children: [{ id: (9007199254840993n + BigInt(i)).toString(), destination: i % 2 ? 'west' : 'east', value: `c${i}` }] }));
  server = createSource(records); await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  credentials = path.join(path.dirname(mysql.connection.optionsFile), 'batch.json');
  fs.writeFileSync(credentials, JSON.stringify({ host: mysql.connection.host, port: mysql.connection.port, user: mysql.connection.user, password: mysql.connection.password, database: mysql.connection.database }), { mode: 0o600 });
  fs.mkdirSync(path.resolve('.local'), { recursive: true, mode: 0o700 });
  work = fs.mkdtempSync(path.resolve('.local', 'batch-'));
  pool = mysqlDriver.createPool({ host: mysql.connection.host, port: mysql.connection.port, user: mysql.connection.user, password: mysql.connection.password, database: mysql.connection.database });
  view = createReferenceView(pool);
  await new Promise((resolve, reject) => view.listen(0, '127.0.0.1', resolve).once('error', reject));
  const env = { ...process.env, CROSS_VIEW_URL: `http://127.0.0.1:${view.address().port}`, BATCH_WORK_DIR: work, BATCH_RUN_DIR: runDir, BATCH_CONNECTION_FILE: credentials, BATCH_SOURCE_URL: `http://127.0.0.1:${server.address().port}`, BATCH_SIZE: String(count) };
  runner = spawn(path.join(__dirname, '../node_modules/.bin/playwright'), ['test', '-c', 'tests/scenarios/cross-feature/playwright.config.cjs'], { env, stdio: 'inherit', detached: true });
  const status = await new Promise((resolve, reject) => { runner.on('error', (error) => { runnerError = error; reject(error); }); runner.on('exit', (code) => resolve(code ?? 1)); });
  runnerStatus = interrupted ? 1 : status;
  process.exitCode = runnerStatus;
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  const cleanupErrors = [];
  let groupStopped = true;
  try {
    if (runner && !runnerError) {
      signalGroup('SIGTERM');
      for (let i = 0; i < 50 && groupAlive(); i++) await delay(100);
      if (groupAlive()) { signalGroup('SIGKILL'); for (let i = 0; i < 50 && groupAlive(); i++) await delay(100); }
      if (groupAlive()) throw new Error('Owned process group still alive; retaining MySQL for recovery');
    }
  } catch (e) { cleanupErrors.push(e); groupStopped = false; }
  if (groupStopped) {
    try { if (view) await new Promise((resolve) => view.close(resolve)); } catch (e) { cleanupErrors.push(e); }
    try { if (pool) await pool.end(); } catch (e) { cleanupErrors.push(e); }
    try { if (server) await new Promise((resolve) => server.close(resolve)); } catch (e) { cleanupErrors.push(e); }
    try { if (mysql) await mysql.stop(); } catch (e) { cleanupErrors.push(e); }
    try { if (work) fs.rmSync(work, { recursive: true, force: true }); } catch (e) { cleanupErrors.push(e); }
  }
  if (cleanupErrors.length) { process.exitCode = 1; for (const e of cleanupErrors) console.error(e); }
  if (runDir) {
    try {
      const file = path.join(runDir, 'case-summary.json');
      const summary = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { runId: path.basename(runDir), verdict: 'unconfirmed', cleanup: 'unconfirmed' };
      summary.runnerStatus = runnerStatus === undefined ? 'unconfirmed' : runnerStatus === 0 ? 'passed' : 'failed';
      summary.environmentCleanup = cleanupErrors.length ? 'failed' : 'completed';
      summary.environmentCleanupErrors = cleanupErrors.map((e) => e.message);
      const partial = `${file}.partial`;
      fs.writeFileSync(partial, JSON.stringify(summary, null, 2), { mode: 0o600 });
      fs.renameSync(partial, file);
      console.log(`Cross summary: ${file}`);
    } catch (e) { console.error('Unable to save batch summary:', e.message); process.exitCode = 1; }
  }
});
