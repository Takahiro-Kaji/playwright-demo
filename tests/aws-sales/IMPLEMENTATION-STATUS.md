# AWS業務試験の実装状況

7ケースは `business.spec.ts` → `scenarios.ts` → `harness.ts` / `lifecycle.ts` へ接続済み。準備、対象・所有確認、専用DB/ユーザー、実Job、モック実応答、全件比較、復元、実行結果、専用環境回収を実装した。実行方法と関数対応は [README](README.md) を参照。

実AWSは未検証。ローカルkind/MySQLによる検証はCognito/ALB/DNS/AWS identityを模擬するため、その範囲を実AWS受入と読み替えない。SQL専用・TLS・中継テストもそれぞれ独立した検証。

PR #8は取り込み済みで、今回cleanupは専用namespaceのIngress/ALB/DBを所有確認して回収する。#8の基盤destroy前に実行する。PR #10のCognitoローカルユーザー・手動認証・storageState方針を既存 `setupAuth()` で利用し、同PRのTerraform認証設定とSSO試験をmainから統合する。実行IDと削除管理ラベルを保持する。

ローカル統合検証の再現入口は `bash aws/tests/run-local.sh`。Docker、kind、kubectl、Chromeが必要。新規の専用kindとMySQL 8.4を作り、`local-manage` / 同じ7シナリオ / 実SQL故障注入・権限・Job timeout停止を実行し、成功・失敗時に回収する。既存の同名kindがあれば使用せず停止する。回収失敗時は所有journalを示して環境を保持する。Cognito・ALB・DNS・AWS identityは模擬であり、それ以外は実物。

## 今回の検証結果

- 型検査、diff check、AWS業務7件の一覧確認：成功。
- 既存単体19件、照合/ロック12件、AWS orchestration局所16件：成功。認証失効、対象不一致、Job失敗/timeout、After失敗/後続停止と誤PASS防止を含む。
- 専用kind 1.29 + MySQL 8.4.5で同じ業務シナリオ：UI-01/UI-02/BATCH-01/BATCH-02/CROSS-02/CROSS-03が成功。CROSS-01は最終DB・全表示を確認したが重なり証拠不足で未確認。全ケースのAfterはconfirmed。未確認を含む一括実行は終了コード1で正常に終了。
- 最終版UI-01単独再確認：終了コード0。
- 実MySQLのSQL故障注入・権限制限・復元と実Job timeout停止：1件成功、終了コード0。
- 専用DB/ユーザー/namespaceのcleanup：終了コード0。
- SQLite版回帰：6件成功、同期中1件未確認で終了コード1。前回の終了待ちは再現せず、プロセス終了を確認。
- AWSリソース操作・実AWS試験：未実施。ALB/Cognito/DNS/実RDS・IAM・両リージョン接続は構築後に確認する。

同期中UIの成立証拠不足はユーザー合意により許容し、PASSへ置き換えない。
