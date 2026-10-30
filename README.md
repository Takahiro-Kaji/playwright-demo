# AWS EKS × Playwright（Google Chrome）× kubectl × RDS MySQL — 結合試験デモ

> **リポジトリの最終ゴール:** AWS上にデモアプリ・HTTPモックサーバー・外部MySQLの検証環境を**構築可能なソースとして定義**し、そのAWS環境を対象に Playwright（Google Chromeのみ）・`kubectl`・`mysql` CLI を組み合わせた**結合試験の成功を証跡付きで確認する**こと。
>
> **2026-10-30時点:** 構築用ソース・手順・試験コードを提供する段階。AWSリソースは**作成していない**。実AWSでの動作、費用、必要権限は未検証。

## 構成図

```text
ローカル試験端末（Node 22+ / Google Chrome / kubectl / mysql CLI）
   ├── Playwright → localhost:18080 → kubectl port-forward ─────────┐
   ├── kubectl → EKS Deployment / Pod 状態確認                       │
   └── mysql CLI → localhost:13306 → kubectl port-forward ────────┐ │
                                                                │ │
AWS VPC ──────────────────────────────────────────────────────── │ │ ─────────
  Amazon EKS（private subnet）                                    │ │
     ├── demo-app (Node.js) ←─────────────────────────────────────┘ │
     │     ├── GET /items/new（ブラウザ画面）                        │
     │     ├── HTTP呼出 → status-mock:8081/status?code=200|503        │
     │     └── MySQL INSERT ───────────────────┐                     │
     ├── status-mock（返すのは HTTP ステータスのみ）                  │
     └── db-tunnel（認証情報なしの一時TCPプロキシ） ←─────────────────┘
                                              │
  Amazon RDS for MySQL（private DB subnet） ←──┘

  Amazon ECR (demo-app / status-mock イメージ保管)
```

- **EKS:** デモアプリ、ステータスのみ返すモックサーバー、必要時だけ使うDB中継Pod。
- **RDS for MySQL:** EKSのVPC内からしかアクセスできない外部DB（パブリックアクセスなし）。
- **モックサーバー:** `GET /status?code=200` → **HTTP 200**、`?code=503` → **HTTP 503**。**レスポンス本文・業務ロジック・永続化はなし**。
- **Playwright:** **Google Chromeのみ**を使い、画面操作・画面の結果・RDS保存結果を確認。スクリーンショットとトレースは失敗時に保存。
- **試験実行端末:** 今回の基本手順では手元PC。**検証対象のシステムはAWS上**。将来ブラウザ実行環境自体をAWSへ移す場合は別途設計する。

## ゴールと受入条件

| ID | 到達点 | 判定に使う証跡 |
| --- | --- | --- |
| AWS-1 | TerraformでEKS、RDS MySQL、ECR、VPCを作成できる | `terraform apply` 成功、AWSリソースの状態 |
| AWS-2 | EKS上の`demo-app`・`status-mock`がReady | `kubectl rollout status` と Deployment 状態 |
| IT-1 | Chrome画面で作成し、HTTPモックが200を返し、MySQLに1件保存 | Playwright試験 PASS、DB `COUNT(*)=1` |
| IT-2 | HTTPモックが503を返すと、画面は外部エラーになり、DBには保存されない | Playwright試験 PASS、DB `COUNT(*)=0` |
| OPS-1 | GitHubに秘密情報が含まれず、AWSの後片付け手順が存在 | `.gitignore`、構築・削除手順の確認 |

**実AWS試験は未実施のため、上表の判定は今のところ未達／未確認です。** ローカルのモック・DBコマンド組立ての単体試験と、実AWSでの結合試験を混同しません。

## ソースの配置

| パス | 内容 |
| --- | --- |
| [`infra/`](infra/) | TerraformによるAWS VPC / EKS managed node group / RDS MySQL / ECR |
| [`services/demo-app/`](services/demo-app/) | テスト用画面、登録API、MySQL書込み処理、DB接続用TCP中継 |
| [`services/status-mock/`](services/status-mock/) | HTTPレスポンスステータスだけ返す最小モック |
| [`k8s/`](k8s/) | EKS Deployment / Service のテンプレート（外部公開しないClusterIP） |
| [`scripts/`](scripts/) | ECRビルド、EKSデプロイ、MySQL初期化、port-forward、削除補助 |
| [`tests/`](tests/) | Playwright結合試験、ローカル単体試験 |
| [`sql/`](sql/) | MySQL検証SQL |

