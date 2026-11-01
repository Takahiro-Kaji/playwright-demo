import { DatabaseSync } from 'node:sqlite';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX = 2147483647;
export type Product = { productCode: string; name: string; price: number; active: boolean; quantity: number };
export type Catalog = { catalogVersion: number; products: Product[] };
const integer = (n: unknown, min = 0): n is number => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= MAX;
const keys = (v: object, expected: string[]) => Object.keys(v).sort().join(',') === expected.sort().join(',');
export function validateCatalog(value: unknown): Catalog {
  if (!value || typeof value !== 'object' || !keys(value, ['catalogVersion','products'])) throw Error('INVALID_CATALOG');
  const c = value as Catalog;
  if (!integer(c.catalogVersion, 1) || !Array.isArray(c.products)) throw Error('INVALID_CATALOG');
  const seen = new Set<string>();
  for (const p of c.products) {
    if (!p || typeof p !== 'object' || !keys(p, ['productCode','name','price','active','quantity']) || typeof p.productCode !== 'string' || !p.productCode || typeof p.name !== 'string' || !p.name || !integer(p.price) || !integer(p.quantity) || typeof p.active !== 'boolean' || seen.has(p.productCode)) throw Error('INVALID_CATALOG');
    seen.add(p.productCode);
  }
  return c;
}
export function openDb(filename: string): DatabaseSync {
  const root = resolve(process.cwd(), '.local/sales-learning') + sep;
  if (!resolve(filename).startsWith(root) || !filename.endsWith('/sales.sqlite')) throw Error('INVALID_DB_PATH');
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS products(product_code TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,price INTEGER NOT NULL CHECK(price BETWEEN 0 AND 2147483647),active INTEGER NOT NULL CHECK(active IN (0,1)),version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2147483647));
  CREATE TABLE IF NOT EXISTS inventory(product_code TEXT PRIMARY KEY NOT NULL REFERENCES products(product_code),quantity INTEGER NOT NULL CHECK(quantity BETWEEN 0 AND 2147483647));
  CREATE TABLE IF NOT EXISTS orders(order_id TEXT PRIMARY KEY NOT NULL,product_code TEXT NOT NULL REFERENCES products(product_code),quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 2147483647),unit_price INTEGER NOT NULL CHECK(unit_price BETWEEN 0 AND 2147483647),status TEXT NOT NULL CHECK(status='CREATED'));
  CREATE TABLE IF NOT EXISTS sync_state(id INTEGER PRIMARY KEY CHECK(id=1),catalog_version INTEGER NOT NULL);`);
  return db;
}
export function sync(db: DatabaseSync, c: Catalog) {
  validateCatalog(c); db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT p.*, i.quantity FROM products p LEFT JOIN inventory i USING(product_code)').all() as any[];
    const codes = new Set(c.products.map(p => p.productCode));
    const save = (p: Product, old: any) => {
      if (old && old.quantity == null) throw Error('INCONSISTENT_DATA');
      const changed = old && (old.name !== p.name || old.price !== p.price || old.active !== Number(p.active) || old.quantity !== p.quantity);
      const version = old ? old.version + Number(Boolean(changed)) : 1;
      if (version > MAX) throw Error('VERSION_OVERFLOW');
      db.prepare('INSERT INTO products VALUES(?,?,?,?,?) ON CONFLICT(product_code) DO UPDATE SET name=excluded.name,price=excluded.price,active=excluded.active,version=excluded.version').run(p.productCode,p.name,p.price,Number(p.active),version);
      db.prepare('INSERT INTO inventory VALUES(?,?) ON CONFLICT(product_code) DO UPDATE SET quantity=excluded.quantity').run(p.productCode,p.quantity);
    };
    for (const p of c.products) save(p, existing.find(x => x.product_code === p.productCode));
    for (const p of existing) if (!codes.has(p.product_code)) save({productCode:p.product_code,name:p.name,price:p.price,active:false,quantity:0},p);
    db.prepare('INSERT INTO sync_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET catalog_version=excluded.catalog_version').run(c.catalogVersion);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function order(db: DatabaseSync, input: unknown) {
  if (!input || typeof input !== 'object' || !keys(input,['productCode','quantity','version'])) return {status:400, body:{error:'INVALID_REQUEST'}};
  const {productCode,quantity,version} = input as any;
  if (typeof productCode !== 'string' || !productCode || !integer(quantity,1) || !integer(version,1)) return {status:400,body:{error:'INVALID_REQUEST'}};
  db.exec('BEGIN IMMEDIATE');
  try {
    const p = db.prepare('SELECT p.*,i.quantity FROM products p LEFT JOIN inventory i USING(product_code) WHERE p.product_code=?').get(productCode) as any;
    let error = !p || p.quantity == null ? 'INCONSISTENT_DATA' : p.version !== version ? 'STALE_VERSION' : !p.active || p.quantity < quantity ? 'ORDER_UNAVAILABLE' : p.version >= MAX ? 'ORDER_UNAVAILABLE' : null;
    if (error) { db.exec('ROLLBACK'); return {status:409,body:{error}}; }
    const orderId = randomUUID();
    db.prepare("INSERT INTO orders VALUES(?,?,?,?, 'CREATED')").run(orderId,productCode,quantity,p.price);
    db.prepare('UPDATE inventory SET quantity=quantity-? WHERE product_code=?').run(quantity,productCode);
    db.prepare('UPDATE products SET version=version+1 WHERE product_code=?').run(productCode);
    db.exec('COMMIT'); return {status:201,body:{orderId,productCode,quantity,unitPrice:p.price,status:'CREATED'}};
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
