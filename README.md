# Playwright × kubectl × MySQL：結合試験デモ

**Google Chromeのみ**で画面操作し、Kubernetes の Deployment が稼働していることと、外部 MySQL に業務データが保存されたことを1つの Playwright 試験で検証する雛形です。**接続先・画面要素・テーブル名は仮の値であり、実環境では未実行**です。

## 試験の流れ

1. `kubectl --context ... rollout status deployment/...` と `kubectl get deployment` で対象 Deployment の Ready 状態を確認。
2. Playwright が **Google Chrome（`channel: 'chrome'`）**を起動し、画面から一意のテストデータを作成。
3. `mysql` コマンドで外部 MySQL に読み取り専用の SQL を実行。保存が非同期でも Playwright の `expect.poll()` で短時間再確認。
4. 失敗時には Playwright のレポートとスクリーンショット／トレースを保存。

> Deployment の Ready はアプリの完全な正常性を保証しません。UIでの成功表示とDBの期待値を別々に判定します。

## 必要なもの

- Node.js 22+ と npm
- **Google Chrome（安定版）**がインストールされた実行端末（Chromium / Firefox / WebKit は実行しません）
- 対象の非本番 Kubernetes クラスタに接続できる `kubectl`（Deployment の参照・rollout status の権限）
- 外部 DB に接続可能な **MySQL 8系の `mysql` CLI**（VPN・ファイアウォール・許可リストなどを含む）
- DBの**SELECT専用**ユーザー、およびブラウザ側でテストデータを作成できる検証用アカウント

## セットアップ

```bash
npm install
cp .env.example .env
# .env に実際の「非本番」接続先を設定する
npm run test:unit
npm run test:list
```

Chromeが未インストールの場合は、公式のChromeをインストールしてください。Playwright のインストーラから入れる場合は `npx playwright install chrome` ですが、利用端末の Chrome のインストール先が変更される場合があるため注意してください。**`npx playwright install chromium` は不要**です。

MySQLのパスワードは `.env` やコマンドラインに書きません。**リポジトリ外**に専用ファイルを作成してください。

```ini
# 例: /private/path/mysql-test.cnf（Gitの管理外）
[client]
password="REPLACE_WITH_PASSWORD"
ssl-mode=VERIFY_IDENTITY
ssl-ca=/absolute/path/to/server-ca.pem
```

macOS / Linux:

```bash
chmod 600 /private/path/mysql-test.cnf
```

`.env` の `MYSQL_OPTIONS_FILE` にはこの絶対パスを指定します。サーバー証明書の信頼経路が確立されている場合は適切なCAファイルを指定してください。接続クライアントは MySQL 8系を想定しています。

## 実環境に合わせた変更が必要な箇所

| ファイル | 変更箇所 |
| --- | --- |
| `tests/create-item.integration.spec.cjs` | `/items/new`、`data-testid`、登録成功メッセージ、必要ならログイン処理 |
| `sql/verify_item.sql` | `items` テーブル、`test_key`、`status='CREATED'` という仮の業務仕様 |
| `.env` | URL、Kubernetesコンテキスト／namespace／Deployment、MySQLの接続先 |
| MySQL認証ファイル（管理外） | SELECT専用ユーザーの認証、TLS設定 |

3つの接続先は**同一の検証環境**を指すようにしてください。スクリプトは `TEST_ENV` が `local/dev/test/staging` 以外の場合は実行を拒否しますが、設定名だけのチェックなので、実際の接続先が本番でないことは運用側でも確認してください。

## 実行

```bash
npm run test:unit                 # MySQL連携ロジックの単体試験（DB不要）
npm run test:integration          # Chrome ヘッドレスで結合試験
npm run test:integration:headed   # Chromeを表示して結合試験
npm run report                    # HTMLレポート表示
```

**DB更新を伴うのはUI操作のみ**です。SQLは `START TRANSACTION READ ONLY` で実行し、DB権限も SELECT 専用にしてください。テストデータの削除は例示コードにはありません。UI/API またはTTLによるテストデータの後片付けを別途決めてください。

## 設計上の注意

- `mysql` CLI にプレースホルダー付きSQLバインド機能はないため、一意のテストキーを検証した後 **16進表記**としてMySQLのセッション変数に設定します。値をSQL構文として直接埋め込みません。
- `mysql` の `--defaults-file` は最初の引数に指定し、パスワードをプロセス引数に渡しません。MySQL認証ファイルは `chmod 600` を検査します。
- `kubectl` の操作は明示的なコンテキストに対する読み取りだけです。Kubernetes Secret は取得しません。
- 全体試験は自動再試行しません（重複登録を防ぐため）。DB確認のみ短期間リトライします。
- CIで実行する際は、接続先ネットワーク、DB認証ファイル、Chromeの導入を別途安全に設定してください。現時点ではCIワークフローを自動登録していません。
- スクリーンショットやトレースにも情報が残ります。必ずダミーデータを使い、レポートを適切に管理してください。

## 公式参考情報

- [Playwright Chrome channel](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge)
- [Playwright assertions](https://playwright.dev/docs/test-assertions)
- [kubectl rollout status](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_rollout/kubectl_rollout_status/)
- [MySQL client options](https://dev.mysql.com/doc/refman/8.4/en/mysql-command-options.html)
