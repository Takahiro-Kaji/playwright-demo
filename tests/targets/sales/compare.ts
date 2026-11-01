/** DB全行と事前に決めた期待状態を照合する。ExpectedState、SELECT、キーごとの比較の順に読む。 */
import type { DatabaseSync } from "node:sqlite";

export type ExpectedProduct = {
  productCode: string;
  name: string;
  price: number;
  active: boolean;
  quantity: number;
  version: number;
};
export type ExpectedOrder = {
  order_id: string;
  product_code: string;
  quantity: number;
  unit_price: number;
  status: string;
};
export type ExpectedState = {
  products: ExpectedProduct[];
  // Explicitly allowed retained deletion rows, including all values and zero stock.
  deleted: ExpectedProduct[];
  catalogVersion: number;
  orders: ExpectedOrder[];
};

/**
 * 独立SELECTした全行を固定期待値と比較する。dbは接続、expectedは操作前に決めた期待状態。
 * 差分名の配列を返し、一致なら空配列。不正な削除期待やSQLエラーは例外。
 */
export function compareCatalog(
  db: DatabaseSync,
  expected: ExpectedState,
  scope = "",
): string[] {
  const products = db
    .prepare(
      "SELECT product_code,name,price,active,version FROM products WHERE product_code GLOB ?",
    )
    .all(scope + "*") as any[];
  const inventory = db
    .prepare(
      "SELECT product_code,quantity FROM inventory WHERE product_code GLOB ?",
    )
    .all(scope + "*") as any[];
  const sync = scope
    ? db
        .prepare(
          "SELECT 1 AS id,catalog_version FROM sales_sync_scopes WHERE scope=?",
        )
        .all(scope)
    : db.prepare("SELECT id,catalog_version FROM sync_state").all();
  const orders = db
    .prepare(
      "SELECT order_id,product_code,quantity,unit_price,status FROM orders WHERE product_code GLOB ?",
    )
    .all(scope + "*") as any[];
  return compareSalesRows({ products, inventory, sync, orders }, expected);
}

/** Compare independently retrieved rows, including every key and every persisted value. */
export function compareSalesRows(
  {
    products,
    inventory,
    sync,
    orders,
  }: { products: any[]; inventory: any[]; sync: any[]; orders: any[] },
  expected: ExpectedState,
): string[] {
  const differences: string[] = [];
  const allExpected = [...expected.products, ...expected.deleted];
  if (expected.deleted.some((p) => p.active || p.quantity !== 0))
    throw Error("INVALID_DELETION_EXPECTATION");
  // キーをMap化する前に重複を記録する。商品と在庫を別々に読むことで孤立行も見落とさない。
  const index = (rows: any[], key: string, label: string) => {
    const map = new Map<string, any>();
    for (const row of rows) {
      if (map.has(row[key])) differences.push(`${label}:duplicate:${row[key]}`);
      else map.set(row[key], row);
    }
    return map;
  };
  const want = index(allExpected, "productCode", "expected");
  const ps = index(products, "product_code", "product");
  const inv = index(inventory, "product_code", "inventory");
  if (products.length !== allExpected.length) differences.push("product:count");
  if (inventory.length !== allExpected.length)
    differences.push("inventory:count");
  for (const p of allExpected) {
    const row = ps.get(p.productCode),
      stock = inv.get(p.productCode);
    if (!row) differences.push(`product:missing:${p.productCode}`);
    else {
      if (
        row.name !== p.name ||
        row.price !== p.price ||
        row.active !== Number(p.active)
      )
        differences.push(`product:value:${p.productCode}`);
      if (row.version !== p.version)
        differences.push(`product:version:${p.productCode}`);
    }
    if (!stock) differences.push(`inventory:missing:${p.productCode}`);
    else if (stock.quantity !== p.quantity)
      differences.push(`inventory:value:${p.productCode}`);
  }
  for (const [key] of ps)
    if (!want.has(key)) differences.push(`product:extra:${key}`);
  for (const [key] of inv)
    if (!ps.has(key)) differences.push(`inventory:orphan:${key}`);
  if (
    sync.length !== 1 ||
    sync[0].id !== 1 ||
    sync[0].catalog_version !== expected.catalogVersion
  )
    differences.push("sync_state:value");
  const actualOrders = index(orders, "order_id", "order");
  const wantOrders = index(expected.orders, "order_id", "expected-order");
  if (orders.length !== expected.orders.length) differences.push("order:count");
  for (const [key, order] of wantOrders) {
    const actual = actualOrders.get(key);
    if (!actual) differences.push(`order:missing:${key}`);
    else if (
      ["product_code", "quantity", "unit_price", "status"].some(
        (field) => actual[field] !== order[field],
      )
    )
      differences.push(`order:value:${key}`);
  }
  for (const [key, order] of actualOrders) {
    if (!wantOrders.has(key)) differences.push(`order:extra:${key}`);
    if (!ps.has(order.product_code)) differences.push(`order:orphan:${key}`);
  }
  return differences;
}
