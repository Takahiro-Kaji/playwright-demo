// Uses a disposable local MySQL and a fake kubectl that forwards stdin/stdout
// to its Unix socket. No Kubernetes or AWS access is performed by this test.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdtempSync,writeFileSync,chmodSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { createTunnelPool } from '../../tests/aws-sales/mysql-tunnel.ts';
const socket=process.env.TEST_MYSQL_SOCKET, ca=process.env.TEST_MYSQL_CA;
if (!socket?.startsWith('/tmp/') || !ca?.startsWith('/tmp/')) throw Error('LOCAL_MYSQL_TLS_SETTINGS_REQUIRED');
test('バイナリのexecトンネルでTLS接続先を検証してSQLを実行する',async()=>{
  const id=randomBytes(16).toString('hex');
  const user=`st${id.slice(0,16)}`, database=`sales_test_${id}`;
  const admin=await mysql.createConnection({socketPath:socket,user:'root'});
  const dir=mkdtempSync(join(tmpdir(),'sales-tunnel-sql-'));
  let madeDb=false, madeUser=false;
  const oldPath=process.env.PATH, oldSocket=process.env.FAKE_MYSQL_SOCKET;
  try {
    await admin.query(`CREATE DATABASE \`${database}\``); madeDb=true;
    await admin.query(`CREATE USER '${user}'@'localhost' IDENTIFIED BY 'local-only'`); madeUser=true;
    await admin.query(`GRANT ALL ON \`${database}\`.* TO '${user}'@'localhost'`);
    const bin=join(dir,'kubectl');
    writeFileSync(bin,`#!${process.execPath}\nconst s=require('node:net').connect(process.env.FAKE_MYSQL_SOCKET); process.stdin.pipe(s).pipe(process.stdout); s.on('close',()=>process.stdin.destroy()); s.on('error',()=>process.exit(1));\n`);
    chmodSync(bin,0o700);
    process.env.PATH=dir; process.env.FAKE_MYSQL_SOCKET=socket;
    const config={runId:id,context:'test',pod:'sales-app-123abc-abc12',dbHost:'db.region.rds.amazonaws.com',dbUser:user,dbPassword:'local-only',caFile:ca};
    const pool=createTunnelPool(config);
    try {
      const [rows]=await pool.query<any[]>('SELECT DATABASE() AS db');
      assert.equal(rows[0].db,database);
      const [ssl]=await pool.query<any[]>("SHOW STATUS LIKE 'Ssl_cipher'");
      assert.ok(ssl[0].Value);
    } finally {await pool.end();}
    const wrong=createTunnelPool({...config,dbHost:'wrong.region.rds.amazonaws.com'});
    try {await assert.rejects(wrong.getConnection(),{code:'HANDSHAKE_SSL_ERROR',message:/Hostname\/IP does not match/});} finally {await wrong.end();}
  } finally {
    process.env.PATH=oldPath; if (oldSocket === undefined) delete process.env.FAKE_MYSQL_SOCKET; else process.env.FAKE_MYSQL_SOCKET=oldSocket;
    try {if(madeUser) await admin.query(`DROP USER '${user}'@'localhost'`);} finally {
      try {if(madeDb) await admin.query(`DROP DATABASE \`${database}\``);} finally {await admin.end(); rmSync(dir,{recursive:true,force:true});}
    }
  }
});
