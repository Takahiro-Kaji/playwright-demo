/** 会社コード＋商品コードの複合ユニークキーで照合する学習用サンプル。 */
import type { DatabaseSync } from "node:sqlite";

export type CompanyProduct = {
  company_code: string;
  product_code: string;
  name: string;
  price: number;
};

/** 区切り文字がコードに含まれていても衝突しないよう、2列の組をJSON化する。 */
export function companyProductKey(row: CompanyProduct): string {
  return JSON.stringify([row.company_code, row.product_code]);
}

/**
 * 指定した会社の商品だけをSELECTし、固定期待値と比較する。一致なら空配列。
 * 商品コード単独では絞らず、対象会社内の余剰商品も検出する。
 */
export function compareCompanyProducts(
  db: DatabaseSync,
  expected: CompanyProduct[],
  companyCodes: string[],
): string[] {
  if (!companyCodes.length) throw Error("COMPANY_CODES_REQUIRED");
  if (expected.some((row) => !companyCodes.includes(row.company_code)))
    throw Error("EXPECTED_COMPANY_OUTSIDE_TARGET");
  const placeholders = companyCodes.map(() => "?").join(",");
  const actual = db
    .prepare(
      `SELECT company_code,product_code,name,price FROM company_products WHERE company_code IN (${placeholders})`,
    )
    .all(...companyCodes) as CompanyProduct[];
  return compareCompanyProductRows(actual, expected);
}

/** SQLの取得順に依存せず、複合キーの重複・欠落・余剰と業務値を比較する。 */
export function compareCompanyProductRows(
  actual: CompanyProduct[],
  expected: CompanyProduct[],
): string[] {
  const differences: string[] = [];
  const index = (rows: CompanyProduct[], label: string) => {
    const map = new Map<string, CompanyProduct>();
    for (const row of rows) {
      const key = companyProductKey(row);
      // Mapに格納する前に重複を検出し、上書きで隠さない。
      if (map.has(key)) differences.push(`${label}:duplicate:${key}`);
      else map.set(key, row);
    }
    return map;
  };
  const actualByKey = index(actual, "actual");
  const expectedByKey = index(expected, "expected");
  if (actual.length !== expected.length) differences.push("product:count");
  for (const [key, want] of expectedByKey) {
    const row = actualByKey.get(key);
    if (!row) differences.push(`product:missing:${key}`);
    else if (row.name !== want.name || row.price !== want.price)
      differences.push(`product:value:${key}`);
  }
  for (const key of actualByKey.keys())
    if (!expectedByKey.has(key)) differences.push(`product:extra:${key}`);
  return differences;
}
