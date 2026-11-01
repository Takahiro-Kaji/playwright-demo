import { test, expect } from '@playwright/test';
import { harness } from '../../targets/sales/harness.ts';
import { compareCatalog } from '../../targets/sales/compare.ts';
import { DatabaseSync } from 'node:sqlite';

const expected=[{productCode:'P001',name:'ペン',price:120,active:true,quantity:5},{productCode:'P002',name:'ノート',price:300,active:true,quantity:2}];
test('batch real learning HTTP matches all rows', async () => {
  const h=await harness('upstream');
  try {
    await test.step('Given: 上流fixtureを実HTTPで確認', async () => {
      const upstream=await fetch(h.upstream+'/catalog'); expect(upstream.status).toBe(200);
      expect((await upstream.json()).products).toEqual(expected);
    });
    await test.step('When: 同期バッチを実行', async () => {expect(await h.batch()).toBe(0);});
    await test.step('Then: SQL取得から全件照合', async () => {
      const db=new DatabaseSync(h.db);try {expect(compareCatalog(db,expected)).toEqual([]);}finally{db.close();}
      expect(h.query('SELECT * FROM inventory')).toHaveLength(2);
    });
  } finally {await test.step('After: プロセス回収', async () => {try { await h.cleanup(); } catch (error) { expect.soft(String(error), 'After失敗').toBe(''); }});}
});

test('batch mock failure leaves all state unchanged', async () => {
  const h=await harness('mock');let old:number|undefined;let before:unknown,stock:unknown,state:unknown;
  try {
    await test.step('Given: F1と503応答', async () => {
      expect(await h.batch()).toBe(0);before=h.query('SELECT * FROM products ORDER BY product_code');
      stock=h.query('SELECT * FROM inventory ORDER BY product_code');state=h.query('SELECT * FROM sync_state');
      old=await h.status();expect(await h.status(503)).toBe(503);expect((await fetch(h.upstream+'/catalog')).status).toBe(503);
    });
    await test.step('When: 同期を実行', async () => {expect(await h.batch()).not.toBe(0);});
    await test.step('Then: DB全体が不変', async () => {
      expect(h.query('SELECT * FROM products ORDER BY product_code')).toEqual(before);
      expect(h.query('SELECT * FROM inventory ORDER BY product_code')).toEqual(stock);
      expect(h.query('SELECT * FROM sync_state')).toEqual(state);expect(h.query('SELECT * FROM orders')).toEqual([]);
    });
  } finally {
    await test.step('After: モック復元とプロセス回収', async () => {
      const errors:unknown[]=[];
      if(old!==undefined) try {expect(await h.status(old)).toBe(old);expect((await fetch(h.upstream+'/catalog')).status).toBe(old);}catch(e){errors.push(e);}
      try {await h.cleanup(errors.length > 0);}catch(e){errors.push(e);}
      expect.soft(errors.map(String), 'After失敗').toEqual([]);
    });
  }
});