## 実行前に重要な注意

**この作業は有料AWSリソースを生成します。** EKSのクラスタ料金、EC2ノード、NAT Gateway、RDS、ECR、データ転送などは稼働中課金されます。`terraform apply` やビルド／デプロイは明示的に自分で実行してください。検証後は必ず下記の削除手順を実行してください。Terraformは支出上限を自動設定しません。

- **前提:** AWS CLI v2、Terraform >=1.6、Docker（linux/amd64ビルド対応）、`kubectl`、Node.js >=22、npm、MySQL 8系CLI、Google Chrome、curl。Macでは各ツールの適切なインストールが必要です。
- **AWS認証:** IAMのVPC / IAM Role / EKS / EC2 / NAT / RDS / ECR / Secrets Manager の作成・操作権限。ローカルのAWSプロファイルやSSOを使用。AWSアクセスキーやRDSパスワードをGitHubにコミットしないでください。
- **ネットワーク:** EKS API公開エンドポイントは**指定した操作端末のグローバルIPv4 `/32` のみに制限**。インターネット回線やIPが変わると接続できなくなります。Private endpointも有効です。
- **環境:** 非本番の専用AWSアカウント／VPCが望ましく、実データは使用しません。
- **設計の簡素化:** NATは1台、RDSはシングルAZ、ノードは2台、外部LoadBalancerなし。**可用性・本番運用の構成ではありません。**

## AWS作成から結合試験まで

以下はリポジトリのルートで実行します。**AWSへ新規リソースを作成するのはステップ2以降です。**

### 1. AWSアカウントとTerraform設定

```bash
aws sts get-caller-identity        # 意図した AWS アカウントか必ず確認
cp infra/terraform.tfvars.example infra/terraform.tfvars
# infra/terraform.tfvars の operator_cidr を現在のグローバルIPv4/32に変更
# 例: curl -4 https://checkip.amazonaws.com
terraform -chdir=infra init
terraform -chdir=infra fmt -check
terraform -chdir=infra validate
terraform -chdir=infra plan -out=plan.out
```

EKSバージョンはソース初期値で `1.37`。利用するリージョンで **standard support** の対応バージョンを事前確認してください（`aws eks describe-cluster-versions --region ap-northeast-1`）。サポート外や追加延長料金の発生する旧版を選ばないでください。

### 2. AWSインフラ作成（ここから課金）

```bash
terraform -chdir=infra apply plan.out
./scripts/configure-kubectl.sh
```

EKSノードがReadyになることを確認します。`terraform.tfstate`は秘密情報を含み得るため、Git管理外で安全に保管します。チーム利用では暗号化されたリモートstateとロックの仕組みを追加してください。

### 3. ECRへイメージを登録し、EKSへモック・DB接続Podを配置

```bash
./scripts/build-push.sh
./scripts/deploy.sh core
```

ローカルに生成した `.deploy.env` にイメージURIを記録します。このファイルはGit管理外です。`status-mock` と `db-tunnel` を `integration-demo` namespace に配置します。アプリ本体はDB初期化後に配置します。

### 4. RDS MySQLの初期化・DBユーザー作成

RDS認証で使うCA証明書を[AWS公式RDS Trust Store](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem)から取得します。

```bash
mkdir -p "$HOME/.config/play-right-demo"
curl -fL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  -o "$HOME/.config/play-right-demo/global-bundle.pem"
export RDS_CA_FILE="$HOME/.config/play-right-demo/global-bundle.pem"
node scripts/bootstrap-db.cjs
```

この操作は一時的に `kubectl port-forward` を開いてRDSに接続し、`items` テーブルと次の2ユーザーを用意します。

