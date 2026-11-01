import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Connection } from 'mysql2/promise';
import { probeOrder } from './order-probe.ts';

const code = 'sso-probe-00000000-0000-0000-0000-000000000001';
function fakeDb(failCleanup = false) {
  let product = false; let inventory = false; let orders = 0; let begun = 0;
  const db = {
    async query(options: {sql: string}) {
      const sql = options.sql;
      if (sql === 'START TRANSACTION') { begun++; return [[]]; }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') return [[]];
      if (sql.includes('sales_lock')) return [[{id:1}]];
      if (sql.includes('FROM orders')) return [orders ? [{order_id:'test'}] : []];
      if (sql.includes('FROM products')) return [product ? [{product_code:code}] : []];
      if (sql.includes('FROM inventory')) return [inventory ? [{product_code:code}] : []];
      throw Error('unexpected SQL');
    },
    async execute(options: {sql: string}) {
      const sql = options.sql;
      if (sql.startsWith('SELECT product_code')) return [product ? [{product_code:code}] : []];
      if (sql.startsWith('SELECT order_id')) return [orders ? [{order_id:'test'}] : []];
      if (sql.startsWith('INSERT INTO products')) product = true;
      else if (sql.startsWith('INSERT INTO inventory')) inventory = true;
      else if (sql.startsWith('DELETE FROM orders')) { if (failCleanup) throw Error('database failure'); orders = 0; }
      else if (sql.startsWith('DELETE FROM inventory')) inventory = false;
      else if (sql.startsWith('DELETE FROM products')) product = false;
      else throw Error('unexpected SQL');
      return [[]];
    },
  };
  return { db: db as unknown as Connection, addOrder() { orders++; }, status() { return {product, inventory, orders, begun}; } };
}

test('successful redirect removes fixture and compares DB', async () => {
  const f = fakeDb(); await probeOrder(f.db, async () => {}, () => code);
  assert.deepEqual(f.status(), {product:false, inventory:false, orders:0, begun:2});
});
test('created order and lost response are removed even on failure', async () => {
  const f = fakeDb(); await assert.rejects(probeOrder(f.db, async () => { f.addOrder(); throw Error('lost response'); }, () => code), /UNAUTHORIZED_ORDER_CREATED/);
  assert.deepEqual(f.status(), {product:false, inventory:false, orders:0, begun:2});
});
test('order despite redirect is detected and removed', async () => {
  const f = fakeDb(); await assert.rejects(probeOrder(f.db, async () => { f.addOrder(); }, () => code), /UNAUTHORIZED_ORDER_CREATED/);
  assert.deepEqual(f.status(), {product:false, inventory:false, orders:0, begun:2});
});
test('probe and cleanup failures remain distinguishable', async () => {
  const f = fakeDb(true); await assert.rejects(probeOrder(f.db, async () => { throw Error('failure'); }, () => code), (e: Error) => e instanceof AggregateError && e.message === 'PROBE_AND_CLEANUP_FAILED' && e.errors.length === 2);
});
