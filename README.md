# Playwright Java integration demo

設計方針の妥当性を代表3ケースで確かめるためのプロトタイプです。2リージョンのアプリ・ステータスモックと MySQL を対象に、UI、同期バッチ、同期中のUI参照を確認します。Java 17、Gradle Wrapper 8.14.2、Playwright Java、JUnit Jupiter を使用します。ケースは逐次実行し、自動リトライは行いません。

`UiEnvironment` は実行環境の境界です。`LocalUiEnvironment` と `ExternalEnvironment` は demo-items の画面・モック・DB接続に固有のadapterで、`UiCaseRunner` がUIシナリオのGiven / When / Then / Afterを構成し、`LocalUiTest` が9通りのケースを選びます。バッチとcrossは `targets/reference` の対象固有環境・全行比較を共有し、互いのケースを呼び出しません。

## ローカル実行

Java 17、`mysqld` / `mysql` / `mysqladmin`、Google Chrome が必要です。テストは loopback の専用一時 MySQL とデモサービスを所有し、終了時に回収します。Gradle Wrapper の配布物は公式 SHA-256 で検証します。

```sh
./gradlew test                 # 通常の契約テスト。AWSを使わない
./gradlew localUiTest          # 3ルート × 3シナリオ
./gradlew localBatchTest       # 完全取得・独立同期・全行比較・SQL故障
./gradlew localCrossTest       # 実HTTP区間内の同期中UI観測
./gradlew fakeExternalTest     # 借用環境での共通ケースと非所有close
BATCH_SIZE=30000 ./gradlew localBatchTest --tests '*captureSyncAndCompareWholeTables'
```

UIの `random` はローカルでは固定Aへの代役です。実ロードバランサーはローカル試験の範囲外です。`localCrossTest` は実HTTP要求開始〜応答終了の内側で2回のSQL観測にコミット済み件数の差がある場合だけ成立し、根拠がなければ未確認・非成功となります。同一端末のepochミリ秒を使い、両端に1msの内向き余裕を置きます。時計の急変は排除できません。

## 故障確認

次はいずれも意図的に失敗させ、コマンドが非ゼロで終了する確認です。環境変数は指定した1回の実行にのみ適用してください。

```sh
UI_VERIFY_WRONG_FEEDBACK=1 ./gradlew localUiTest --tests '*fixedA_externalError'
UI_VERIFY_DB_STATUS=1 ./gradlew localUiTest --tests '*fixedA_success'
UI_VERIFY_TIMEOUT=1 ./gradlew localUiTest --tests '*fixedA_externalError'
UI_VERIFY_RESTORE_FAIL=1 ./gradlew verificationTest
UI_VERIFY_WRONG_FEEDBACK=1 UI_VERIFY_RESTORE_FAIL=1 ./gradlew verificationTest
UI_VERIFY_ATTACH=1 ./gradlew localUiTest --tests '*fixedA_success'
UI_VERIFY_WRONG_FEEDBACK=1 UI_VERIFY_CLEANUP_TIMEOUT=1 ./gradlew localUiTest --tests '*fixedA_externalError'
CROSS_VERIFY_NO_OVERLAP=1 ./gradlew localCrossTest
```

cleanup予算超過では、停止確認できない専用MySQLのディレクトリを回収用に保持します。対象プロセスの終了を確認してから回収してください。各実行の非秘密要約は `.local/runs/<runId>/case-summary.json` に所有者のみ読書き可能な権限で保存します。具体的な結果、ソース／入力hash、復元の状態と未確認範囲は [実装フィードバック](docs/implementation-feedback.md) を参照してください。

## 明示的な外部環境

`.env.example` を参考に `.env` または環境変数で非本番のリージョン、Kubernetes context、namespace、各転送先、DB、プライベートなモック・MySQL設定ファイルを指定します。環境変数が `.env` に優先します。管理口とMySQLはloopback転送を使い、MySQLはCA検証と読取専用資格情報を使用します。両リージョンのdeployment readinessを確認後、同じUIケースを実行します。

```sh
./gradlew externalUiTest
```

外部のアプリ・DB・ポート転送はテストの所有物ではなく停止・破棄しません。成功ケースはSUTを通して生成したUUIDキーの行を残し、要約に識別キーと要片付けを記録します。直接の共有DB変更や全量同期を行う場合は、別途その範囲と復旧を設計してください。実AWS/EKS/RDS、実TLS接続、実業務データは今回未確認です。

## 運用コマンド

`./gradlew installDist` 後、`build/install/play-right-demo/bin/play-right-demo` に次の入口があります。AWS環境の構築・変更は別途必要な設定と権限を確認して実行してください。

```sh
build/install/play-right-demo/bin/play-right-demo configure-mocks
build/install/play-right-demo/bin/play-right-demo bootstrap-db
build/install/play-right-demo/bin/play-right-demo port-forward
build/install/play-right-demo/bin/play-right-demo render-k8s k8s/status-mock.yaml.tpl
```

Terraform、デプロイ用shell、Kubernetes manifestは `infra/`、`scripts/`、`k8s/` にあります。CIはJavaの通常契約テストを実施し、AWSへのデプロイは行いません。Docker imageの構築も今回未確認です。
