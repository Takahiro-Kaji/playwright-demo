'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startLocalMysql } = require('../test-support/local-mysql.cjs');
const { createSource } = require('../mocks/reference-source/server.cjs');
const { setTimeout: delay } = require('node:timers/promises');
let mysql, server, runner, credentials, runnerError, work;
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
  mysql = await startLocalMysql();
  if (interrupted) throw new Error('Interrupted');
  const count = Number(process.env.BATCH_SIZE || 2);
  if (!Number.isInteger(count) || ![2, 30000].includes(count)) throw new Error('BATCH_SIZE must be 2 or 30000');
  const records = count === 2 ? require('../tests/targets/demo-reference/data/small.json') : Array.from({ length: 15000 }, (_, i) => ({ id: (9007199254740993n + BigInt(i)).toString(), destination: i % 2 ? 'west' : 'east', label: `p${i}`, note: i % 2 ? '' : null, children: [{ id: (9007199254840993n + BigInt(i)).toString(), destination: i % 2 ? 'west' : 'east', value: `c${i}` }] }));
  server = createSource(records); await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  credentials = path.join(path.dirname(mysql.connection.optionsFile), 'batch.json');
  fs.writeFileSync(credentials, JSON.stringify({ host: mysql.connection.host, port: mysql.connection.port, user: mysql.connection.user, password: mysql.connection.password, database: mysql.connection.database }), { mode: 0o600 });
  fs.mkdirSync(path.resolve('.local'), { recursive: true, mode: 0o700 });
  work = fs.mkdtempSync(path.resolve('.local', 'batch-'));
  const env = { ...process.env, BATCH_WORK_DIR: work, BATCH_CONNECTION_FILE: credentials, BATCH_SOURCE_URL: `http://127.0.0.1:${server.address().port}`, BATCH_SIZE: String(count) };
  runner = spawn(path.join(__dirname, '../node_modules/.bin/playwright'), ['test', '-c', 'tests/scenarios/batch/playwright.config.cjs'], { env, stdio: 'inherit', detached: true });
  const status = await new Promise((resolve, reject) => { runner.on('error', (error) => { runnerError = error; reject(error); }); runner.on('exit', (code) => resolve(code ?? 1)); });
  process.exitCode = interrupted ? 1 : status;
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (runner && !runnerError) {
    signalGroup('SIGTERM');
    for (let i = 0; i < 50 && groupAlive(); i++) await delay(100);
    if (groupAlive()) { signalGroup('SIGKILL'); for (let i = 0; i < 50 && groupAlive(); i++) await delay(100); }
    if (groupAlive()) { console.error('Owned process group still alive; retaining MySQL for recovery'); process.exitCode = 1; return; }
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mysql) await mysql.stop();
  if (work) fs.rmSync(work, { recursive: true, force: true });
});
