# 2リージョン EKS × 共通RDS MySQL × Chrome 結合試験

**ゴール:** AWSの2リージョンにそれぞれアプリPodと外部システムのHTTPモックPodを配置し、共通DBを使用する構成で結合試験を行う。構築ソースと手順を提供する。**AWSリソースの作成・実機検証はまだ実施していない。**

## 今回の前提

| 項目 | 定義 |
| --- | --- |
| リージョン | A=`ap-northeast-1`、B=`ap-northeast-3`を例示。Terraformで変更可能 |
| アプリ／モック | 両リージョンにそれぞれ配置。アプリは同じリージョン内のモックを呼ぶ |
| DB | リージョンAの非公開RDS MySQL **1インスタンスを共用**。レプリカや別DBではない |
| 振り分け | 業務HTTPリクエストごとにA/Bを独立にランダム選択。50%ずつの抽選であり、回数の均等は保証しない |
| モック切替 | リージョンを固定した管理APIをcurlで操作。テストケースで切替する場合、**A/B両方を同じステータスにする** |
| 前提確認 | 設定APIの値だけでなく、各モックへのGETで**実際のHTTPステータス**を確認し、A/B共通の期待値と照合 |
| 本試験 | Chromeの登録API応答を捕捉し、事前の期待HTTPステータスと照合。応答元リージョン／実際のモックステータスも照合 |
| **UI表示** | **期待メッセージの完全一致、実際に表示されること、成功／エラー状態・アクセシビリティの属性を検証。HTTPが正しくてもUIが違えばFAIL** |
| DB確認 | ケース単位で「前後比較」「事後のみ」「確認なし」を選択可能。比較対象はテストキーで絞った全対象行 |

**ランダム振り分けの実装場所:** 初期版は試験端末上の小さなHTTPルーター。2本の `kubectl port-forward` を通じて、AWS上の実アプリへ転送する。**AWS上のグローバルロードバランサーを構築したという意味ではない。** DNSキャッシュ等でリクエスト単位のランダム性が曖昧にならないようにした検証用構成。自動リトライ・別リージョンへのフェイルオーバーは行わず、エラーを隠さない。

```text
ローカル端末: Google Chrome + Playwright + kubectl + curl + mysql
  Browser → localhost:18080（リクエストごとのランダム入口）
              ├→ localhost:18081 → EKS A / demo-app → status-mock A
              └→ localhost:18082 → EKS B / demo-app → status-mock B
                                   │                    │
  EKS A / demo-app ──────────────── 共通 RDS MySQL（A） ←─ EKS B / demo-app
                                               ↑       （リージョン間VPC Peering）
  mysql CLI → localhost:13306 → Aの一時DB中継Pod ─┘

  curl → localhost:19181 → モックA管理API（認証必須）
  curl → localhost:19182 → モックB管理API（認証必須）
  前提GET → localhost:19081 / 19082 → 各モックの業務応答
```

モックの業務レスポンス本文は空。ステータスと診断用ヘッダーだけを返す。管理APIだけは設定情報をJSONで返す。アプリに `mockStatus` を渡して応答を選ぶ旧方式は廃止した。

## ケースの定義と実行順序

[`tests/cases.cjs`](tests/cases.cjs) で前提と期待値を宣言する。期待値は**リクエスト前に固定**し、実際の応答から後付けしない。

| ケース | モックA／B共通の応答 | 期待アプリHTTP | 期待UI表示 | DB |
| --- | --- | --- | --- | --- |
| both-ok | 両方200に切替 | 201 | `作成しました`（正常表示） | 前後差分 +1、内容CREATED |
| both-unavailable | 両方503に切替 | 502 | `外部システムエラー`（エラー表示） | 前後不変 |
| no-switch | 切替なし。両方200が前提 | 201 | `作成しました`（正常表示） | 事後1件確認 |

各ケースを `random`、`a`固定、`b`固定で実行するため、計9ケース。**両リージョンは常に同じモックステータスを期待する**ため、ランダムに振り分けられても期待HTTP・UI・DB結果は同じ。固定実行はランダムで偶然片側しか選ばれない場合に備えた経路別検証で、ランダム実行そのものを置き換えるものではない。

実行順: 現在のモック設定退避 → 必要なリージョンだけcurlで切替 → **両リージョンの実応答が前提どおりか確認** → 任意のDB事前取得 → UI操作 → HTTP応答／リージョン／モック応答を照合 → **UIの表示文言・表示状態・エラー表示の役割を照合** → 任意のDB事後取得・比較 → モックが途中変更・再起動されていないことを確認 → 変更した設定を復元。

