import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { salesFixture } from '../../aws-sales/fixture.ts';
import { compareSalesRows } from '../../targets/sales/compare.ts';

test('AWSの固定データに少量および3000件のカタログが含まれる', () => {
  assert.equal(salesFixture('f1').products[0].quantity, 5);
  assert.equal(salesFixture('f2').products[0].quantity, 3);
  assert.equal(salesFixture('bulk1').products.length, 3000);
  assert.equal(salesFixture('bulk2').products[2999].quantity, 3);
  assert.throws(() => salesFixture('unknown'));
});
test('AWSの照合で各テーブルの変更と余剰行を検出する', () => {
  const p = {productCode:'P001',name:'ペン',price:120,active:true,quantity:5,version:1};
  const expected = {products:[p],deleted:[],catalogVersion:1,orders:[]};
  const rows = {products:[{product_code:'P001',name:'ペン',price:120,active:1,version:1}],inventory:[{product_code:'P001',quantity:5}],sync:[{id:1,catalog_version:1}],orders:[]};
  assert.deepEqual(compareSalesRows(rows, expected), []);
  assert.ok(compareSalesRows({...rows, inventory:[]}, expected).length);
  assert.ok(compareSalesRows({...rows, products:[{...rows.products[0],version:2}]}, expected).length);
  assert.ok(compareSalesRows({...rows, sync:[]}, expected).length);
  assert.ok(compareSalesRows({...rows, orders:[{order_id:'extra',product_code:'P001'}]}, expected).length);
});
