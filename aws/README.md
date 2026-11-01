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

実際のUI URLとCognitoドメインに差し替え、各リージョンで実行する。認証セットアップは手動ログイン後、別コンテキストとChrome再起動後の再利用を確認する。試験は未認証の画面と受注 API が Cognito に遷移し、認証済み API で比較した商品の状態が変わらないこと、保存状態で販売管理画面と商品 API を利用できることを確認する。試験中は他の更新を停止する。未認証要求は受注を作成しない前提で、在庫不変だけでは DB の全受注レコードの不在までは証明できない。状態なしの新規 context は再認証を要求する。期限切れの状態は検証していない。trace・動画・スクリーンショットは無効。状態ファイルは機密情報として扱う。

ローカル版の7ケースは専用SQLite・ローカルプロセスを使うため、このAWS環境を自動的に試験しない。AWS上の業務シナリオとDB照合は別途追加が必要。

## 作成前の費用と削除計画

本構成は両リージョンに EKS、ノード、VPC、NAT gateway、Elastic IP、ECR、ALB、Cognito を作り、プライマリに RDS を作る。VPC peering、通信、ログ、DNS、証明書、Controller が生成する関連資源も確認する。自動停止や予算上限による自動削除はない。予算 2,000 円では長時間の稼働を前提にしない。料金はリージョン、時間、為替、転送量に依存し、構築を承認する前に AWS Pricing Calculator と料金画面で確認する。[EKS 料金](https://aws.amazon.com/eks/pricing/) は標準サポートでクラスターあたり $0.10/時、延長サポートでは $0.60/時を示す。[ALB 料金](https://aws.amazon.com/elasticloadbalancing/pricing/) は端数時間を 1 時間として扱い LCU 課金もある。作業時間の概算は準備 1〜2 時間、構築 1〜2 時間、試験 1〜2 時間、削除・残存確認 1〜2 時間で、合計 4〜8 時間を見込む。これは実測ではなく、権限や DNS の反映待ち、障害時にはさらに延長する。金額や所要時間は保証できない。

適用前に専用 state を識別し、アクセス制限とバックアップを確保する。基盤は `aws/infra` の state、Cognito は `aws/sso/infra` のリージョンごとに別 state（例: `terraform -chdir=aws/sso/infra ... -state=/secure/path/sso-REGION.tfstate`、各コマンドで同じ state と変数を使用）。リモート backend の場合は別 key を使う。state は client secret を含むため公開しない。基盤と両 SSO の state 名、リージョン、cluster、Ingress、ALB ARN/DNS、user pool/domain、DNS record、その他課金資源の ID を削除前に記録する。共有 DNS zone・ドメイン・ACM 証明書は所有資源ではなく削除対象に含めない。

削除は構築直後に開始できるよう、担当者と次の手順を事前に準備する。各コマンドの失敗を無視しない。失敗や残存があればその対象を記録し非ゼロ終了し、解消後に同じ対象から再実行する。途中で state を消さない。実行前に context、アカウント、リージョンと対象を確認する。

1. 各 cluster の Controller が稼働中に `python3 aws/cleanup/ingress.py --account ACCOUNT --region REGION --context CONTEXT --alb ALB_ARN` を実行する。AWS アカウントと Ingress に紐づく ALB の DNS 名を照合し、Ingress 削除を待ち、記録した ALB の LoadBalancerNotFound を確認する。失敗・残存時は非ゼロと再実行対象を表示する。Ingress が既にない場合も ALB の消滅確認を再実行できる。両 ALB が消える前に EKS を削除しない。
2. 作成した DNS record だけを DNS 管理側で削除し、不在を確認する。共有 zone、ドメイン、ACM 証明書を削除しない。
3. 各リージョンの SSO state に対し同じ変数・backend を指定し `terraform destroy`。Terraform の終了コードと `terraform state list` の空を確認する。記録した user pool と Cognito domain も AWS API で不在を確認する。アクセス拒否などは失敗として扱う。
4. 基盤 state で同じ変数・backend を指定し `terraform destroy`。終了コードと `terraform state list` の空を確認する。失敗した場合は残存資源を特定して同じ state で再実行する。
5. Terraform 以外で作成された資源も、両リージョンの ALB、target group、EKS、EC2、EBS、NAT gateway、Elastic IP、RDS、snapshot、ECR image、CloudWatch logs、Cognito、DNS を AWS コンソールまたは CLI で確認する。課金画面も後日確認する。削除対象が残ればその ID を記録して非ゼロとし、所有権を確認して削除を再実行する。共有資源は削除しない。

Ingress/ALB 以外の手順は手動チェックであり、一括削除スクリプトや全資源の残存自動判定は提供していない。実 AWS での削除・費用・所要時間は未検証。


手動認証と再利用の検証は次の順で行う。Given: 保存状態なし、When: 上記 `sales:auth:setup` で Chrome を開き手動ログイン、Then: 指定画面を確認して保存し、別 context と Chrome 終了・再起動後の context の両方で同画面を確認する。After: 各 context と Chrome を閉じる。状態は `.local/` 内に保存され mode 600、ディレクトリ作成時 mode 700。試験終了後にローカルの状態ファイルを削除する。状態なしの別 context の再認証は AWS 試験の未認証 UI ケースで確認する。

未認証受注で DB が不変であることは、他の受注・同期を停止し、承認された TLS 検証付き管理経路の読み取り専用接続で、受注要求前後に次の同じクエリを実行して全行を比較する。行数のみの比較では不十分。結果に機密が含まれない環境で行い、認証情報を履歴やログに出さない。

```sql
SELECT order_id, product_code, quantity, unit_price, status FROM orders ORDER BY order_id;
SELECT product_code, quantity FROM inventory ORDER BY product_code;
SELECT product_code, version FROM products ORDER BY product_code;
```

クエリ結果の全行が一致しない場合は失敗として調査する。テストによる商品比較だけでは orders 全行の不変を証明できない。
