# AWS業務7ケース

TypeScript版の販売管理デモを、実行ごとの専用namespace・MySQL DB・DBユーザーで試験する。通常IFは学習用HTTPサービス。Cognitoローカルユーザーの手動Chrome認証と保存済みstorageStateはPR #10の方針を使う。Java版とローカルSQLite版の実行入口は別。

**実AWSでは未検証。** コードのローカル検証とAWS受入を区別する。`aws-sales:list` はAWSに接続しない。`prepare`、`check`、`auth`、`run`、`recover`、`cleanup` は設定済み実環境へ操作するコマンドなので、AWS構築後の承認された検証で使う。

## ファイルと実行経路

- `environment.ts`：外部設定・ローカルjournal・排他、AWS identity/EKS kubeconfig照合、所有ラベルとUID。
- `resources.ts`：今回だけのbridge、DB Secret、アプリ、上流、Service、CronJob、Cognito Ingress。
- `lifecycle.ts`：専用DBとユーザー作成・権限、SQLスキーマ初期化、F1投入、DNS/ALB/Ingress/Pod/DB照合、カタログ実応答、Jobと復元。
- `mysql-tunnel.ts`：試験用bridge Podからprivate RDSへ接続し、ローカルのmysql2でCAとRDS名のTLS検証。トランザクションとロック中は同じ接続を保持する。
- `harness.ts`：共通の `BaseHarness` はDB/Kubernetes対象確認 → ロック → 初期化 → 本体 → 個別/共通復元 → 結果保存を行う。UI専用 `uiSession` / `uiHarness` のみbrowserと保存認証を要求する。After失敗は実行をブロック。
- `business.spec.ts` → `scenarios.ts`：実処理へ接続した7ケース。
- `run.ts`：Playwright終了を待って成功・失敗の双方で今回環境を回収。
- `cleanup.ts`：今回所有のJob・Pod・Ingress・ALB/TG不在確認、DBユーザー・DB、namespace回収。PR #8の通常namespace用削除処理の前に実行する。

## 外部設定と権限

