/** 7ケースのIDとテスト名の対応表。レポーターが未実施も数えるために参照する。 */
export const salesCases = [
  { id: "UI-01", title: "UI real learning HTTP success" },
  { id: "UI-02", title: "UI mock upstream unavailable" },
  { id: "BATCH-01", title: "batch real learning HTTP matches all rows" },
  { id: "BATCH-02", title: "batch mock failure leaves all state unchanged" },
  { id: "CROSS-01", title: "UI during synchronization" },
  { id: "CROSS-02", title: "stale version rejects order" },
  { id: "CROSS-03", title: "inconsistent relationship rejects order" },
] as const;
