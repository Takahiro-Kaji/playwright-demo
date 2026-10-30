'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildReadOnlySql, countCreatedItems } = require('../helpers/mysql.cjs');

const KEY = 'it-12345678-1234-1234-1234-123456789abc';

test('MySQL SQL uses a safe hex value and read-only transaction', () => {
  const sql = buildReadOnlySql(KEY);
  assert.match(sql, /SET @test_key = CONVERT\(0x[0-9a-f]+ USING utf8mb4\);/);
  assert.match(sql, /START TRANSACTION READ ONLY;/);
  assert.match(sql, /WHERE test_key = @test_key/);
  assert.doesNotMatch(sql, /it-12345678/);
  assert.throws(() => buildReadOnlySql("it-bad';DROP TABLE items;--"), /Invalid/);
});

test('MySQL CLI is invoked with a protected credential file, not a password argument', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysql-it-'));
  const optionsFile = path.join(dir, 'private.cnf');
  fs.writeFileSync(optionsFile, '[client]\npassword="placeholder"\n');
  fs.chmodSync(optionsFile, 0o600);
  const keys = ['MYSQL_OPTIONS_FILE', 'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_DATABASE', 'MYSQL_USER'];
  const old = Object.fromEntries(keys.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    MYSQL_OPTIONS_FILE: optionsFile,
    MYSQL_HOST: 'db.example.test',
    MYSQL_PORT: '3306',
    MYSQL_DATABASE: 'example_app',
    MYSQL_USER: 'readonly',
  });
  try {
    const count = await countCreatedItems(KEY, async (command, args, opts) => {
      assert.equal(command, 'mysql');
      assert.equal(args[0], `--defaults-file=${optionsFile}`);
      assert.deepEqual(args.slice(-8), [
        '--host', 'db.example.test', '--port', '3306',
        '--user', 'readonly', '--database', 'example_app',
      ]);
      assert.ok(!args.some((arg) => arg.includes('password')));
      assert.match(opts.input, /START TRANSACTION READ ONLY;/);
      return { stdout: '1', stderr: '' };
    });
    assert.equal(count, 1);
  } finally {
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
