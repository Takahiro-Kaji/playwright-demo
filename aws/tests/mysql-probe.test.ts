// Disposable local MySQL + binary exec relay; AWS/ALB checks are mocked explicitly.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { fixture } from '../../tests/verification/aws-sales/fixtures.ts';
import { saveJournal, type Journal } from '../../tests/aws-sales/environment.ts';
import { Environment } from '../../tests/aws-sales/lifecycle.ts';
import { withProbeDatabase } from './probe-database.ts';
import { probeOrder } from './order-probe.ts';

const socket = process.env.TEST_MYSQL_SOCKET, ca = process.env.TEST_MYSQL_CA;
if (!socket?.startsWith('/tmp/') || !ca?.startsWith('/tmp/')) throw Error('LOCAL_MYSQL_TLS_SETTINGS_REQUIRED');

test('SSO probe uses dedicated user/schema over TLS exec relay and restores actual SQL rows', async () => {
  const f = fixture(), j = f.j;
  const admin = await mysql.createConnection({socketPath:socket, user:'root', multipleStatements:true});
  const oldPath = process.env.PATH, oldSocket = process.env.FAKE_MYSQL_SOCKET;
  let madeDb = false, madeUser = false;
  try {
    j.config.dbHost = 'good.example.rds.amazonaws.com';
    writeFileSync(j.config.caFile, readFileSync(ca));
    Object.assign(j, {phase:'prepared', dbCreated:true, dbOwned:true, userCreated:true});
    saveJournal(f.file, j);
    await admin.query(`CREATE DATABASE \`${j.database}\``); madeDb = true;
    await admin.query(`USE \`${j.database}\``);
    await admin.query(readFileSync('aws/sales/schema.sql','utf8'));
    await admin.query('CREATE TABLE aws_test_owner (id INT PRIMARY KEY,run_id CHAR(32),owner_token CHAR(48))');
    await admin.execute('INSERT INTO aws_test_owner VALUES (1,?,?)', [j.runId,j.owner]);
    await admin.query(`CREATE USER '${j.user}'@'%' IDENTIFIED BY '${j.password}' REQUIRE SSL`); madeUser = true;
    for (const table of ['products','inventory','orders','sync_state','sales_lock'])
      await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON \`${j.database}\`.${table} TO '${j.user}'@'%'`);
    await admin.query(`GRANT SELECT ON \`${j.database}\`.aws_test_owner TO '${j.user}'@'%'`);
    const bin = join(f.dir,'kubectl');
    writeFileSync(bin, `#!${process.execPath}\nconst s=require('node:net').connect(process.env.FAKE_MYSQL_SOCKET);process.stdin.pipe(s).pipe(process.stdout);s.on('close',()=>process.stdin.destroy());s.on('error',()=>process.exit(1));\n`);
    chmodSync(bin,0o700); process.env.PATH=f.dir; process.env.FAKE_MYSQL_SOCKET=socket;
    const create = (file: string, journal: Journal) => {
      const env = new Environment(file,journal);
      env.verifyTarget = async () => {}; // AWS/ALB cannot be established locally.
      env.bridge = async () => ({}); // fake kubectl only replaces transport.
      return env;
    };
    const target = {target:j.config.url,expected:j.config.url,state:j.config.stateFile,selector:'#refresh',cognitoDomain:'test.auth.ap-northeast-1.amazoncognito.com'};
    await withProbeDatabase(f.file,target,async db => {
      const [tls] = await db.query<any[]>("SHOW STATUS LIKE 'Ssl_cipher'");
      assert.ok(tls[0].Value);
      await probeOrder(db,async () => {});
      await assert.rejects(probeOrder(db,async code => {
        await db.execute("INSERT INTO orders VALUES (UUID(),?,1,1,'accepted')",[code]);
        throw Error('lost HTTP response');
      }), /UNAUTHORIZED_ORDER_CREATED/);
      for (const table of ['products','inventory','orders']) {
        const [rows] = await db.query<any[]>(`SELECT COUNT(*) AS n FROM ${table}`);
        assert.equal(rows[0].n,0);
      }
      await assert.rejects(probeOrder(db,async () => {
        await db.query('INSERT INTO sync_state VALUES (1,2)');
      }), /CLEANUP_FAILED/); // all-table comparison catches non-probe changes.
      await db.query('DELETE FROM sync_state');
    },create);
    await admin.query(`REVOKE SELECT ON \`${j.database}\`.aws_test_owner FROM '${j.user}'@'%'`);
    await assert.rejects(withProbeDatabase(f.file,target,async () => assert.fail('permission failure must precede probe'),create));
    await admin.query(`GRANT SELECT ON \`${j.database}\`.aws_test_owner TO '${j.user}'@'%'`);
    j.config.dbHost = 'wrong.example.rds.amazonaws.com'; saveJournal(f.file,j);
    await assert.rejects(withProbeDatabase(f.file,target,async () => assert.fail('TLS mismatch must precede probe'),create));
  } finally {
    process.env.PATH=oldPath;
    if (oldSocket === undefined) delete process.env.FAKE_MYSQL_SOCKET; else process.env.FAKE_MYSQL_SOCKET=oldSocket;
    try { if (madeUser) await admin.query(`DROP USER '${j.user}'@'%'`); }
    finally { try { if (madeDb) await admin.query(`DROP DATABASE \`${j.database}\``); }
      finally { await admin.end(); f.close(); } }
  }
});
