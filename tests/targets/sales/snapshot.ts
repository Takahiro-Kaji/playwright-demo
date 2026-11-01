/** 不変確認用に4表を一貫して取得する。snapshotSalesのトランザクションを読む。 */
import type { DatabaseSync } from "node:sqlite";
/** Snapshot every column of the four demo tables in one consistent read transaction. */
/**
 * 同じ読取トランザクションで4表全列を取得する。dbは接続、戻り値は表ごとの行。
 * SQL失敗時はROLLBACKして例外を再送出する。固定の正解ではなく、操作前後の不変確認に使う。
 */
export function snapshotSales(db: DatabaseSync, scope = "") {
  db.exec("BEGIN");
  try {
    const snapshot = {
      products: db
        .prepare(
          "SELECT * FROM products WHERE product_code GLOB ? ORDER BY product_code",
        )
        .all(scope + "*"),
      inventory: db
        .prepare(
          "SELECT * FROM inventory WHERE product_code GLOB ? ORDER BY product_code",
        )
        .all(scope + "*"),
      syncState: scope
        ? db
            .prepare(
              "SELECT 1 AS id,catalog_version FROM sales_sync_scopes WHERE scope=?",
            )
            .all(scope)
        : db.prepare("SELECT * FROM sync_state ORDER BY id").all(),
      orders: scope
        ? db
            .prepare(
              "SELECT * FROM orders WHERE product_code GLOB ? ORDER BY order_id",
            )
            .all(scope + "*")
        : db.prepare("SELECT * FROM orders ORDER BY order_id").all(),
    };
    db.exec("COMMIT");
    return snapshot;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
