import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql, { type Connection } from 'mysql2/promise';

const query = (db: Connection, sql: string) => db.query({ sql, timeout: 10_000 });
const execute = (db: Connection, sql: string, values: string[]) => db.execute({ sql, timeout: 10_000 }, values);

async function locked<T>(db: Connection, action: () => Promise<T>) {
  await query(db, 'START TRANSACTION');
  try {
    const [rows] = await query(db, 'SELECT id FROM sales_lock WHERE id=1 FOR UPDATE');
    if (!Array.isArray(rows) || rows.length !== 1) throw Error('LOCK_UNAVAILABLE');
    const result = await action(); await query(db, 'COMMIT'); return result;
  } catch (e) { try { await query(db, 'ROLLBACK'); } catch {} throw e; }
}

async function snapshot(db: Connection) {
  const [orders] = await query(db, 'SELECT order_id,product_code,quantity,unit_price,status FROM orders ORDER BY order_id');
  const [products] = await query(db, 'SELECT product_code,name,price,active,version FROM products ORDER BY product_code');
  const [inventory] = await query(db, 'SELECT product_code,quantity FROM inventory ORDER BY product_code');
  return JSON.stringify({ orders, products, inventory });
}

/** Dedicated row, with restoration even if a POST succeeds but its response is lost. */
export async function probeOrder(db: Connection, post: (code: string) => Promise<void>, makeCode = () => `sso-probe-${randomUUID()}`) {
  const code = makeCode();
  if (!/^sso-probe-[a-f0-9-]{36}$/.test(code)) throw Error('INVALID_PROBE_CODE');
  console.log(`SSO_PROBE_ID=${code}`);
  let before = ''; let prepared = false; let unexpectedOrder = false; let primaryFailure: unknown; let cleanupFailure: unknown;
  try {
    await locked(db, async () => {
      before = await snapshot(db);
      const [found] = await execute(db, 'SELECT product_code FROM products WHERE product_code=?', [code]);
      if (!Array.isArray(found) || found.length) throw Error('PROBE_COLLISION');
      prepared = true;
      await execute(db, 'INSERT INTO products (product_code,name,price,active,version) VALUES (?, ?, 1, 1, 1)', [code, 'SSO test fixture']);
      await execute(db, 'INSERT INTO inventory (product_code,quantity) VALUES (?,1)', [code]);
    });
    await post(code);
  } catch (e) { primaryFailure = e; }
  finally {
    if (prepared) {
      try {
        const after = await locked(db, async () => {
          const [orders] = await execute(db, 'SELECT order_id FROM orders WHERE product_code=?', [code]);
          if (!Array.isArray(orders)) throw Error('ORDER_CHECK_FAILED');
          unexpectedOrder = orders.length > 0;
          await execute(db, 'DELETE FROM orders WHERE product_code=?', [code]);
          await execute(db, 'DELETE FROM inventory WHERE product_code=?', [code]);
          await execute(db, 'DELETE FROM products WHERE product_code=?', [code]);
          return snapshot(db);
        });
        if (after !== before) throw Error('DATABASE_NOT_RESTORED');
      } catch (e) { cleanupFailure = e; }
    }
  }
  const probeError = unexpectedOrder ? 'UNAUTHORIZED_ORDER_CREATED' : primaryFailure ? 'PROBE_FAILED' : '';
  if (probeError && cleanupFailure) throw new AggregateError([new Error(probeError), new Error('CLEANUP_FAILED')], 'PROBE_AND_CLEANUP_FAILED');
  if (cleanupFailure) throw Error('CLEANUP_FAILED');
  if (probeError) throw Error(probeError);
}

export async function openProbeDatabase(env: NodeJS.ProcessEnv = process.env) {
  const { AWS_SSO_DB_HOST: host, AWS_SSO_DB_USER: user, AWS_SSO_DB_PASSWORD: password, AWS_SSO_DB_CA_FILE: ca } = env;
  if (!host || !user || !password || !ca || !/^[a-z0-9.-]+\.rds\.amazonaws\.com$/.test(host)) throw Error('PROBE_DB_CONFIG_REQUIRED');
  const db = await mysql.createConnection({ host, user, password, database: 'integration_demo', ssl: { ca: readFileSync(ca), rejectUnauthorized: true }, connectTimeout: 7000 });
  try { await query(db, 'SET SESSION innodb_lock_wait_timeout = 10'); return db; }
  catch { await db.end(); throw Error('PROBE_DB_CONFIG_FAILED'); }
}