- 切替なしでも前提が違えば、ケース失敗として停止する。前ケースの設定を無条件で引き継がない。
- モックごとに `instanceId` と `version` を持ち、事前確認と本試験で一致するか確認。Pod再起動や他実行による状態変更を検出する。
- 失敗時も `finally` で変更済み設定の復元を試みる。復元失敗も記録して失敗扱いにする。
- 各ケースはUUIDのテストキーで分離。DB全件件数の比較で他ケースのデータと混同しない。行のIDは精度を失わないよう文字列で取得する。
- DB不変は最初の0件だけで合格にせず、**2秒間繰り返し比較**する。無期限に変更が起きない証明ではない。非同期業務を追加する場合は完了条件・観測時間を再設計する。
- `workers: 1`、テスト再試行なし。共有モックに対して**別端末・別CIから同時実行しない**。複数Pod化・並列化には外部の設定ストアまたはケースごとのモック隔離が必要。
- 現在のモックは各リージョン1 Pod・Recreate更新・メモリ上の状態。再起動後は200に戻る。

## ファイル

`infra/` は既存のA側基盤に、B側EKS/VPC/ECRとリージョン間Peering・往復経路を追加する。RDSの3306番は両側のノード／PodサブネットCIDRだけに許可する。`services/` はアプリとモック、`k8s/` は配置テンプレート、`helpers/` はルーター・curl制御・DBスナップショット、`scripts/` は構築と試験接続の手順を実行する補助コード。

## 構築手順（実行すると課金）

前提: AWS CLI v2、Terraform >=1.6、Docker（linux/amd64）、kubectl、curl、Node.js >=22、npm、MySQL 8系CLI、インストール済みGoogle Chrome。AWS認証には自分の検証用アカウントのプロファイル／SSOを使用する。権限はIAM、EKS、EC2/VPC/Peering、RDS、ECR、Secrets Manager等が必要。AWS権限・対応バージョンは実行環境で検証する。

**2 EKSクラスタ・4 EC2ノード・2 NAT Gateway・1 RDSなどの料金が発生する。** 非本番専用。データ転送料も確認する。これは高可用性構成ではなく、共通DBはAリージョンへの依存・単一障害点となる。

### 1. 設定・計画

```bash
aws sts get-caller-identity
cp infra/terraform.tfvars.example infra/terraform.tfvars
# operator_cidrを実際のグローバルIPv4/32へ変更。
# 非重複のIPv4 /16を2つ指定。例は10.42.0.0/16と10.43.0.0/16。
aws eks describe-cluster-versions --region ap-northeast-1
aws eks describe-cluster-versions --region ap-northeast-3
# 両リージョンでstandard supportのeks_versionをterraform.tfvarsに設定。
# バージョンは自動選択しない。以前の仮値1.37は既定値から削除した。
terraform -chdir=infra init
terraform -chdir=infra fmt -recursive
terraform -chdir=infra validate
terraform -chdir=infra plan -out=plan.out
# 作成対象・費用・削除設定を確認してから実行
terraform -chdir=infra apply plan.out
bash scripts/configure-kubectl.sh
```

既存環境がある場合もplanの差分を確認する。stateはGitへ保存しない。チーム利用では暗号化・ロック付きリモートstateを設計する。EKS APIは操作端末のCIDRに制限し、アプリ・モック・RDSは外部公開しない。

### 2. 両リージョンにイメージとモックを配置

```bash
bash scripts/build-push.sh            # 両ECRへビルド・push
node scripts/configure-mocks.cjs      # 両namespace・管理用Secretを用意
bash scripts/deploy.sh core           # 両モック、AだけDB中継Pod
```

管理トークンは `~/.config/play-right-demo/mock-admin.token`、curl認証設定は同ディレクトリの `mock-curl.conf` に0600で保存する。Git・コマンド引数・試験証跡にトークンを入れない。管理ポートはClusterIPとローカルport-forwardのみで扱い、インターネットへ公開しない。

### 3. 共通DB初期化と両アプリ配置

```bash
mkdir -p "$HOME/.config/play-right-demo"
curl -fL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  -o "$HOME/.config/play-right-demo/global-bundle.pem"
export RDS_CA_FILE="$HOME/.config/play-right-demo/global-bundle.pem"
node scripts/bootstrap-db.cjs
bash scripts/deploy.sh app
```

DBは一度だけ初期化し、同じDB接続用Secret／CAを両EKSへ登録する。アプリはINSERT/SELECTユーザー、検証はSELECT専用ユーザーを使う。マスター認証はSecrets Managerから取得する。RDSは非公開・TLS利用。ローカルDBトンネルは `VERIFY_CA`（localhostがRDSの証明書名と一致しないため）であり、ホスト名検証まで行う `VERIFY_IDENTITY` と同等ではない。アクセスするAWSアカウントとkubectlコンテキストも確認する。

