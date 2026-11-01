import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { syncSales, orderSales, products } from '../sales/db.ts';

const port = Number(process.env.TEST_MYSQL_PORT);
if (!port) throw Error('TEST_MYSQL_PORT_REQUIRED');
test('sync and competing orders use shared transactional data', async () => {
  const pool = mysql.createPool({host:'127.0.0.1',port,user:'root',password:'local-test-only',database:'integration_demo',connectionLimit:4, multipleStatements:true});
  try {
    await pool.query(readFileSync('aws/sales/schema.sql','utf8'));
    const fixture = {catalogVersion:1,products:[{productCode:'P001',name:'ペン',price:120,active:true,quantity:1}]};
    assert.equal((await syncSales(pool,fixture)).count,1);
    assert.equal((await products(pool)).status,200);
    const result = await Promise.all([orderSales(pool,{productCode:'P001',quantity:1,version:1}),orderSales(pool,{productCode:'P001',quantity:1,version:1})]);
    assert.deepEqual(result.map(x=>x.status).sort(),[201,409]);
    const [orders] = await pool.query<any[]>('SELECT * FROM orders');
    assert.equal(orders.length,1);
    assert.equal((await orderSales(pool,{})).status,400);
    await assert.rejects(syncSales(pool,{catalogVersion:2,products:[{...fixture.products[0],price:-1}]}));
    const [rows] = await pool.query<any[]>('SELECT quantity FROM inventory WHERE product_code=?',['P001']);
    assert.equal(rows[0].quantity,0);
  } finally { await pool.end(); }
});
