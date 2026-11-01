'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { runCommand } = require('./run-command.cjs');
const { required } = require('./kubernetes.cjs');

/**
 * mysql CLI has no equivalent of psql :'variable' binds. Encode the generated
 * test key as a hex literal, then use a session variable in a read-only transaction.
 * This avoids inserting user text into SQL syntax.
 */
function buildReadOnlySql(testKey, queryOverride) {
  if (typeof testKey !== 'string' || !/^it-[0-9a-f-]{36}$/.test(testKey)) {
    throw new Error('Invalid generated integration test key');
  }
  const hex = Buffer.from(testKey, 'utf8').toString('hex');
  const query = queryOverride || fs.readFileSync(path.join(__dirname, '../sql/verify_item.sql'), 'utf8').trim();
  return `SET @test_key = CONVERT(0x${hex} USING utf8mb4);\nSTART TRANSACTION READ ONLY;\n${query}\nCOMMIT;\n`;
}

async function query(testKey, queryOverride, run = runCommand) {
  const optionsFile = required('MYSQL_OPTIONS_FILE');
  const host = required('MYSQL_HOST');
  const database = required('MYSQL_DATABASE');
  const user = required('MYSQL_USER');
  const port = process.env.MYSQL_PORT || '3306';
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('MYSQL_PORT must be between 1 and 65535');
  }
  const stats = fs.statSync(optionsFile);
  if (!stats.isFile()) throw new Error('MYSQL_OPTIONS_FILE must reference a file');
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error('MYSQL_OPTIONS_FILE must be private (chmod 600)');
  }

  const { stdout } = await run('mysql', [
    `--defaults-file=${optionsFile}`, // Must be the first option to mysql.
    '--batch', '--silent', '--raw', '--skip-column-names',
    '--default-character-set=utf8mb4', '--connect-timeout=10',
    '--host', host, '--port', port, '--user', user, '--database', database,
  ], {
    input: buildReadOnlySql(testKey, queryOverride),
    timeoutMs: 15_000,
  });
  return stdout;
}

async function countCreatedItems(testKey, run = runCommand) {
  const stdout = await query(testKey, undefined, run);
  if (!/^\d+$/.test(stdout) || !Number.isSafeInteger(Number(stdout))) {
    throw new Error(`Unexpected MySQL count result: ${JSON.stringify(stdout)}`);
  }
  return Number(stdout);
}


async function snapshotItems(testKey, run = runCommand) {
  const sql = "SELECT JSON_OBJECT('id', CAST(id AS CHAR), 'testKey', test_key, 'status', status, 'createdAt', CAST(created_at AS CHAR)) FROM items WHERE test_key = @test_key ORDER BY id;";
  const stdout = await query(testKey, sql, run);
  return stdout ? stdout.split('\n').map((line) => JSON.parse(line)) : [];
}
module.exports = { buildReadOnlySql, countCreatedItems, snapshotItems };

