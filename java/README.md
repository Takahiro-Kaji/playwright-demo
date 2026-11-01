# Playwright Java による販売管理学習

TypeScript 版と同じ Node の販売管理デモに対し、別プロセスの HTTP と専用 SQLite を使って試験します。仕様の正本は [共通契約](../docs/sales-learning-contract.md) です。業務アプリを変更しません。実 SSO、実 Kubernetes、AWS は未検証です。

## 前提と実行

JDK 17、Node.js 26、Google Chrome が必要です。`java/` で以下を実行します。初回は固定版 Maven と依存を Maven Central から取得します。Wrapper は配布物のチェックサムを検証します。

```sh
./mvnw -Dtest=CatalogCheckTest,RunResultsTest,SafetyTest,MockRecoveryTest,SsoConfigTest test
./mvnw -Dtest=SalesScenariosTest#batchReal test
./mvnw test
```

全件は局所検査と 7 ケースを実行します。同期中の版遷移を HTTP 要求から応答までの区間内に観測できなければ UNCONFIRMED でビルドを失敗にします。個別実行の総合判定は PARTIAL です。証跡はリポジトリの `.local/java-evidence/<runId>/` にあり、7 件のケース判定と After 判定に加え、実行範囲 `scope`、本体の集約 `business`、後処理の集約 `after`、総合判定と `allPass` を別に保存します。認証状態や巨大応答は保存しません。

## 手動 SSO

実環境と資格情報は用意されていません。認証後に表示される要素のセレクターと HTTPS URL を利用者が設定し、対話可能な端末で以下を起動します。

```sh
export JAVA_SSO_URL='https://example.invalid/'
export JAVA_SSO_EXPECTED_URL='https://example.invalid/signed-in'
export JAVA_SSO_SUCCESS_SELECTOR='#signed-in'
./mvnw test-compile exec:exec
```

Chrome で利用者が認証し Enter を押した後、指定要素を確認して storage state を保存し、新 context と headless Chrome 再起動でも同じ要素を確認します。開始 URL、認証成立時の完全な URL（origin と path）、実セレクターを差し替えてください。URL の query と fragment は受け付けません。例外の詳細は機密を避けるため表示しません。ブラウザー起動・操作は各15秒、手動待機を含む全体は5分で打ち切り、起動したプロセスの停止を確認します。state は機密として `.local/java-sso/` に保存されます。公開・コミットしないでください。実際の認証は未確認です。

ケースごとの流れ、API 逆引き、追加例は [教材](learning.md) を参照してください。

## 学習資料

- [7ケース読解と Playwright API 逆引き](learning.md)
- [構成図と実環境の検証範囲](architecture.md)
- [期待値の FAIL・SQL 故障注入ハンズオン](handson.md)
- [新規ケース追加手順](new-case.md)
