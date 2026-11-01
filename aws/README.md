# 販売管理デモのAWS構成

現行の `demo/sales` の画面と上流データを、2リージョンのEKS・共有RDS MySQL・各リージョンのモックで動かす。Web入口は各リージョンのALBとCognitoで企業SAML IdPへ認証を委ねる。**旧デモは使わない。** ローカル版はSQLite、AWS版はMySQLを使う。同期と受注はRDSのロック行を使って両リージョン間で直列化する。

実AWS・実IdPでの適用は未実施。Terraform validate済み。planは未実施。EKS、NAT、RDS等に課金される。RDSはデモ用設定で自動バックアップなし、削除時の最終スナップショットなし。既存データがある環境に適用しない。秘密情報はGitやログに含めない。

## 構築準備

Terraform、AWS CLI、Docker、kubectl、Node 26以上、Google Chromeが必要。AWSの検証用アカウントと適切な権限を用意する。各リージョンのEKSにAWS Load Balancer Controllerを導入する（Cognito利用に必要な `cognito-idp:DescribeUserPoolClient` 権限を含む）。両リージョンに公開DNS名、同リージョンのACM証明書、企業IdPのSAMLアプリ設定を用意する。Terraform stateには機密情報が含まれるため、アクセスを制限して管理する。

1. `aws/infra/terraform.tfvars.example` を参考に、専用のtfvarsに実際のCIDR・リージョン・両リージョンでサポートされるEKSバージョンを設定する。`terraform -chdir=aws/infra init`、`terraform -chdir=aws/infra plan -var-file=YOUR_TFVARS` で確認後、承認された環境にapplyする。
2. Terraform outputの両EKS名で `aws eks update-kubeconfig` を実行し、両クラスターへの管理アクセスを用意する。各ECRの `app_ecr_url` / `secondary_app_ecr_url` に、同じソースからビルドしたイメージを別々にpushする。AWS CLIの認証後、例として `docker build --platform linux/amd64 -f aws/sales/Dockerfile -t IMAGE .` と `docker push IMAGE` を用いる。ECRへのdocker loginは各リージョンで行う。
3. RDS上にTLS必須の専用DBユーザーを作成する。初回のschema作成には `integration_demo` に対するCREATE、SELECT、INSERT、UPDATE権限が必要。初期化後はCREATEを取り除く。DB管理者の接続・ユーザー作成は利用環境の許可された管理経路で行う。アプリはRDSエンドポイント名とCAによるTLS証明書検証を行う。
4. 両クラスターの `integration-demo` namespaceに同じDB専用ユーザーのSecret `sales-db`（キー `username`, `password`）、32文字以上のランダムなSecret `sales-mock`（キー `token`）、AWSのRDS CAバンドルを含むConfigMap `rds-ca`（キー `global-bundle.pem`）を登録する。各リージョンのモック用トークンは別にしてよい。Secretは引数・履歴に平文を書かず、安全なファイルや承認されたシークレット管理を使用する。クラスター内のモック管理APIへのアクセスはKubernetesの権限・ネットワークで制限する。
5. 対象リージョンのイメージ参照を `SALES_IMAGE`、共有RDSの完全修飾名を `DB_HOST` に設定し、`node aws/render-sales.cjs | kubectl --context CONTEXT apply -f -` を各クラスターで実行する。namespaceはSecret登録前に `kubectl --context CONTEXT create namespace integration-demo` で先に作成する。初回のみ、プライマリ側で `kubectl --context CONTEXT -n integration-demo exec deployment/sales-app -- node aws/sales/runtime.ts schema` を実行する。`sales-app` のpodが起動してから実行し、両クラスターのrolloutを確認する。
6. 同期は各リージョンの `sales-batch` CronJobから明示実行する。例: `kubectl --context CONTEXT -n integration-demo create job --from=cronjob/sales-batch sales-initial-sync`、その後 `kubectl --context CONTEXT -n integration-demo wait --for=condition=complete job/sales-initial-sync --timeout=180s`。最初に一度同期する。CronJobはsuspendされ、自動実行しない。

## SSO入口

各リージョンで別のTerraform stateを使い、`aws/sso/infra` の `region`, `name`, `cognito_domain_prefix`, `ui_host`, `saml_metadata_url` を設定してplan後applyする。`saml_entity_id` と `saml_acs_url` をIdP管理者に登録して試験ユーザーを割り当てる。メール属性URIは `main.tf` と一致させる。ALB controllerと同一リージョンのACM証明書が必要。

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
npm run aws-sales:test
```

実際のUI URLとCognitoドメインに差し替え、各リージョンで実行する。認証セットアップは手動ログイン後、別コンテキストとChrome再起動後の再利用を確認する。試験は未認証の画面・受注APIがCognitoへリダイレクトされること、保存状態で販売管理画面を表示し、不正な受注が400で拒否されることを確認する。DBに受注を登録しない。trace・動画・スクリーンショットは無効。状態ファイルは機密情報として扱う。

ローカル版の7ケースは専用SQLite・ローカルプロセスを使うため、このAWS環境を自動的に試験しない。AWS上の業務シナリオとDB照合は別途追加が必要。

## 上流モードと試験データの切替

`SALES_UPSTREAM_MODE=upstream`（既定）は学習用の通常HTTP IF、`mock` は管理APIで障害を注入できるモックを配置する。どちらも本番外部サービスではない。`SALES_IMAGE` と `DB_HOST` に加えてこの値を指定し、各リージョンで `node aws/render-sales.cjs | kubectl --context CONTEXT apply -f -` を実行し、`kubectl --context CONTEXT -n integration-demo rollout status deployment/sales-upstream` を確認する。描画・適用はカタログをF1に戻すので、別試験と同時に実行しない。

`tests/aws-sales/fixture.ts` は `f1`, `f2`, `bulk1`, `bulk2` を生成する。ConfigMap更新例（試験専用クラスターでのみ使用）:

```sh
node tests/aws-sales/fixture.ts f2 > /tmp/sales-catalog.json
kubectl --context CONTEXT -n integration-demo create configmap sales-catalog \
  --from-file=catalog.json=/tmp/sales-catalog.json --dry-run=client -o yaml | \
  kubectl --context CONTEXT -n integration-demo apply -f -
```

ConfigMapの反映は即時ではない。全upstream Podの `/catalog` が期待値を返すことを確認してから同期する。試験後はF1に戻し、実際の応答で復元を確認する。モックのステータスはPod内のメモリに保持されるため、障害注入後は元の値に戻し応答を確認する。両リージョンのサービスはそれぞれ独立しているがDBは共有であり、他リージョンのバッチ・画面操作も停止すること。

`tests/aws-sales/db.ts` にMySQLの一貫した4表スナップショット、固定期待値との全件照合、試験間の協調用MySQL advisory lockを用意している。advisory lockはこのロックを使わない通常業務やバッチを止めないため、専用環境の隔離が別途必要。現時点ではこの部品はAWSの7ケース、DB初期化・故障注入・復元処理には接続されていない。既存データを対象に手動で初期化や故障注入を行わない。
## 利用後の削除

構築前に [削除・途中失敗時の片付け・残存確認](cleanup/CLEANUP.md) を準備する。専用stateとリソース識別子を保持し、IngressとALBを先に片付けてからTerraform stateを削除する。AWSでの片付け手順は未検証。
