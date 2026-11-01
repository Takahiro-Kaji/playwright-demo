# AWS業務試験の実装状況

7ケースは `business.spec.ts` → `scenarios.ts` → `harness.ts` / `lifecycle.ts` へ接続済み。準備、対象・所有確認、専用DB/ユーザー、実Job、モック実応答、全件比較、復元、実行結果、専用環境回収を実装した。実行方法と関数対応は [README](README.md) を参照。

実AWSは未検証。ローカルkind/MySQLによる検証はCognito/ALB/DNS/AWS identityを模擬するため、その範囲を実AWS受入と読み替えない。SQL専用・TLS・中継テストもそれぞれ独立した検証。

PR #8は取り込み済みで、今回cleanupは専用namespaceのIngress/ALB/DBを所有確認して回収する。#8の基盤destroy前に実行する。PR #10のCognitoローカルユーザー・手動認証・storageState方針を既存 `setupAuth()` で利用し、同PRのTerraform認証設定とSSO試験もmainから統合済み。実行IDと削除管理ラベルを保持する。

ローカル統合検証の再現入口は `bash aws/tests/run-local.sh`。Docker、kind、kubectl、Chromeが必要。新規の専用kindとMySQL 8.4を作り、`local-manage` / 同じ7シナリオ / 実SQL故障注入・権限・Job timeout停止を実行し、成功・失敗時に回収する。既存の同名kindがあれば使用せず停止する。回収失敗時は所有journalを示して環境を保持する。Cognito・ALB・DNS・AWS identityは模擬であり、それ以外は実物。

## 20629a1時点までの検証結果

- 型検査、diff check、AWS業務7件の一覧確認：成功。
- 既存単体19件、照合/ロック12件、AWS orchestration局所16件：成功。認証失効、対象不一致、Job失敗/timeout、After失敗/後続停止と誤PASS防止を含む。
- 専用kind 1.29 + MySQL 8.4.5で同じ業務シナリオ：UI-01/UI-02/BATCH-01/BATCH-02/CROSS-02/CROSS-03が成功。CROSS-01は最終DB・全表示を確認したが重なり証拠不足で未確認。全ケースのAfterはconfirmed。未確認を含む一括実行は終了コード1で正常に終了。
- 最終版UI-01単独再確認：終了コード0。
- 実MySQLのSQL故障注入・権限制限・復元と実Job timeout停止：1件成功、終了コード0。
- 専用DB/ユーザー/namespaceのcleanup：終了コード0。blocked状態から実recover→cleanupも終了コード0。作成したローカルkind/MySQLコンテナは回収済み。
- SQLite版回帰：6件成功、同期中1件未確認で終了コード1。前回の終了待ちは再現せず、プロセス終了を確認。
- main統合後のPR #10局所7件、#8削除基盤13件：成功。
- AWSリソース操作・実AWS試験：未実施。ALB/Cognito/DNS/実RDS・IAM・両リージョン接続は構築後に確認する。

同期中UIの成立証拠不足はユーザー合意により許容し、PASSへ置き換えない。

## レビュー指摘3件の修正と再検証

- `cleanup.ts` は `cleanupStops` でアプリとJob/CronJobの停止を別々に記録する。どちらか未確認ならDB接続・復元・初期化・削除に進まず、`recovery-required` / blockedとして所有リソースを保持する。既存の失敗コードも保持する。停止原因を解消後、同じjournalで `cleanup` を再実行する。
- `batch-result.ts` / `lifecycle.ts` は削除前にJob UID、Podの所有参照、batchコンテナの実行・終了状態を確認する。正常完了、期待異常終了、想定外失敗、timeout、未確認を区別する。BATCH-02は503実応答の前後確認、実行済み・exit 1/Error・既存の固定エラーマーカー・停止確認・DB不変を要求する。OOM、強制終了、起動失敗、状態取得失敗をPASSにしない。マーカーは通信内部の原因を一意に証明するものではない（詳細はREADME）。ログ全文は記録しない。
- `harness.ts` は共通 `BaseHarness` とUI専用 `uiSession` / `uiHarness` を分離する。BATCH-01/02はChrome・storageState・手動SSOなしで共通所有確認を行う。UIケースは従来の認証確認を維持する。個別バッチの事前チェックは `check-batch`。

今回の検証（模擬と実物を区別）：

- 型検査、AWS業務7ケース一覧、diff check：終了コード0。
- AWS実行制御の局所回帰31件：成功、終了コード0。アプリ停止操作失敗・Pod不在確認timeout・Job停止失敗・正常cleanup、Job正常/期待異常/別終了コード/OOM/強制終了/deadline/待機timeout/状態取得失敗/所有不一致/起動失敗、ブラウザー非起動・認証ファイル不在のバッチ実行、UI認証不在/失効、復元失敗と後続停止を含む。停止失敗等の注入は模擬環境。
- MySQL照合/ロックの局所12件：成功、終了コード0。
- `bash aws/tests/run-local.sh --grep 'UI-01|BATCH-'`：専用kind 1.29 + MySQL 8.4.5でUI-01/BATCH-01/BATCH-02の3件成功。実SQL故障注入・トランザクション・権限・復元と実Job timeout停止の1件成功。DB/ユーザー/Ingress/namespaceの回収、kind/MySQLコンテナ削除まで終了コード0。今回追加したBATCH-02の判定関数も記録済み実終了証拠で成功を確認した。
- ローカル統合のAWS identity・Cognito・ALB・DNSは模擬。実Kubernetes/MySQLの確認と実AWSの確認を混同しない。実OOM/強制終了や実クラウドの停止障害は未注入。
- CROSS-01は今回再実行していない。既存の成立証拠不足時の未確認扱いと判定条件を維持。SQLite/Java業務ロジックの変更なし。SQLite回帰結果は上記の前回記録を参照。
- AWS操作・実AWS試験は未実施。実ALB/Cognito/DNS/IAM/RDS、東京・大阪での接続確認は構築後の工程。
