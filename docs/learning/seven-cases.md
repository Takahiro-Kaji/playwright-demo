# 7ケースの読解

各specの `test.step` はGiven→When→Then→Afterの順。期待値は操作前に定義し、Afterは失敗時も走る。[UI](../../tests/scenarios/ui/sales.spec.ts) の正常はF1同期→接続確認→受注→DB照合、異常はモック退避→503と実応答確認→画面・DB確認→元設定を確認して復元する。

[バッチ](../../tests/scenarios/batch/sales.spec.ts) の正常は実HTTP取得→同期→SQL全件比較、異常は503→同期失敗→全行不変→モック復元。[横断](../../tests/scenarios/cross-feature/sales.spec.ts) は同期中UI、表示後のversion変更による409、在庫行欠落による409。同期中はUIリクエスト期間内のDB観測1→2を証拠とし、捕捉できなければ未確認。同期完了やプロセス存命だけで合格にしない。

ケースの業務仕様は学習デモ専用であり、実業務の拒否仕様ではない。失敗と復元状態は分けて確認する。
