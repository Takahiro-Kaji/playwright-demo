/** デモの入力検証・同期・受注を実装する。型、validateCatalog、openDb、sync、orderの順に読む。 */
import { DatabaseSync } from "node:sqlite";
import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export const MAX = 2147483647;
export type Product = {
  productCode: string;
  name: string;
  price: number;
  active: boolean;
  quantity: number;
};
export type Catalog = { catalogVersion: number; products: Product[] };
const integer = (n: unknown, min = 0): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= min && n <= MAX;
const keys = (v: object, expected: string[]) =>
  Object.keys(v).sort().join(",") === expected.sort().join(",");
/**
 * 外部からのvalueを契約どおり検証しCatalogとして返す。不正な属性・範囲・重複は例外。
 */
export function validateCatalog(value: unknown): Catalog {
  if (
    !value ||
    typeof value !== "object" ||
    !keys(value, ["catalogVersion", "products"])
  )
    throw Error("INVALID_CATALOG");
  const c = value as Catalog;
  if (!integer(c.catalogVersion, 1) || !Array.isArray(c.products))
    throw Error("INVALID_CATALOG");
  const seen = new Set<string>();
  for (const p of c.products) {
    if (
      !p ||
      typeof p !== "object" ||
      !keys(p, ["productCode", "name", "price", "active", "quantity"]) ||
      typeof p.productCode !== "string" ||
      !p.productCode ||
      typeof p.name !== "string" ||
      !p.name ||
      !integer(p.price) ||
      !integer(p.quantity) ||
      typeof p.active !== "boolean" ||
      seen.has(p.productCode)
    )
      throw Error("INVALID_CATALOG");
    seen.add(p.productCode);
  }
  return c;
}
/**
 * 専用パスfilenameのSQLiteを開き必要な設定と表を用意して接続を返す。パス不正やDB失敗は例外。
 */
