# 販売管理デモのAWS構成

現行の `demo/sales` の画面と上流データを、2リージョンのEKS・共有RDS MySQL・各リージョンのモックで動かす。Web入口は各リージョンの ALB と Cognito で認証する。既定は管理者が作成する Cognito ユーザーで、企業 SAML IdP も選択できる。**旧デモは使わない。** ローカル版はSQLite、AWS版はMySQLを使う。同期と受注はRDSのロック行を使って両リージョン間で直列化する。

実 AWS・実 IdP での適用、plan と実機試験は未実施。EKS、NAT、RDS等に課金される。RDSはデモ用設定で自動バックアップなし、削除時の最終スナップショットなし。既存データがある環境に適用しない。秘密情報はGitやログに含めない。

## 構築準備

Terraform、AWS CLI、Docker、kubectl、Node 26以上、Google Chromeが必要。AWSの検証用アカウントと適切な権限を用意する。各リージョンのEKSにAWS Load Balancer Controllerを導入する（Cognito利用に必要な `cognito-idp:DescribeUserPoolClient` 権限を含む）。両リージョンに公開DNS名と同リージョンの ACM 証明書を用意する。SAML モードでは企業 IdP の設定も必要。Terraform stateには機密情報が含まれるため、アクセスを制限して管理する。

1. `aws/infra/terraform.tfvars.example` を参考に、専用のtfvarsに実際のCIDR・リージョン・両リージョンでサポートされるEKSバージョンを設定する。`terraform -chdir=aws/infra init`、`terraform -chdir=aws/infra plan -var-file=YOUR_TFVARS` で確認後、承認された環境にapplyする。
2. Terraform outputの両EKS名で `aws eks update-kubeconfig` を実行し、両クラスターへの管理アクセスを用意する。各ECRの `app_ecr_url` / `secondary_app_ecr_url` に、同じソースからビルドしたイメージを別々にpushする。AWS CLIの認証後、例として `docker build --platform linux/amd64 -f aws/sales/Dockerfile -t IMAGE .` と `docker push IMAGE` を用いる。ECRへのdocker loginは各リージョンで行う。
3. RDS上にTLS必須の専用DBユーザーを作成する。初回のschema作成には `integration_demo` に対するCREATE、SELECT、INSERT、UPDATE権限が必要。初期化後はCREATEを取り除く。DB管理者の接続・ユーザー作成は利用環境の許可された管理経路で行う。アプリはRDSエンドポイント名とCAによるTLS証明書検証を行う。
4. 両クラスターの `integration-demo` namespaceに同じDB専用ユーザーのSecret `sales-db`（キー `username`, `password`）、32文字以上のランダムなSecret `sales-mock`（キー `token`）、AWSのRDS CAバンドルを含むConfigMap `rds-ca`（キー `global-bundle.pem`）を登録する。各リージョンのモック用トークンは別にしてよい。Secretは引数・履歴に平文を書かず、安全なファイルや承認されたシークレット管理を使用する。クラスター内のモック管理APIへのアクセスはKubernetesの権限・ネットワークで制限する。
5. 対象リージョンのイメージ参照を `SALES_IMAGE`、共有RDSの完全修飾名を `DB_HOST` に設定し、`node aws/render-sales.cjs | kubectl --context CONTEXT apply -f -` を各クラスターで実行する。namespaceはSecret登録前に `kubectl --context CONTEXT create namespace integration-demo` で先に作成する。初回のみ、プライマリ側で `kubectl --context CONTEXT -n integration-demo exec deployment/sales-app -- node aws/sales/runtime.ts schema` を実行する。`sales-app` のpodが起動してから実行し、両クラスターのrolloutを確認する。
6. 同期は各リージョンの `sales-batch` CronJobから明示実行する。例: `kubectl --context CONTEXT -n integration-demo create job --from=cronjob/sales-batch sales-initial-sync`、その後 `kubectl --context CONTEXT -n integration-demo wait --for=condition=complete job/sales-initial-sync --timeout=180s`。最初に一度同期する。CronJobはsuspendされ、自動実行しない。

## SSO入口

