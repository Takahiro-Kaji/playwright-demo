/** 同期中の応答・表示・操作状態が固定された旧か新の一方に揃うか判定する。型、関数の順に読む。 */
type Row = {
  productCode: string;
  name: string;
  price: number;
  quantity: number;
  version: number;
};
export type DisplayExpectation = { rows: Row[]; texts: string[] };
/** Every item must belong to one fixed version, with usable controls and no errors. */
/**
 * 応答rows・表示texts・ボタンenabledを固定期待expectationsと照合する。statusと各エラー配列も確認。
 * すべて成立ならtrue、それ以外はfalse。通常は例外を送出しない。
 */
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
