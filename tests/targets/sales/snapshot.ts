/** 不変確認用に4表を一貫して取得する。snapshotSalesのトランザクションを読む。 */
import type { DatabaseSync } from "node:sqlite";
/** Snapshot every column of the four demo tables in one consistent read transaction. */
/**
 * 同じ読取トランザクションで4表全列を取得する。dbは接続、戻り値は表ごとの行。
 * SQL失敗時はROLLBACKして例外を再送出する。固定の正解ではなく、操作前後の不変確認に使う。
 */
export function snapshotSales(db: DatabaseSync) {
  db.exec("BEGIN");
  try {
    const snapshot = {
      products: db
        .prepare("SELECT * FROM products ORDER BY product_code")
        .all(),
      inventory: db
        .prepare("SELECT * FROM inventory ORDER BY product_code")
        .all(),
      syncState: db.prepare("SELECT * FROM sync_state ORDER BY id").all(),
      orders: db.prepare("SELECT * FROM orders ORDER BY order_id").all(),
    };
    db.exec("COMMIT");
    return snapshot;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