各リージョンで別の Terraform state を使い、`aws/sso/infra` の `region`, `name`, `cognito_domain_prefix`, `ui_host` を設定して plan 後 apply する。既定 `identity_mode = "local"` は管理者作成ユーザーのみで自己登録を許可しない。Cognito コンソールでユーザーを管理者作成し、初回ログイン時に一時パスワードを変更する。認証情報をコマンドや履歴に記載しない。`identity_mode = "saml"` の場合は HTTPS の `saml_metadata_url` を指定し、`saml_entity_id` と `saml_acs_url` を IdP 管理者に登録して試験ユーザーを割り当てる。メール属性 URI は `main.tf` と一致させる。既存 SAML state の移行とモード切替時は IdP と client の削除・変更がないか plan を確認する。ALB controllerと同一リージョンのACM証明書が必要。

`CERTIFICATE_ARN`, `OPERATOR_CIDR`, `USER_POOL_ARN`, `USER_POOL_CLIENT_ID`, `USER_POOL_DOMAIN`, `UI_HOST` を設定し、`node aws/sso/render-ingress.cjs | kubectl --context CONTEXT apply -f -` を各クラスターで実行する。IngressのALB DNS名を `UI_HOST` に登録する。callback URLと証明書はそのホストと一致させる。許可CIDRでHTTPSの入口を制限する。ALB以外のクラスター内通信やkubectl port-forwardはSSOを通らないため、RBAC・ネットワークを制限する。

## Terraform 設定検証

実構成で `terraform -chdir=aws/infra init -backend=false -lockfile=readonly` と `terraform -chdir=aws/infra validate`、SSO も同じように init / validate を実行する。`terraform -chdir=aws/sso/infra test` はモック provider で local / SAML の分岐を検査し、Terraform 1.7 以降が必要。実 AWS への plan や適用を伴わない。

## SSO試験

```sh
export SALES_AUTH_ENABLED=1
export SALES_AUTH_URL='https://ui.example.com/'
export SALES_AUTH_SUCCESS_URL="$SALES_AUTH_URL"
export SALES_AUTH_SUCCESS_SELECTOR='#refresh'
export SALES_AUTH_STATE='.local/auth/aws-sales.json'
export AWS_SSO_COGNITO_DOMAIN='example.auth.ap-northeast-1.amazoncognito.com'
npm run sales:auth:setup
npx playwright test -c aws/tests/sso.config.ts
```

実際の UI URL と Cognito ドメインに差し替え、下記の DB 接続設定を用意して各リージョンで実行する。認証セットアップは手動ログイン後、別コンテキストとChrome再起動後の再利用を確認する。試験は未認証の画面と受注 API が Cognito に遷移すること、保存状態で販売管理画面と商品 API を利用できることを確認する。専用 DB 商品を作成し、未認証受注後にその商品に受注が存在しないことを確認し、想定外の受注も含め専用行を削除し全受注・商品・在庫を事前状態と照合する。失敗時も後片付けを試み、後片付け失敗は別に報告する。両リージョンで他の受注と同期を停止し、専用検証 DB で実行する。状態なしの新規 context は再認証を要求する。期限切れの状態は検証していない。trace・動画・スクリーンショットは無効。状態ファイルは機密情報として扱う。

ローカル版の7ケースは専用SQLite・ローカルプロセスを使うため、このAWS環境を自動的に試験しない。AWS上の業務シナリオとDB照合は別途追加が必要。

## 作成前の費用と削除計画

