import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { MAX, validateCatalog, type Catalog } from '../../demo/sales/db.ts';

type ProductRow = RowDataPacket & { product_code: string; name: string; price: number; active: number; version: number; quantity: number | null };
const integer = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= MAX;
async function transaction<T>(pool: Pool, fn: (c: PoolConnection) => Promise<T>): Promise<T> {
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    // Shared serialization point prevents sync and orders racing across regions.
    const [lock] = await c.query<RowDataPacket[]>('SELECT id FROM sales_lock WHERE id=1 FOR UPDATE');
    if (lock.length !== 1) throw Error('SCHEMA_NOT_INITIALIZED');
    const result = await fn(c);
    await c.commit();
    return result;
  } catch (e) { await c.rollback(); throw e; } finally { c.release(); }
}
export async function syncSales(pool: Pool, input: unknown) {
  const catalog: Catalog = validateCatalog(input);
  await transaction(pool, async c => {
    const [rows] = await c.query<ProductRow[]>('SELECT p.product_code,p.name,p.price,p.active,p.version,i.quantity FROM products p LEFT JOIN inventory i USING(product_code)');
    const existing = new Map(rows.map(r => [r.product_code, r]));
    const products = [...catalog.products];
    const present = new Set(products.map(p => p.productCode));
    for (const row of rows) if (!present.has(row.product_code)) products.push({ productCode: row.product_code, name: row.name, price: row.price, active: false, quantity: 0 });
    for (const p of products) {
      const old = existing.get(p.productCode);
      if (old && old.quantity === null) throw Error('INCONSISTENT_DATA');
      const changed = old && (old.name !== p.name || old.price !== p.price || old.active !== Number(p.active) || old.quantity !== p.quantity);
      const version = old ? old.version + Number(Boolean(changed)) : 1;
      if (version > MAX) throw Error('VERSION_OVERFLOW');
      await c.execute('INSERT INTO products (product_code,name,price,active,version) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),price=VALUES(price),active=VALUES(active),version=VALUES(version)', [p.productCode,p.name,p.price,Number(p.active),version]);
      await c.execute('INSERT INTO inventory (product_code,quantity) VALUES (?,?) ON DUPLICATE KEY UPDATE quantity=VALUES(quantity)', [p.productCode,p.quantity]);
    }
    await c.execute('INSERT INTO sync_state (id,catalog_version) VALUES (1,?) ON DUPLICATE KEY UPDATE catalog_version=VALUES(catalog_version)', [catalog.catalogVersion]);
  });
  return {status:'OK', catalogVersion:catalog.catalogVersion, count:catalog.products.length};
}
export async function products(pool: Pool) {
  const [rows] = await pool.query<ProductRow[]>('SELECT p.product_code AS productCode,p.name,p.price,i.quantity,p.version FROM products p LEFT JOIN inventory i USING(product_code) WHERE p.active=1 ORDER BY p.product_code');
  if (rows.some(r => r.quantity === null)) return {status:409, body:{error:'INCONSISTENT_DATA'}};
  return {status:200,body:{products:rows}};
}
export async function orderSales(pool: Pool, input: unknown) {
  if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'productCode,quantity,version') return {status:400,body:{error:'INVALID_REQUEST'}};
  const {productCode,quantity,version} = input as Record<string,unknown>;
  if (typeof productCode !== 'string' || !productCode || !integer(quantity,1) || !integer(version,1)) return {status:400,body:{error:'INVALID_REQUEST'}};
  return transaction(pool, async c => {
    const [rows] = await c.execute<ProductRow[]>('SELECT p.product_code,p.name,p.price,p.active,p.version,i.quantity FROM products p LEFT JOIN inventory i USING(product_code) WHERE p.product_code=?', [productCode]);
    const p = rows[0];
    const error = !p || p.quantity === null ? 'INCONSISTENT_DATA' : p.version !== version ? 'STALE_VERSION' : !p.active || p.quantity < quantity || p.version >= MAX ? 'ORDER_UNAVAILABLE' : null;
    if (error) return {status:409,body:{error}};
    const orderId = randomUUID();
    await c.execute("INSERT INTO orders (order_id,product_code,quantity,unit_price,status) VALUES (?,?,?,?,'CREATED')", [orderId,productCode,quantity,p.price]);
    await c.execute('UPDATE inventory SET quantity=quantity-? WHERE product_code=?',[quantity,productCode]);
    await c.execute('UPDATE products SET version=version+1 WHERE product_code=?',[productCode]);
    return {status:201,body:{orderId,productCode,quantity,unitPrice:p.price,status:'CREATED'}};
  });
}