Node 26、npm、kubectl、AWS CLIとAWS Load Balancer Controllerが必要。Google Chromeと保存認証が必要なのはUIおよびUIを使う横断ケースだけで、BATCH-01/02には不要。DB所有ATTRIBUTEを使うためMySQL 8.0.21以降を必要とし、今回の実SQL検証は8.4で行う（[MySQL CREATE USER仕様](https://dev.mysql.com/doc/refman/8.0/en/create-user.html)）。試験イメージは現在の `aws/sales/Dockerfile` からビルドし、対象リージョンのECRへ用意する。CAバンドル・設定・journal・認証状態はすべて `.local/` 内に保存しGitへ追加しない。

`config.example.json` を `.local/aws-sales/tokyo-config.json` にコピーして実値へ置き換える。例の値はダミーであり、そのまま使用しない。大阪はregion、context、cluster、ECR、証明書、Cognito、URL、stateFileを大阪用に変え、別journalを使う。共有RDS endpointは同じでも、毎回乱数のDB名・ユーザーになる。**東京で準備→認証→試験→回収してから大阪へ進む。** 同じjournalを複製して並行実行しない。

`url` は専用Ingressへ向ける検証ホスト。Cognito clientのcallbackに `https://HOST/oauth2/idpresponse` が必要。今回の専用ALBへDNSを向け、同じホストを通常Ingressへ向けたままにしない。suiteはDNS、Ingress、ALB listener/ruleの認証・転送先、Pod IP/UID、Service Endpoint、Pod DB設定・Secret・DB所有マーカーを照合し、不一致なら更新処理を始めない。ALBの古いtargetがdraining中でも開始せず、healthyな今回Podだけになってから再確認する。

必要な権限：

- AWS：STS identity、EKS DescribeCluster、ELBv2のDescribeLoadBalancers/Listeners/Rules/TargetHealth/Tags/TargetGroups。コントローラーの作成・削除権限は既存の構築設定。
- Kubernetes：namespace作成、今回namespace内のPod・Deployment・ReplicaSet・Service/Endpoints・Secret・ConfigMap・CronJob・Job・Ingressの取得/作成/変更/削除、exec、rollout確認。最終回収の所有確認では全namespaced resourceのlistが必要。権限不足は回収未確認として停止する。
- DB管理用ユーザー：TLS必須。専用DB作成/削除、ユーザー作成/削除、権限付与、`mysql.user` の所有ATTRIBUTE確認、スキーマ作成。RDSの許可された管理ユーザーを使用する。

管理認証は `AWS_SALES_ADMIN_USER` と `AWS_SALES_ADMIN_PASSWORD` を安全な環境変数として渡す。平文のパスワードをコマンド・履歴へ書かない。管理認証はPodへ渡さず、ローカルmysql2のみに使う。専用アプリユーザーには今回DBの業務5表にだけDMLと所有表のSELECTを与え、他DBや所有表の変更権限を与えない。

bridgeは既存EKSのノード上で動き、新しいbastionや有料接続サービスは追加しない。Podから共有RDSへ既存のVPC経路・SG・DNSが必要。Ingressは**実行ごとに別のALBを作る**ため、その稼働時間・LCU等の費用が増える。既存EKS/RDS/NAT等の費用も続くので、1実行ずつ短時間で回収する。料金の保証や2,000円以内の保証はしない。今回のコード実装自体はAWS構築の指示ではない。

## AWS構築後の実行順序

1. PR #10のCognito local設定、callback、検証ユーザー、ACM、ECR、両EKSとController、共有RDS経路を準備する。通常環境の共有データは変更しない。
2. 対象リージョンの設定ファイルとCA、管理用環境変数を用意する。
3. 専用環境を作成する（同じjournalを再利用してprepareしない）。

```sh
npm run aws-sales:manage -- prepare .local/aws-sales/tokyo-run.json .local/aws-sales/tokyo-config.json
npm run aws-sales:manage -- describe .local/aws-sales/tokyo-run.json
```

`prepare` は所有情報を先にjournalへ書き、専用namespace・bridge → 専用DB/所有マーカー/ユーザー/権限 → アプリ/上流/Jobひな型/Ingress → F1同期・全件照合まで行う。途中失敗時もjournalを保持する。

4. describeの専用ALB DNSへ検証ホストを登録する。ALBがhealthyになったら、対象整合性を確認して手動認証する。

```sh
npm run aws-sales:manage -- check .local/aws-sales/tokyo-run.json
npm run aws-sales:manage -- auth .local/aws-sales/tokyo-run.json
```

`auth` はjournalのURLとstateFileを既存 `setupAuth()` に渡す。手動ログイン後、新contextとChrome再起動後の再利用を確認する。suiteでも各ケースの新contextに状態を読ませ、URLと `#refresh` を確認する。未設定・失効・別URLは失敗し、成功やskipへ置き換えない。UIはSSO入口だけを使い、port-forwardを実SSO試験として扱わない。

バッチ単独の場合は手動認証・storageState・DNS/ALB経由の画面確認を待たず、prepare後に `npm run aws-sales:manage -- check-batch JOURNAL` で事前確認し、`npm run aws-sales:run -- JOURNAL --grep BATCH-01` またはBATCH-02を実行できる。共通設定にIngress用情報は残るが、試験ではアカウント・EKS/context・namespace・bridge・Jobひな型・DB Secret/CA・DB所有を `verifyBatchTarget()` で照合し、CognitoやstateFileを読み込まない。

5. 一括または個別実行する。`run` は終了後に専用環境を回収するので、管理認証の環境変数を保持しておく。

```sh
npm run aws-sales:list
npm run aws-sales:run -- .local/aws-sales/tokyo-run.json
# 個別実行：上記の代わりに使用
npm run aws-sales:run -- .local/aws-sales/tokyo-run.json --grep UI-01
```

再試験のため環境を残す場合の低水準入口は以下。AfterでF1と通常IFへ復元しJobは停止するが、namespace・Ingress・ALBは残るため必ず後のcleanupを行う。

```sh
export AWS_SALES_JOURNAL=.local/aws-sales/tokyo-run.json
npm run aws-sales:test
npm run aws-sales:test -- --grep BATCH-02
npm run aws-sales:manage -- cleanup .local/aws-sales/tokyo-run.json
```

6. DNSを専用ALBから解除し、stateFileを使用後に削除する。大阪は別設定・journal・認証状態で同順序を行う。全検証後、PR #8のinventory/destroy/verifyで基盤と残存資源を確認する。今回cleanupは通常namespace・RDSインスタンス・ACM・DNS・Cognito自体を削除しない。

## ケース別の流れ

UIケースは認証とURL/ALBを含む対象確認を行い、バッチケースはブラウザーなしでDB/Kubernetesの対象確認を行う。各ケースは共通Givenで設定・対象・所有確認を済ませ、今回DBの4表を空にする。既存業務データの初期化はしない。共通Afterは全件F1と通常IFを復元して確認する。テストは1 worker・retryなし・最初の失敗で停止。

- **UI-01「UI正常・学習用通常HTTP IFと受注」**：Given `batch()` → `compareMysql(F1)`。When `availability()` → `show()` → `order()`。Then 201・UUID・画面成功・固定単価/数量、在庫4/version2とP002不変を含む4表全件照合。After 共通復元。
- **UI-02「UIモック503・DB不変」**：Given `catalog(f1,mock)` → `batch()` → 固定F1照合 → `snapshotMysql()` → 元status退避 → `mockStatus(503)` → `catalogMatches(503)`。When 画面接続確認。Then 502・外部エラー・4表不変。After status元値とHTTP確認 → 共通復元。
- **BATCH-01「バッチ正常・全件照合」**：Given F1の実応答と空DB。When 実 `batch()`。Then Job completeに加えて固定F1の全キー・件数・値・関連・世代・受注0件を比較。After 共通復元。
- **BATCH-02「バッチモック503・異常終了とDB不変」**：Given F1同期 → 固定照合 → snapshot → モック503実応答。When 対象Job/Pod/バッチコンテナの所有確認、実行開始/終了、exitCode 1・reason Error・signalなし・既存固定エラーマーカーを確認（単なるFailedやtimeoutでは代替不可）。Job前後にモック503の実応答を確認する。Then 4表不変。After status元値/HTTPと共通復元。
- **CROSS-01「同期中UI・3000件全表示と独立DB観測」**：Given bulk1同期/固定照合 → bulk2実応答。When 実Jobと継続UI・独立SELECTを並行。Then HTTP・全3,000表示・全ボタン・JS/HTTPエラー・最終DBを確認し、既存 `hasObservedOverlap()` で同じ参照内の1→2だけを採用する。試行開始/Job待機12秒、20試行、10,000観測、UI timeout3秒。すべてrunnerの単調時計でSELECTの送受信を囲むため、クラスタ時計への換算は不要。証拠不足はunconfirmedで非ゼロ終了。After 開始済み処理回収、Job停止・観測要約保存・共通復元。アプリへ遅延は入れない。
- **CROSS-02「古いversionによる受注拒否」**：Given F1同期/表示 → F2へ `catalog()`/`batch()` → 固定F2照合 → snapshot。When 保持した旧画面から1回受注。Then 409/STALE_VERSION・画面再表示要求・4表不変。After 共通復元。
- **CROSS-03「不整合情報による受注拒否・復元」**：Given F1同期/表示 → 所有確認済みDBのP001在庫行だけDELETE → snapshot。When 受注。Then 409/INCONSISTENT_DATA・画面異常・4表不変。After 固定値で在庫行を復元しF1全件照合 → 共通復元。

固定期待値は操作より前に定義する。snapshotは「Whenで変わらなかったこと」の基準であり、F1/F2の正しさを証明する期待値の代わりにはしない。受注のtimeoutや応答喪失時に再送しない。

## 判定・復旧

`npm run aws-sales:manage -- summary JOURNAL` でも秘密を除いたケース結果を確認できる。`reporter.ts` の `.local/aws-sales-evidence/*.json` は選択範囲、ケース判定、After判定を別々に記録する。7件すべてpassedかつAfter confirmedのときだけ `allSevenPassed=true`。個別実行や未確認は全7件PASSにならない。journalには実行ID、所有UID、状態、ケース結果、数値時系列だけを保持し、生レスポンス・DB全件・Cookieを出さない。journal自身は専用DBパスワード等を含むのでmode600の秘密ファイルとして扱う。

Afterが失敗するとjournalがblockedになり、その後の試験は初期化前に拒否される。元のbusiness verdictとAfter failed、個別エラーコードを保持する。復元処理は失敗した箇所以外も試み、Job停止不明ならDBをresetしない。

```sh
# 認証失効なら auth をやり直す。対象不一致ならDNS/ALB/設定を直してcheckする。
# 復元に失敗した実行を調べて基準状態へ戻す
npm run aws-sales:manage -- recover .local/aws-sales/tokyo-run.json
# 試験を再開せず、所有確認して回収する場合
npm run aws-sales:manage -- cleanup .local/aws-sales/tokyo-run.json
```

強制終了時はjournalを削除せず、起動したローカル試験プロセスが終了したことを確認する。`.lock` が残っていれば `npm run aws-sales:manage -- unlock JOURNAL` を使う。同一ホストで記録PIDが不存在の場合だけ解除し、存命・他ホスト・所有不明では解除しない。その後recoverかcleanupを使う。Ingressが既に回収された実行はrecover後にrestoredとなり、業務再開には使わずcleanupして新しい実行を準備する。既に削除したDB/ユーザーは不在を確認して扱い、別UIDに置き換わったKubernetesオブジェクトは削除しない。

CREATE DATABASE成功直後の応答とjournal書込みを同時に失った場合など、DB所有マーカーを確認できないと自動削除を拒否する。journalの意図記録・MySQL管理ログ等から作成主体を確認し、管理者が所有を確定するまで対象DBを保持する。名前だけで所有を断定したり、共有DBを削除したりしない。cleanupはアプリPodの不在とJob停止・CronJob suspendを明示的に確認する。停止操作失敗、Pod不在timeout、Job停止未確認ではDBのreset/restore/DROPへ進まず、`cleanupStops` の理由と既存の失敗をjournalに保持してblocked/recovery-requiredにする。この場合はIngress/bridge/DBも残しており、停止原因を直してcleanupを再実行する。Ingress finalizerを強制解除しない。ALB/TG不在を確認できない場合はnamespaceを残し、Controllerと権限を復旧してcleanupを再実行する。

## ローカル検証と追加ケース

```sh
npm run sales:check
npm run aws-sales:verify
npm run sales:test:verification
npm run sales:test:unit
npm run test:integration
```

`aws/tests/local-*` と `tests/aws-sales/local.config.ts` は専用 `kind-sales-pr9-qa`、MySQL 8.4、今回イメージを使う統合検証。AWS APIとCognito/ALB/DNSだけを模擬し、Pod・Job・MySQL・HTTPアプリは実物を使う。この成功を実AWSの成功とは記録しない。実行準備と検証実績は `IMPLEMENTATION-STATUS.md` を参照する。

SQLite版との違いは、非同期の独立MySQL SELECT、RDS行ロックと接続単位のadvisory lock、Kubernetes Job/rollout、実行単位DB/ユーザーの権限、SSO/ALB経路、削除の非同期性。期待値や同期中の成立条件は同じ。JavaのAWS追加は今回対象外。

新しいAWSケースは、固定期待値を先に定義し、scenariosへIDとGiven/When/Thenを追加し、必要な故障注入はAfter actionを変更前に登録する。ケースIDをreporterへ追加し、対象確認を迂回せず、失敗・応答喪失・After失敗のテストを追加する。全件PASSの必要件数と教材も同時に更新する。

AWS構築後に初めて確認する項目は、ECR pull/IAM、RDS実CAとTLS、両リージョンのSG/peering/DNS、ALB/Cognito localユーザー/期限切れ状態、Controllerのtarget反映・削除、AWS API権限、実負荷での同期中成立証拠、最終費用と#8による残存確認。

## Job異常終了の確認範囲

削除前に所有Job/Pod/バッチコンテナの終了証拠を取得し、`journal.batches` にoutcome・exitCode・reason・signal・開始/終了確認・固定マーカーの有無・停止結果を残す。正常、期待するアプリ異常、想定外終了、OOM/シグナル、起動不可、期限超過、終了証拠不明を区別する。状態取得やログ確認に失敗してもJob削除とPod不在確認は試みる。ログは最大2KB/8行から既存の `SALES_START_OR_SYNC_FAILED` の有無だけを読み、全文は保存・表示しない。

BATCH-02は `requireExpectedBatchError()` を通過した異常終了と、前後の実モック503・DB不変を確認する。このマーカーはruntimeの共通catchのため、内部通信を厳密に追跡して503だけが原因だったことを証明するものではない。所有・command・実行/終了証拠と事前正常同期を組み合わせた観測範囲で判定し、終了コード違い、OOM、強制終了、起動失敗、証拠不明をPASSにしない。業務アプリに試験専用の識別処理は追加していない。

## SSO未認証受注試験（Issue #11）

prepare → DNS設定 → check後、同じjournalを `AWS_SSO_JOURNAL` に指定して `npm run aws-sales:sso -- --grep '未認証受注'` を実行する。`SALES_AUTH_URL` / `SALES_AUTH_SUCCESS_URL` はjournal.config.url、`SALES_AUTH_STATE` はjournal.config.stateFile、`SALES_AUTH_SUCCESS_SELECTOR` は `#refresh`、`SALES_AUTH_ENABLED=1`、`AWS_SSO_COGNITO_DOMAIN` は `userPoolDomain.auth.region.amazoncognito.com` とする。未認証受注ケース自体は保存Cookieを読み込まずHTTPを送る。全SSOケースには先に同じjournalでauthを行う。DB管理者や旧 `AWS_SSO_DB_*` の設定は不要。SSO試験はDB接続確認前にjournalを `recovery-required / blocked=true` とし、試験・復元・ロック解放・接続終了がすべて正常完了した場合だけ解除する。失敗・強制終了後は、残った排他をunlockしただけでは再実行できない。同じjournalでrecoverまたはcleanupを行う。SSO試験は環境を自動cleanupしないため、終了後は本資料のcleanupを実行する。接続先照合・TLS中継・復元範囲と中断時の手順は [SSO試験](../../aws/README.md#sso試験) を参照。

回帰検証は `npm run sales:check` と `npm run aws-sales:verify`。破棄可能なローカルMySQLを使う `bash aws/tests/mysql-tls.test.sh` は、専用ユーザー/DB、TLS中継、想定外受注の削除、同期状態の差分検出、権限不足、ホスト名不一致を確認する。AWS/ALB所有照合はローカルSQL試験で模擬しており、実AWSでの302・未登録・専用行削除・前後一致の受入は別途必要。

## #12 HTTP本文の取得期限

接続確認もブラウザー内で `r.json()` を読み、200と `available === true` の双方を確認してから成功を表示する。以前は `r.ok` だけを読み、実ALB/Cognito + Chrome 156では未消費の本文に対するCDP `Network.loadingFinished` / Playwright `requestfinished` が来ず、試験側の本文取得が待ち続けた。同じリクエストの本文をブラウザー内で消費すると完了することを東京で切り分けた。これは観測した環境での発生条件であり、Chrome内部の一般的な不具合原因やHTTP/2固有の問題とまでは断定しない。

`response-body.ts` は `finished()` と `text()` に共通の期限を適用し、その後JSONを解析する。通常は合計10秒、CROSS-01の本文取得は合計3秒。ステータス判定・固定本文比較・全画面表示・DB全件比較は維持する。対象応答は同じoriginの完全URL、HTTP method、main frameで選ぶ。

- `HTTP_RESPONSE_FINISH_TIMEOUT` / `HTTP_RESPONSE_FINISH_FAILED`：応答完了通知の待機期限超過／通信失敗。
- `HTTP_BODY_READ_TIMEOUT` / `HTTP_BODY_READ_FAILED`：本文取得の待機期限超過／取得失敗。
- `HTTP_BODY_INVALID_JSON`：本文のJSON解析失敗。

いずれも業務failedとしてAfterへ進む。本文・Cookie・認証URL・元例外の内容はコードへ含めない。期限切れ後のPromiseの拒否も処理し、受注を再送しない。画面からの応答が失われた場合もDB全件復元とJob停止の共通Afterを使う。

Chrome channelとlockfileのPlaywright 1.64.1を維持し、ブラウザーflagやバージョン固定は追加していない。アプリ側の本文消費と試験側の期限で対処するため、Chromeによる学習方針は変わらない。Playwrightでは [`requestfinished` は本文ダウンロード完了時の通知](https://playwright.dev/docs/api/class-request)であり、responseイベントの200だけでは本文取得の完了を意味しない。上流の[ナビゲーションによる本文待機問題 #43508](https://github.com/microsoft/playwright/issues/43508)も確認したが、本件ではナビゲーションなしで再現しているため同一原因とは扱わない。
