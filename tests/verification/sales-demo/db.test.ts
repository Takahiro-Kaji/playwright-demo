import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDb, sync, order, validateCatalog } from '../../../demo/sales/db.ts';
import { fixture } from '../../../demo/sales/server.ts';
test('sync and order enforce atomic version and relationship', () => {
 const dir=`.local/sales-learning/${randomUUID()}`;mkdirSync(dir,{recursive:true});const db=openDb(`${dir}/sales.sqlite`);
 try {sync(db,fixture);assert.equal(order(db,{productCode:'P001',quantity:1,version:1}).status,201);assert.deepEqual(db.prepare('SELECT quantity FROM inventory WHERE product_code=?').get('P001'),Object.assign(Object.create(null),{quantity:4}));assert.deepEqual(order(db,{productCode:'P001',quantity:1,version:1}).body,{error:'STALE_VERSION'});db.prepare('DELETE FROM inventory WHERE product_code=?').run('P002');assert.deepEqual(order(db,{productCode:'P002',quantity:1,version:1}).body,{error:'INCONSISTENT_DATA'});assert.equal((db.prepare('SELECT COUNT(*) AS n FROM orders').get() as any).n,1);assert.throws(()=>sync(db,fixture));assert.throws(()=>validateCatalog({catalogVersion:1,products:[fixture.products[0],fixture.products[0]]}));} finally {db.close();rmSync(dir,{recursive:true,force:true});}
});
