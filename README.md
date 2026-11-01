# 販売管理の結合試験を学ぶ

Playwrightで商品・在庫・受注の連携を学ぶローカルデモです。学習用の外部IFへ実際にHTTP接続し、画面・バッチ・SQLiteの結果を確認します。外部IFは学習用に用意したローカルサービスであり、本番外部サービスの検証ではありません。実SSO、実Kubernetes、AWSでの動作は未検証です。

標準の業務試験は7件です。

- UI：実接続正常、モック異常。
- バッチ：実接続の全件照合、モック異常。
- 横断：同期中のUI参照、古い情報での受注、不整合情報での受注。

期待値は操作前に固定し、DBの件数・キー・値・関連などを確認します。同期中UIはリクエスト開始からHTTP応答までの区間にDB versionの遷移を証明できない場合、**未確認**として全体をPASSにしません。復元や停止に失敗したときは後続を止めます。

## はじめる

必要なものはNode.js 26以上、npm、インストール済みGoogle Chrome、ローカルのループバック通信です。AWSアカウントや実SSOはローカルデモには不要です。

```bash
npm ci
npm run test:list      # 標準の7ケースを一覧表示
npm run test:syntax    # TypeScript型検査
npm run test:unit      # 局所試験と照合器・観測の故障注入
npm test               # 上記検査と7ケースを実行
```

`npm test` は同期中の重なりが捕捉できず未確認の場合も非ゼロで終了します。ケース・Afterの結果と未実施範囲は、実行時に表示される `.local/sales-learning-evidence/<runId>/summary.json` で確認できます。`npm run test:integration` は7ケースだけを実行し、`sales:*` コマンドも従来どおり使えます。CIも現行デモを実行し、未確認をPASSにしません。

## 学習の順序

1. [構成図](docs/learning/architecture.md)でChrome・アプリ・外部IF・モック・DB・バッチの関係を確認。
2. [7ケースの読解](docs/learning/seven-cases.md)で期待値とGiven／When／Then／Afterを追う。
3. [ハンズオン](docs/learning/hands-on.md)で実行と意図的なFAILを試す。
4. [API逆引き](docs/learning/api-reverse-lookup.md)でPlaywrightとデモの呼出しを確認。
5. [新規ケースチェックリスト](docs/learning/new-case-checklist.md)に沿って次のケースを追加する。

詳細な[共通契約](docs/sales-learning-contract.md)と[SSO認証の方針](docs/local-ui-sso-authentication.md)も参照してください。SSOの入口はありますが、実認証はユーザーによる手動操作・環境確認待ちです。

### SSOを使うUIテストの準備

対象の業務アプリで確認した値を設定し、対話端末で手動認証します。URLにクエリやフラグメントは指定できません。

```sh
export SALES_AUTH_URL='https://example.invalid/'
export SALES_AUTH_SUCCESS_URL='https://example.invalid/signed-in'
export SALES_AUTH_SUCCESS_SELECTOR='#signed-in'
export SALES_AUTH_STATE='.local/auth/ui-user.json'
npm run sales:auth:setup
npm run sales:test:ui
```

例のURLとセレクターは実際の対象に置き換えてください。Chromeで手動ログイン後、端末でEnterを押すと状態を保存し、別コンテキストとChrome再起動後の再利用を確認します。認証用の環境変数が設定されていれば、UIケースの各コンテキストに保存状態を読み込み、業務処理の前に指定URLと要素で認証を確認します。設定が不完全な場合や状態がない・失効した場合は操作を開始せず、必要に応じて `npm run sales:auth:setup` を再実行します。通常モードに戻すには `export SALES_AUTH_ENABLED=0` を実行します。再び有効にするには `unset SALES_AUTH_ENABLED` または `export SALES_AUTH_ENABLED=1` を実行します。バッチ専用ケースには認証を要求しません。

現在の業務ケースの接続先はローカルデモです。上記コマンドはSSO前提を確認したうえでローカルデモを試験するもので、実アプリに接続先を切り替えません。実アプリを試験するには、対象固有のURL・操作・期待結果を持つケースを作成し、`test-support/auth/fixture.ts` から `test` と `expect` を読み込んでください。認証済みかどうかは設定した確認先で判定するため、別originの対象にはその対象で有効な確認条件が必要です。実SSOでは未検証であり、端末証明書やプロファイルに依存する認証の成立は保証しません。保存ファイルは機密情報として扱い、共有・コミットしないでください。

### 実アプリ向けの参照画面テスト雛形

上記の認証設定・手動認証の後、許可された試験環境と、事前に固定した期待値を指定します。

```sh
export REAL_APP_URL='https://example.invalid/catalog'
export REAL_APP_EXPECTED_SELECTOR='h1'
export REAL_APP_EXPECTED_TEXT='商品一覧'
npm run real-app:test
```

この雛形は、保存状態を読み込み認証を確認した後、指定画面を開き要素のテキストを完全一致で確認します。URL・要素・期待テキストは対象に合わせて置き換えてください。認証設定または画面条件が不足すると失敗します。実アプリ固有の内容が未確定のため、登録・更新・削除、DB照合、データの復元は含みません。必要なケースは [実アプリの雛形](tests/real-app/read-only.spec.ts) を基に、許可されたテストデータと復元手順を確定して追加してください。

旧AWSデモと9試験は削除せず、[歴史的参照として隔離](old/aws-demo/NOTICE.md)しています。通常の標準コマンド・CIでは実行しません。

### Java 版

同じローカル販売管理デモを Playwright Java・JUnit・SQLite JDBC で学習できます。導入とケース別コマンドは [Java 版 README](java/README.md) を参照してください。TypeScript 版も引き続き利用できます。実 SSO と AWS は未検証です。

### AWS構成について

`old/aws-demo/` は旧デモの保管庫であり、今後のデプロイ・テスト対象には使用しません。現行の販売管理デモ向けAWS構成は [aws/README.md](aws/README.md) を参照してください。AWSへのデプロイと実SSOは未検証です。