- `demo_app`：INSERT/SELECTのみ。Kubernetes Secretの`app-db`にパスワードを保存し、アプリから参照します。
- `integration_ro`：SELECTのみ。ローカルの `~/.config/play-right-demo/mysql-readonly.cnf` に`0600`で認証設定を保存します。

RDSマスター認証はSecrets Managerが管理し、Terraform stateに平文のマスターパスワードを入れません。MySQLには認証付きTLSを使用します。ローカルport-forwardではRDSの接続先名と`localhost`が一致しないため、CLIの証明書検証は`VERIFY_CA`で行います。RDS自体へのパブリック接続は開きません。

> **注意:** 繰り返し実行するとデモ用DBユーザーのパスワードがローテーションされます。旧アプリPodを再起動または再デプロイしてください。`integration_ro`の古い認証設定も上書きされます。

### 5. デモアプリをEKSに配置

```bash
./scripts/deploy.sh app
kubectl --context play-right-demo-eks -n integration-demo get deploy,svc,pods
```

### 6. Google Chrome＋kubectl＋MySQLの結合試験

初回のみ：

```bash
npm install
./scripts/configure-test-env.sh   # .envを初期作成。既存.envは上書きしません
npm run test:unit
npm run test:syntax
```

**ターミナルA**（試験中は起動したまま）：

```bash
node scripts/port-forward.cjs
```

**ターミナルB**：

```bash
npm run test:integration
npm run report
```

`playwright.config.cjs` は `channel: 'chrome'` を指定し、**インストール済みGoogle Chrome**を使用します。Chromium・Firefox・WebKitのインストールは不要です。`npm run test:integration:headed` を使えば画面を表示できます。

- 正常系：UI → EKSアプリ → モック**200** → RDS**1件** → PASS
- 異常系：UI → EKSアプリ → モック**503** → UIにエラー → RDS**0件** → PASS
- `kubectl rollout status` とDeploymentの実際のReady数も検証し、試験失敗時には `playwright-report/` と `test-results/` に証跡を残します。**証跡は外部への公開を避けてください。**

## 後片付け（必須）

1. 起動中の `scripts/port-forward.cjs` をCtrl+Cで停止。
2. **データ消失が許容される、対象の専用デモ環境であることを確認**。
3. 下記を実行。

```bash
./scripts/remove-db-tunnel.sh
terraform -chdir=infra plan -destroy
terraform -chdir=infra destroy
```

ECR内イメージもTerraform側で削除対象です。RDSは`skip_final_snapshot=true`かつ`backup_retention_period=0`なので、**DBの保存データは復旧できない可能性があります**。専用の非本番環境以外には使わないでください。`terraform destroy`後にAWSコンソール等でEKS / EC2 / NAT Gateway / EIP / RDS / ECR / Secrets Manager等の残存と課金を確認してください。

## テスト設計上の制約と今後

- **このリポジトリはデモであり、実AWSでの成功を主張しません。** Terraformの実applyやECRへのPush、RDS接続、EKS上での結合試験はAWSアクセス可能な環境での確認が必要です。
- 最小モックは200/503を返すだけで、レスポンス本文・スキーマ・外部システムの業務ロジックを再現しません。
- トランザクションは実アプリが「モック成功後にDBへINSERT」するだけです。分散トランザクションや耐障害性は対象外です。
- 実環境のDB接続やKubernetes RBAC権限は最小化してください。DB中継Podはテスト後削除可能ですが、再試験には再配置が必要です。
- 試験データはUUIDで識別します。自動削除しません。検証環境を削除するか、管理者が定期的に削除する運用にしてください。
- CIではローカル単体試験と構文検査のみ実行します。AWSへの勝手なデプロイや利用料金の発生はありません。

## 公式ドキュメント

- [Amazon EKS: Kubernetes versions](https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html)
- [Amazon EKS: Cluster endpoint access](https://docs.aws.amazon.com/eks/latest/userguide/config-cluster-endpoint.html)
- [RDS: Manage master passwords with Secrets Manager](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-secrets-manager.html)
- [Playwright: Google Chrome channel](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge)
- [Terraform AWS provider documentation](https://registry.terraform.io/providers/hashicorp/aws/latest/docs)
