// 使い捨てのローカルMySQLに対し、Unixソケット経由で明示的に実行する。
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { syncSales, orderSales } from '../sales/db.ts';
import { acquireTestLock, releaseTestLock } from '../../tests/aws-sales/database/test-lock.ts';
import { compareMysql, snapshotMysql } from '../../tests/aws-sales/database/rows.ts';
import { salesFixture } from '../../tests/aws-sales/upstream/fixtures.ts';

const socketPath = process.env.TEST_MYSQL_SOCKET;
if (!socketPath || !socketPath.startsWith('/tmp/')) throw Error('TEST_MYSQL_LOCAL_SOCKET_REQUIRED');

test('MySQLのトランザクション・全件照合・差分注入・復元を確認する', async () => {
  const database = `sales_qa_${randomBytes(12).toString('hex')}`;
  const admin = await mysql.createConnection({socketPath, user:'root'});
  let pool: mysql.Pool | undefined;
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    created = true;
    pool = mysql.createPool({socketPath,user:'root',database,connectionLimit:4,multipleStatements:true});
    await pool.query(readFileSync('aws/sales/schema.sql','utf8'));
    const lock = await acquireTestLock(pool);
    try {
      await syncSales(pool,salesFixture('f1'));
      const expected = {products:salesFixture('f1').products.map(p => ({...p,version:1})),deleted:[],catalogVersion:1,orders:[]};
      assert.deepEqual(await compareMysql(pool,expected), []);
      const before = await snapshotMysql(pool);
      await pool.query('UPDATE products SET name=? WHERE product_code=?',['誤名称','P001']);
      assert.ok((await compareMysql(pool,expected)).some(x => x.startsWith('product:value:')));
      await pool.query('UPDATE products SET name=? WHERE product_code=?',['ペン','P001']);
      await pool.query('UPDATE sync_state SET catalog_version=2 WHERE id=1');
      assert.ok((await compareMysql(pool,expected)).includes('sync_state:value'));
      await pool.query('UPDATE sync_state SET catalog_version=1 WHERE id=1');
      await pool.query("INSERT INTO products VALUES ('EXTRA','extra',10,1,1)");
      assert.ok((await compareMysql(pool,expected)).some(x => x.startsWith('product:extra:')));
      await pool.query("DELETE FROM products WHERE product_code='EXTRA'");
      await assert.rejects(syncSales(pool,{catalogVersion:2,products:[{...salesFixture('f1').products[0],price:-1}]}));
      assert.deepEqual(await snapshotMysql(pool),before);
      await pool.query('DELETE FROM inventory WHERE product_code=?',['P001']);
      assert.ok((await compareMysql(pool,expected)).some(x => x.startsWith('inventory:')));
      const rejection = await orderSales(pool,{productCode:'P001',quantity:1,version:1});
      assert.deepEqual(rejection,{status:409,body:{error:'INCONSISTENT_DATA'}});
      await pool.query('INSERT INTO inventory(product_code,quantity) VALUES (?,?)',['P001',5]);
      assert.deepEqual(await snapshotMysql(pool),before);
      await pool.query('UPDATE products SET version=2 WHERE product_code=?',['P001']);
      assert.ok((await compareMysql(pool,expected)).some(x => x.startsWith('product:version:')));
      await pool.query('UPDATE products SET version=1 WHERE product_code=?',['P001']);
      const order = await orderSales(pool,{productCode:'P001',quantity:1,version:1});
      assert.equal(order.status,201);
      assert.equal((await orderSales(pool,{productCode:'P001',quantity:1,version:1})).status,409);
      assert.equal((await snapshotMysql(pool)).orders.length,1);
    } finally { await releaseTestLock(lock); }
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
