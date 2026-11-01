import type { DatabaseSync } from "node:sqlite";
/** Snapshot every column of the four demo tables in one consistent read transaction. */
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
