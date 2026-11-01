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

旧AWSデモと9試験は削除せず、[歴史的参照として隔離](old/aws-demo/NOTICE.md)しています。通常の標準コマンド・CIでは実行しません。

### Java 版

同じローカル販売管理デモを Playwright Java・JUnit・SQLite JDBC で学習できます。導入とケース別コマンドは [Java 版 README](java/README.md) を参照してください。TypeScript 版も引き続き利用できます。実 SSO と AWS は未検証です。
