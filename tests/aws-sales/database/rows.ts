import type { Pool, RowDataPacket } from "mysql2/promise";
import {
  compareSalesRows,
  type ExpectedState,
} from "../../targets/sales/compare.ts";

export async function snapshotMysql(pool: Pool) {
  const c = await pool.getConnection();
  try {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await c.beginTransaction();
    const [products] = await c.query<RowDataPacket[]>(
      "SELECT product_code,name,price,active,version FROM products ORDER BY product_code",
    );
    const [inventory] = await c.query<RowDataPacket[]>(
      "SELECT product_code,quantity FROM inventory ORDER BY product_code",
    );
    const [sync] = await c.query<RowDataPacket[]>(
      "SELECT id,catalog_version FROM sync_state ORDER BY id",
    );
    const [orders] = await c.query<RowDataPacket[]>(
      "SELECT order_id,product_code,quantity,unit_price,status FROM orders ORDER BY order_id",
    );
    await c.commit();
    // mysql2の行はRowDataPacketのプロトタイプを持つため、内容を比較できる形に正規化する。
    return JSON.parse(JSON.stringify({ products, inventory, sync, orders }));
  } catch (error) {
    await c.rollback();
    throw error;
  } finally {
    c.release();
  }
}
export async function compareMysql(pool: Pool, expected: ExpectedState) {
  return compareSalesRows(await snapshotMysql(pool), expected);
}
