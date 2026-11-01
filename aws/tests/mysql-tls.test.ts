import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import mysql from 'mysql2/promise';
import { mysqlTls } from '../sales/tls.ts';

const socketPath = process.env.TEST_MYSQL_SOCKET;
const caFile = process.env.TEST_MYSQL_CA;
if (!socketPath?.startsWith('/tmp/') || !caFile?.startsWith('/tmp/')) throw Error('LOCAL_MYSQL_TLS_SETTINGS_REQUIRED');

test('MySQL TLS accepts matching endpoint name and rejects another name', async () => {
  const config = {socketPath,user:'root',ssl:mysqlTls(caFile)};
  const db = await mysql.createConnection({...config,host:'mysql-test.local'});
  try {
    const [rows] = await db.query<any[]>("SHOW STATUS LIKE 'Ssl_cipher'");
    assert.ok(rows[0]?.Value, 'connection must actually use TLS');
  } finally { await db.end(); }
  await assert.rejects(mysql.createConnection({...config,host:'wrong-name.local'}), { code:'HANDSHAKE_SSL_ERROR', message:/Hostname\/IP does not match/ });
});
