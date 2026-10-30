'use strict';
const mysql = require('../../../services/demo-app/node_modules/mysql2/promise');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const path = require('node:path');
async function prepare(connection) {
  const db = await mysql.createConnection(connection);
  await db.query('CREATE TABLE parents (id BIGINT UNSIGNED NOT NULL, destination VARCHAR(20) NOT NULL, label VARCHAR(64) NOT NULL, note VARCHAR(64) NULL)');
  await db.query('CREATE TABLE children (id BIGINT UNSIGNED NOT NULL, parent_id BIGINT UNSIGNED NOT NULL, destination VARCHAR(20) NOT NULL, value VARCHAR(64) NULL)');
  await db.query("INSERT INTO parents VALUES (1, 'old', 'obsolete', NULL)");
  await db.query("INSERT INTO children VALUES (2, 1, 'old', 'obsolete')");
  return db;
}
function startBatch(credentials, url, extraEnv = {}) {
  const child = spawn(process.execPath, [path.resolve('demo/reference-sync/sync.cjs'), credentials, url], { env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; let closed = false; let spawnError;
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  const completion = new Promise((resolve, reject) => {
    child.on('error', (error) => { spawnError = error; reject(error); });
    child.on('close', (code, signal) => { closed = true; if (code === 0) resolve({ code }); else reject(new Error(`Batch exited ${code ?? signal}: ${stderr}`)); });
  });
  // Teardown may begin while the test body is timed out; prevent an unhandled rejection.
  completion.catch(() => {});
  async function stop() {
    if (!closed && !spawnError) {
      child.kill('SIGTERM');
      await Promise.race([completion.catch(() => {}), delay(5000)]);
      if (!closed) { child.kill('SIGKILL'); await completion.catch(() => {}); }
    }
    if (!closed && !spawnError) throw new Error('Batch process was not reaped');
  }
  return { completion, stop };
}
async function snapshot(db) {
  const [parents] = await db.query('SELECT CAST(id AS CHAR) id, destination, label, note FROM parents ORDER BY id');
  const [children] = await db.query('SELECT CAST(id AS CHAR) id, CAST(parent_id AS CHAR) parent_id, destination, value FROM children ORDER BY id');
  return { parents, children };
}
function expected(records) {
  return { parents: records.map(({ id, destination, label, note }) => ({ id, destination, label, note })), children: records.flatMap((p) => p.children.map((c) => ({ id: c.id, parent_id: p.id, destination: c.destination, value: c.value }))) };
}
function compare(want, got) {
  const differences = [];
  for (const table of ['parents', 'children']) {
    const counts = new Map(); const actualById = new Map(); for (const row of got[table]) { counts.set(row.id, (counts.get(row.id) || 0) + 1); if (!actualById.has(row.id)) actualById.set(row.id, row); }
    for (const [id, n] of counts) if (n > 1) differences.push({ table, id, type: 'duplicate' });
    for (const row of want[table]) {
      const actual = actualById.get(row.id);
      if (!actual) { differences.push({ table, id: row.id, type: 'missing' }); continue; }
      for (const key of Object.keys(row)) if (actual[key] !== row[key]) differences.push({ table, id: row.id, type: key === 'destination' ? 'destination' : key === 'parent_id' ? 'relation' : 'value', field: key });
    }
    const ids = new Set(want[table].map((r) => r.id));
    for (const row of got[table]) if (!ids.has(row.id)) differences.push({ table, id: row.id, type: 'extra' });
  }
  return differences;
}
module.exports = { prepare, startBatch, snapshot, expected, compare };
