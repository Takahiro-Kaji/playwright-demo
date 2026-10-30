'use strict';
const fs = require('node:fs');
const mysql = require('../../services/demo-app/node_modules/mysql2/promise');
async function main() {
  if (process.env.BATCH_VERIFY_HANG === '1') await new Promise(() => setInterval(() => {}, 1000));
  const credentials = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (credentials.host !== '127.0.0.1') throw new Error('Demo sync is restricted to local MySQL');
  const response = await fetch(process.argv[3], { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('Expected a JSON array');
  const db = await mysql.createConnection(credentials);
  try {
    await db.query('DELETE FROM children'); await db.query('DELETE FROM parents');
    for (const row of rows) {
      await db.execute('INSERT INTO parents (id, destination, label, note) VALUES (?, ?, ?, ?)', [row.id, row.destination, row.label, row.note]);
      for (const child of row.children) await db.execute('INSERT INTO children (id, parent_id, destination, value) VALUES (?, ?, ?, ?)', [child.id, row.id, child.destination, child.value]);
    }
  } finally { await db.end(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
