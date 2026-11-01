type Row = {
  productCode: string;
  name: string;
  price: number;
  quantity: number;
  version: number;
};
const f1: Row[] = [
  { productCode: "P001", name: "ペン", price: 120, quantity: 5, version: 1 },
  { productCode: "P002", name: "ノート", price: 300, quantity: 2, version: 1 },
];
const f2: Row[] = [{ ...f1[0], quantity: 3, version: 2 }, f1[1]];
/** Verify the entire observed UI and response against either fixed committed state. */
export function syncDisplayMatches(
  rows: unknown,
  texts: string[],
  enabled: boolean[],
  status: number,
  pageErrors: string[],
  failedHttp: number[],
): boolean {
  const serialized = JSON.stringify(rows);
  const f1Match = serialized === JSON.stringify(f1),
    f2Match = serialized === JSON.stringify(f2);
  const expected = [
    `ペン 120円 在庫${f1Match ? 5 : 3}受注`,
    "ノート 300円 在庫2受注",
  ];
  return (
    (f1Match || f2Match) &&
    JSON.stringify(texts) === JSON.stringify(expected) &&
    JSON.stringify(enabled) === JSON.stringify([true, true, true]) &&
    status === 200 &&
    pageErrors.length === 0 &&
    failedHttp.length === 0
  );
}
