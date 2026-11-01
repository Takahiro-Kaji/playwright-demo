import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { compareSalesRows, type ExpectedState } from '../targets/sales/compare.ts';

// The advisory lock is shared by cooperative test runs in both regions. It does
// not exclude ordinary app traffic: the test environment must also be isolated.
export async function acquireTestLock(pool: Pool): Promise<PoolConnection> {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.query<RowDataPacket[]>("SELECT GET_LOCK('sales-aws-business-tests', 0) AS acquired");
    if (rows[0]?.acquired !== 1) throw Error('AWS_TEST_LOCK_UNAVAILABLE');
    return connection;
  } catch (error) {
    // GET_LOCK may have succeeded even when the response was lost. Never reuse it.
    try { connection.destroy(); } catch { /* preserve the acquisition error */ }
    throw error;
  }
}
export async function releaseTestLock(connection: PoolConnection) {
  try {
    const [rows] = await connection.query<RowDataPacket[]>("SELECT RELEASE_LOCK('sales-aws-business-tests') AS released");
    if (rows[0]?.released !== 1) throw Error('AWS_TEST_LOCK_LOST');
  } catch (error) {
    // A lost response does not establish that the server released the lock.
    try { connection.destroy(); } catch { /* preserve the release error */ }
    throw error;
  }
  connection.release();
}
export async function snapshotMysql(pool: Pool) {
  const c = await pool.getConnection();
  try {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await c.beginTransaction();
    const [products] = await c.query<RowDataPacket[]>('SELECT product_code,name,price,active,version FROM products ORDER BY product_code');
    const [inventory] = await c.query<RowDataPacket[]>('SELECT product_code,quantity FROM inventory ORDER BY product_code');
    const [sync] = await c.query<RowDataPacket[]>('SELECT id,catalog_version FROM sync_state ORDER BY id');
    const [orders] = await c.query<RowDataPacket[]>('SELECT order_id,product_code,quantity,unit_price,status FROM orders ORDER BY order_id');
    await c.commit();
    // mysql2 rows have RowDataPacket prototypes; normalize for deep comparisons.
    return JSON.parse(JSON.stringify({products,inventory,sync,orders}));
  } catch (error) { await c.rollback(); throw error; } finally { c.release(); }
}
export async function compareMysql(pool: Pool, expected: ExpectedState) {
  return compareSalesRows(await snapshotMysql(pool), expected);
}
