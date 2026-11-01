/** 7ケースのIDとテスト名の対応表。レポーターが未実施も数えるために参照する。 */
export const salesCases = [
  { id: "UI-01", title: "画面から外部接続を確認して正常に受注できる" },
  { id: "UI-02", title: "外部IF障害時は受注に失敗し関連データが変わらない" },
  {
    id: "BATCH-01",
    title: "同期バッチの結果が取得した上流データ全件と一致する",
  },
  { id: "BATCH-02", title: "外部IF障害時は同期に失敗し対象データが変わらない" },
  { id: "CROSS-01", title: "同期中の商品表示が旧状態または新状態で一貫する" },
  { id: "CROSS-02", title: "古い表示からの受注を拒否する" },
  { id: "CROSS-03", title: "商品と在庫が不整合な場合は受注を拒否する" },
] as const;

/** UI-02・BATCH-02の必須パラメータ。選択されなかった値も全体の完了判定に含める。 */
export const upstreamErrorStatuses = [500, 502, 503] as const;

export function salesCaseTestTitles(
  item: (typeof salesCases)[number],
): string[] {
  return item.id === "UI-02" || item.id === "BATCH-02"
    ? upstreamErrorStatuses.map((status) => `${item.title} (${status})`)
    : [item.title];
}
