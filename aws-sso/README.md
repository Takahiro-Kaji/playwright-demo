# AWS Web UI SSO 検証

旧 AWS デモの `demo-app` に HTTPS の ALB + Cognito + 社内 SAML IdP を追加する。Cognito のアプリクライアントは社内 IdP のみを許可し、ALB は全パスで認証後に転送する。操作 API も同じ経路を通す。**実 AWS・実 IdP では未検証**。本構成は検証用であり、利用者権限の細分化は行わない。

前提: 旧デモの EKS とアプリ、AWS Load Balancer Controller（Cognito のための `cognito-idp:DescribeUserPoolClient` 権限を含む）、公開 DNS 名、同一リージョンの検証済み ACM 証明書、社内 IdP の SAML metadata URL と管理者協力。各リージョンは個別の ALB、Cognito、証明書、DNS 名が必要。ここでは一つのリージョンずつ設定する。Cognito と ALB の通信や AWS サポートリージョンの条件も確認する。費用が発生するため適用前に Terraform plan を確認する。

1. `infra` で `terraform init` 後、`region`, `name`, `cognito_domain_prefix`, `ui_host`, `saml_metadata_url` を tfvars 等で指定し `terraform plan` を確認、`terraform apply` する。Cognito domain prefix は AWS 内で一意にする。Terraform state にはクライアントシークレットが含まれるので、アクセスを制限し Git や証跡に入れない。複数リージョンでは別 state を使う。
2. `terraform output saml_entity_id` と `terraform output saml_acs_url` を IdP 管理者に渡し、SAML アプリを設定して試験ユーザーを割り当てる。メールアドレスの SAML 属性 URI は `infra/main.tf` のマッピングと一致させる。metadata URL は Cognito から取得可能な HTTPS URL とする。
3. 対象クラスターを指定して以下の環境変数を設定する。AWS 認証情報は AWS CLI の通常のプロファイルで用意する。

```bash
export UI_HOST='ui.example.com' CERTIFICATE_ARN='arn:aws:acm:REGION:ACCOUNT:certificate/ID' OPERATOR_CIDR='198.51.100.20/32'
export USER_POOL_ARN="$(terraform -chdir=aws-sso/infra output -raw user_pool_arn)"
export USER_POOL_CLIENT_ID="$(terraform -chdir=aws-sso/infra output -raw user_pool_client_id)"
export USER_POOL_DOMAIN="$(terraform -chdir=aws-sso/infra output -raw user_pool_domain)"
node aws-sso/render-ingress.cjs | kubectl --context YOUR_CONTEXT apply -f -
```

ALB の DNS 名を `kubectl -n integration-demo get ingress demo-app-sso` で確認し、`UI_HOST` をそこに DNS 登録する。証明書と callback URL は必ずこのホストと一致させる。`/healthz` はターゲットのヘルスチェック用であり、ALB 経由の一般リクエストには認証が適用される。

4. リポジトリルートで Node 26 以上と Chrome を使い、手動認証を保存する。

```bash
export SALES_AUTH_STATE='.local/auth/aws-ui.json'
export SALES_AUTH_URL="https://${UI_HOST}/"
export SALES_AUTH_SUCCESS_URL="$SALES_AUTH_URL"
export SALES_AUTH_SUCCESS_SELECTOR='[data-testid="item-create"]'
npm run sales:auth:setup
export SSO_UI_URL="$SALES_AUTH_URL" SSO_STATE="$SALES_AUTH_STATE"
npx playwright test -c aws-sso/playwright.config.cjs
```

セットアップは別コンテキストと Chrome 再起動後の画面を確認する。テストは未認証の UI・POST API が IdP にリダイレクトされ、保存状態を使う別コンテキストが UI と API にアクセスできることを確かめる。API の確認には不正な入力を送り、DB を変更しない。SSO が失効した場合は再ログインし保存し直す。Cookie や state、認証 URL は機密として扱い、出力や証跡に残さない。実行時 trace、動画、スクリーンショットは無効。

## 境界と制限

ALB は外部からの入口であり、旧デモの `kubectl port-forward`、クラスター内通信、管理権限を持つ利用者には認証を強制しない。Kubernetes RBAC とネットワークを信頼できる管理者・ワークロードに制限し、直接アクセス可能な経路を公開しないこと。旧デモのランダムルーターや既存9ケースは port-forward を使うため SSO を通らない。本検証はそれらの SSO 化ではない。EKS の管理 API、DB、モック管理 API の認証も別である。適用後は各リージョン・origin でそれぞれ確認する。

参考: [ALB の認証](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html)、[AWS Load Balancer Controller の Cognito 連携](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/tasks/cognito_authentication/)。