再初期化はDBパスワードを変更する。既に動いている**両リージョンのアプリPod**をその後明示的に再起動し、Readyを確認する。途中失敗した場合は両SecretとDBを再同期してから試験する。

```bash
# 初期化を再実行した場合だけ。実際のcluster_nameに合わせる。
kubectl --context play-right-demo-eks -n integration-demo rollout restart deployment/demo-app
kubectl --context play-right-demo-b-eks -n integration-demo rollout restart deployment/demo-app
```

### 4. 接続と試験

```bash
npm install
bash scripts/configure-test-env.sh # 旧.envは退避してから。上書きしない。
npm run test:unit
npm run test:syntax
npm run test:list                # 9ケースを確認
```

ターミナルA:

```bash
node scripts/port-forward.cjs   # 7本の転送とローカルランダムルーター。Ctrl+Cで終了。
```

ターミナルB:

```bash
npm run test:integration
npm run report
# 特定ケースだけ:
npm run test:integration -- --grep 'random / both-unavailable'
```

Playwrightは `channel: 'chrome'` のみを使う。各ケースの `case-evidence.json` に期待値、モック前提、HTTPステータス／応答元、**期待UIと実際の表示**、DB前後、復元結果を残す。スクリーンショット／トレースは失敗時保存。ダミーデータのみ使用し、証跡を公開しない。

## curlでモックの応答を切り替える

前項のport-forwardが起動中であること。**両リージョンを同じ503にする例（テストケースの前提に合わせる）:**

```bash
curl --disable --config "$HOME/.config/play-right-demo/mock-curl.conf" \
  --silent --show-error --fail-with-body --request PUT \
  --header 'Content-Type: application/json' \
  --data '{"status":503}' http://127.0.0.1:19181/admin/status
curl --disable --config "$HOME/.config/play-right-demo/mock-curl.conf" \
  --silent --show-error --fail-with-body --request PUT \
  --header 'Content-Type: application/json' \
  --data '{"status":503}' http://127.0.0.1:19182/admin/status

# 管理設定を読む
curl --disable --config "$HOME/.config/play-right-demo/mock-curl.conf" \
  --silent --show-error --fail-with-body http://127.0.0.1:19181/admin/status

# 実際の業務HTTPステータスを確認（503自体が期待結果なので--failは付けない）
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  http://127.0.0.1:19081/status
```

Bの管理は `19182`、業務応答は `19082`。元に戻すには**両方の管理ポート**に `{"status":200}` をPUTする。管理APIのHTTP 200は「設定操作の成功」であり、業務の応答ステータス503とは別。200〜599の整数を設定可能。業務API `/status?code=...` からの応答上書きは禁止。

## 検証状況と残作業

前回の構成でローカル単体テスト7件とJavaScript／Shell構文検査を実施。今回の変更でUI表示の単体テストを追加し、正常・異常・通信エラーの表示を確認できるようにした。2つの実HTTPアプリ・2つのモック・実curl・ローカルルーターの連携を検証したが、DBは単体試験用アダプターでありRDSではない。MySQL CLI組立ては模擬コマンドで検証。

**Terraform validate/plan、コンテナビルド、Chromeでの9ケース実行、リージョン間通信、AWS上の実MySQL照合は未実施。** 現在の作業環境にはTerraform／Chrome等がなく、外部配布サーバーへの接続もできなかった。ソースのローカル試験とAWS実機試験を混同しない。

次の受入条件は、両EKSのReady、B→共通RDSの接続、curl切替／復元、9ケースのPASSと証跡（HTTP・UI・DB）、削除完了。ランダム試験での応答回数が必ず半々になることは受入条件にしない。

## 削除

試験接続をCtrl+Cで停止し、専用検証環境でデータ消失が許されることを確認する。

```bash
bash scripts/remove-db-tunnel.sh
terraform -chdir=infra plan -destroy
terraform -chdir=infra destroy
```

両リージョンのEKS/EC2/NAT/EIP/ECRとPeering、AのRDS/Secrets Managerが残っていないか確認する。RDSは最終スナップショットなし・バックアップ保持0日というデモ設定。テストデータは自動削除しない。必要な証跡は秘密情報の扱いに注意して退避し、不要なローカル認証ファイルも削除する。

## 公式資料

- [VPC Peering: 往復ルート・非重複CIDR](https://docs.aws.amazon.com/vpc/latest/peering/vpc-peering-basics.html)
- [リージョン間では相手SGを参照できないためCIDRを使う](https://docs.aws.amazon.com/vpc/latest/peering/vpc-peering-security-groups.html)
- [Terraform: cross-region peering accepter](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/vpc_peering_connection_accepter)
- [Playwright: 応答を捕捉してステータスを検証](https://playwright.dev/docs/network)
- [EKS対応バージョン](https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html)