本構成は両リージョンに EKS、ノード、VPC、NAT gateway、Elastic IP、ECR、ALB、Cognito を作り、プライマリに RDS を作る。VPC peering、通信、ログ、DNS、証明書、Controller が生成する関連資源も確認する。自動停止や予算上限による自動削除はない。予算 2,000 円では長時間の稼働を前提にしない。料金はリージョン、時間、為替、転送量に依存し、構築を承認する前に AWS Pricing Calculator と料金画面で確認する。[EKS 料金](https://aws.amazon.com/eks/pricing/) は標準サポートでクラスターあたり $0.10/時、延長サポートでは $0.60/時を示す。[ALB 料金](https://aws.amazon.com/elasticloadbalancing/pricing/) は端数時間を 1 時間として扱い LCU 課金もある。作業時間の概算は準備 1〜2 時間、構築 1〜2 時間、試験 1〜2 時間、削除・残存確認 1〜2 時間で、合計 4〜8 時間を見込む。これは実測ではなく、権限や DNS の反映待ち、障害時にはさらに延長する。金額や所要時間は保証できない。

削除の正式な入口と、state の保持、ALB Controller 稼働中の Ingress 削除、残存確認、再実行の手順は [AWS 削除と残存確認](cleanup/CLEANUP.md) を使う。共有ドメイン・証明書は保護し、実環境の削除と確認は未実施。

手動認証と再利用の検証は次の順で行う。Given: 保存状態なし、When: 上記 `sales:auth:setup` で Chrome を開き手動ログイン、Then: 指定画面を確認して保存し、別 context と Chrome 終了・再起動後の context の両方で同画面を確認する。After: 各 context と Chrome を閉じる。状態は `.local/` 内に保存され mode 600、ディレクトリ作成時 mode 700。試験終了後にローカルの状態ファイルを削除する。状態なしの別 context の再認証は AWS 試験の未認証 UI ケースで確認する。

未認証受注テストは `AWS_SSO_DB_HOST`、`AWS_SSO_DB_USER`、`AWS_SSO_DB_PASSWORD`、`AWS_SSO_DB_CA_FILE` を安全に設定し、専用 DB への TLS 検証付き接続を必要とする。DB ユーザーには sales_lock のロック、products・inventory・orders の SELECT、専用行の INSERT と DELETE 権限が必要。接続経路・CA・データの取り扱いは事前に確認する。テスト前後に次の全行を比較する。結果や認証情報をログに出さない。

```sql
SELECT order_id, product_code, quantity, unit_price, status FROM orders ORDER BY order_id;
SELECT product_code, quantity FROM inventory ORDER BY product_code;
SELECT product_code, name, price, active, version FROM products ORDER BY product_code;
```

クエリ結果の全行が一致しない場合は失敗として調査する。

受注試験は HTTP を 15 秒、各 DB 操作を 10 秒、DB ロック待ちを 10 秒に制限し、試験全体は後片付け用の余裕を含め 5 分とする。強制終了や DB 通信断では後片付け自体が完了できないことがある。試験開始時の `SSO_PROBE_ID` は秘密ではないランダムな専用商品の識別子であり、未完了時の復旧に使う。失敗または中断後は、他の同期と受注を停止したまま、承認された TLS 検証付きの DB 管理接続でその ID を確認する。プロセスが停止したことと `sales_lock` を取得できることを確認し、次の SQL の `ID` に出力された ID を正確に指定する。最初の SELECT で商品が `SSO test fixture`、価格 1 であること、関連行がその ID だけであることを確認できない場合は削除せず調査する。注文が存在した事実は認証試験失敗として扱い、識別子と件数を記録する。

```sql
SET @probe = 'ID';
START TRANSACTION;
SELECT id FROM sales_lock WHERE id=1 FOR UPDATE;
SELECT product_code, name, price, active, version FROM products WHERE product_code=@probe;
SELECT product_code, quantity FROM inventory WHERE product_code=@probe;
SELECT order_id, product_code, quantity, unit_price, status FROM orders WHERE product_code=@probe;
-- 上記の所有関係を確認した後にだけ実行する。
DELETE FROM orders WHERE product_code=@probe;
DELETE FROM inventory WHERE product_code=@probe;
DELETE FROM products WHERE product_code=@probe AND name='SSO test fixture' AND price=1;
COMMIT;
SELECT product_code FROM products WHERE product_code=@probe;
SELECT product_code FROM inventory WHERE product_code=@probe;
SELECT order_id FROM orders WHERE product_code=@probe;
```

各結果が空になることを確認する。中断が削除前後のどちらでも同じ ID で再実行できる。結果が不明、DB エラー、対象不一致の場合は成功とせず調査を続ける。強制終了時には試験プロセス内の全表比較も完了していない可能性があり、専用行が消えただけでは DB 全体が元の状態だったと証明できない。別途保持した実行前の全表結果と比較するか、専用検証 DB を初期状態に再構築する。