export function openDb(filename: string): DatabaseSync {
  const root = resolve(process.cwd(), ".local/sales-learning") + sep;
  if (
    !resolve(filename).startsWith(root) ||
    !filename.endsWith("/sales.sqlite")
  )
    throw Error("INVALID_DB_PATH");
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS products(product_code TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,price INTEGER NOT NULL CHECK(price BETWEEN 0 AND 2147483647),active INTEGER NOT NULL CHECK(active IN (0,1)),version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2147483647));
  CREATE TABLE IF NOT EXISTS inventory(product_code TEXT PRIMARY KEY NOT NULL REFERENCES products(product_code),quantity INTEGER NOT NULL CHECK(quantity BETWEEN 0 AND 2147483647));
  CREATE TABLE IF NOT EXISTS orders(order_id TEXT PRIMARY KEY NOT NULL,product_code TEXT NOT NULL REFERENCES products(product_code),quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 2147483647),unit_price INTEGER NOT NULL CHECK(unit_price BETWEEN 0 AND 2147483647),status TEXT NOT NULL CHECK(status='CREATED'));
  CREATE TABLE IF NOT EXISTS sales_sync_scopes(scope TEXT PRIMARY KEY NOT NULL,catalog_version INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sync_state(id INTEGER PRIMARY KEY CHECK(id=1),catalog_version INTEGER NOT NULL);`);
  return db;
}
/** スコープをSQLの接頭辞として使える形式に制限する。空文字は全体を対象とする。 */
export function validateScope(scope: string) {
  if (scope !== "" && !/^test-[a-f0-9-]+:$/.test(scope))
    throw Error("INVALID_SCOPE");
}

/**
 * 検証したcをdbに全量反映する。戻り値なし。不整合・桁あふれ・SQL失敗は例外。
 * 商品・在庫・同期世代を一つのトランザクションでCOMMITし、失敗時はROLLBACKする。
 */
export function sync(db: DatabaseSync, c: Catalog, scope = "") {
  validateScope(scope);
  validateCatalog(c);
  if (scope && c.products.some((p) => !p.productCode.startsWith(scope)))
    throw Error("CATALOG_OUTSIDE_SCOPE");
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare(
        "SELECT p.*, i.quantity FROM products p LEFT JOIN inventory i USING(product_code) WHERE p.product_code GLOB ?",
      )
      .all(scope + "*") as any[];
    const codes = new Set(c.products.map((p) => p.productCode));
    const save = (p: Product, old: any) => {
      if (old && old.quantity == null) throw Error("INCONSISTENT_DATA");
      const changed =
        old &&
        (old.name !== p.name ||
          old.price !== p.price ||
          old.active !== Number(p.active) ||
          old.quantity !== p.quantity);
      const version = old ? old.version + Number(Boolean(changed)) : 1;
      if (version > MAX) throw Error("VERSION_OVERFLOW");
      db.prepare(
        "INSERT INTO products VALUES(?,?,?,?,?) ON CONFLICT(product_code) DO UPDATE SET name=excluded.name,price=excluded.price,active=excluded.active,version=excluded.version",
      ).run(p.productCode, p.name, p.price, Number(p.active), version);
      db.prepare(
        "INSERT INTO inventory VALUES(?,?) ON CONFLICT(product_code) DO UPDATE SET quantity=excluded.quantity",
      ).run(p.productCode, p.quantity);
    };
    for (const p of c.products)
      save(
        p,
        existing.find((x) => x.product_code === p.productCode),
      );
    for (const p of existing)
      if (!codes.has(p.product_code))
        save(
          {
            productCode: p.product_code,
            name: p.name,
            price: p.price,
            active: false,
            quantity: 0,
          },
          p,
        );
    if (scope) {
      db.prepare(
        "INSERT INTO sales_sync_scopes VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET catalog_version=excluded.catalog_version",
      ).run(scope, c.catalogVersion);
    } else {
      db.prepare(
        "INSERT INTO sync_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET catalog_version=excluded.catalog_version",
      ).run(c.catalogVersion);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
/** HTTP入口とDB処理で共通の受注入力検証。DBは変更しない。 */
export function validOrderInput(input: unknown): input is {
  productCode: string;
  quantity: number;
  version: number;
} {
  if (
    !input ||
    typeof input !== "object" ||
    !keys(input, ["productCode", "quantity", "version"])
  )
    return false;
  const { productCode, quantity, version } = input as any;
  return (
    typeof productCode === "string" &&
    productCode.length > 0 &&
    integer(quantity, 1) &&
    integer(version, 1)
  );
}
/**
 * dbの最新状態でinputを検証し、HTTP用statusとbodyを返す。業務拒否は400/409の結果。
 * SQLなどの予期しない失敗はROLLBACK後に例外。受注・在庫・商品versionは一緒に更新する。
 */
export function order(db: DatabaseSync, input: unknown) {
  if (!validOrderInput(input))
    return { status: 400, body: { error: "INVALID_REQUEST" } };
  const { productCode, quantity, version } = input;
  db.exec("BEGIN IMMEDIATE");
  try {
    const p = db
      .prepare(
        "SELECT p.*,i.quantity FROM products p LEFT JOIN inventory i USING(product_code) WHERE p.product_code=?",
      )
      .get(productCode) as any;
    let error =
      !p || p.quantity == null
        ? "INCONSISTENT_DATA"
        : p.version !== version
          ? "STALE_VERSION"
          : !p.active || p.quantity < quantity
            ? "ORDER_UNAVAILABLE"
            : p.version >= MAX
              ? "ORDER_UNAVAILABLE"
              : null;
    if (error) {
      db.exec("ROLLBACK");
      return { status: 409, body: { error } };
    }
    const orderId = randomUUID();
    db.prepare("INSERT INTO orders VALUES(?,?,?,?, 'CREATED')").run(
      orderId,
      productCode,
      quantity,
      p.price,
    );
    db.prepare(
      "UPDATE inventory SET quantity=quantity-? WHERE product_code=?",
    ).run(quantity, productCode);
    db.prepare(
      "UPDATE products SET version=version+1 WHERE product_code=?",
    ).run(productCode);
    db.exec("COMMIT");
    return {
      status: 201,
      body: {
        orderId,
        productCode,
        quantity,
        unitPrice: p.price,
        status: "CREATED",
      },
    };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
