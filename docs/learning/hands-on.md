# ハンズオン

Node 26、npm、Google Chromeを準備し、`npm install` 後に `npm run sales:check` と `npm run sales:test:unit` を実行する。`npm run sales:test:verification` は小さなSQLデータへの欠落・重複・値・関連などの故障を検出する。`npm run sales:test:ui`、`npm run sales:test:batch`、`npm run sales:test:cross` でケースごとに実行する。`npm run sales:test` は一括実行。ループバック待受とChrome起動が必要。同期中に観測できない場合は未確認で一括は非ゼロとなる。

FAILの観察：学習用fixtureの期待値を一時的に変更してバッチ照合を実行し、値差が検出されることを確認して元に戻す。モック503はUIとバッチの異常ケース内で設定・実GET・復元を確認する。DB不整合は横断ケースが専用DBの在庫行を削除して検出し、Afterで復元する。実DBや共有環境に故障を入れない。証跡は `.local/sales-learning-evidence/summary.json`。認証情報や生応答を保存しない。

実SSOを試す際は、認可された対象のHTTPS開始URLを `SALES_AUTH_URL`、認証後に一致すべきHTTPS URLを `SALES_AUTH_SUCCESS_URL`、認証済み画面だけで可視となるlocatorを `SALES_AUTH_SUCCESS_SELECTOR`、Git対象外の `.local/auth/` 下のJSONパスを `SALES_AUTH_STATE` に指定し、対話端末で `npm run sales:auth:setup` を起動する。Chromeでの認証は利用者が操作する。URLには認証コードやトークンを含めない。
