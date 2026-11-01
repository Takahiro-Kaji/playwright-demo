/** 処理に関係するテーブルのスコープ内全行を、不変確認用に取得する。 */
import type { DatabaseSync } from "node:sqlite";
import { validateScope } from "../../../demo/sales/db.ts";

export type SnapshotTarget = { kind: "order" | "sync" };

/**
 * 受注は商品・在庫・受注、同期は商品・在庫・同期世代を取得する。
 * どちらもscope内の全行を比較する。受注対象以外の商品への意図しない更新も検出する。
 * scopeはテストデータの所有範囲を示す必須値。処理ごとの商品コード指定は行わない。
 * 追加・削除も比較できるよう、関連行はJOINせず個別に読む。
 * 同一読取トランザクションの結果を操作前後で比較するためのもので、固定期待値の代わりではない。
 * 対象外のテーブル・行の不変は保証しない。実プロダクトでは処理の更新先・関連に合わせて範囲を定義する。
 */
export function snapshotSales(
  db: DatabaseSync,
  scope: string,
  target: SnapshotTarget,
) {
  validateScope(scope);
  if (!scope) throw Error("SNAPSHOT_SCOPE_REQUIRED");
  const where = "product_code GLOB ?";
  const args = [scope + "*"];
  db.exec("BEGIN");
  try {
    const products = db
      .prepare(
        `SELECT product_code,name,price,active,version FROM products WHERE ${where} ORDER BY product_code`,
      )
      .all(...args);
    const inventory = db
      .prepare(
        `SELECT product_code,quantity FROM inventory WHERE ${where} ORDER BY product_code`,
      )
      .all(...args);
    const snapshot =
      target.kind === "order"
        ? {
            products,
            inventory,
            orders: db
              .prepare(
                `SELECT order_id,product_code,quantity,unit_price,status FROM orders WHERE ${where} ORDER BY order_id`,
              )
              .all(...args),
          }
        : {
            products,
            inventory,
            syncState: db
              .prepare(
                "SELECT scope,catalog_version FROM sales_sync_scopes WHERE scope=?",
              )
              .all(scope),
          };
    db.exec("COMMIT");
    return snapshot;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
