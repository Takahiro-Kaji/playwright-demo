type Row = {
  productCode: string;
  name: string;
  price: number;
  quantity: number;
  version: number;
};
export type DisplayExpectation = { rows: Row[]; texts: string[] };
/** Every item must belong to one fixed version, with usable controls and no errors. */
export function syncDisplayMatches(
  rows: unknown,
  texts: string[],
  enabled: boolean[],
  status: number,
  pageErrors: string[],
  failedHttp: number[],
  expectations: DisplayExpectation[],
): boolean {
  const matching = expectations.find(
    (e) => JSON.stringify(e.rows) === JSON.stringify(rows),
  );
  return (
    Boolean(matching) &&
    JSON.stringify(texts) === JSON.stringify(matching!.texts) &&
    enabled.length === matching!.rows.length + 1 &&
    enabled.every(Boolean) &&
    status === 200 &&
    pageErrors.length === 0 &&
    failedHttp.length === 0
  );
}
