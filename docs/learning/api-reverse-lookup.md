# API逆引き

[server.ts](../../demo/sales/server.ts) の `GET /api/products` は有効商品のコード・名称・整数価格・在庫・versionを返す。関連欠落は409 `INCONSISTENT_DATA`。`GET /api/availability` は学習用外部IFへ実HTTP接続し、成功200、障害502 `UPSTREAM_UNAVAILABLE`。`POST /api/orders` は `productCode`、`quantity`、`version` を受け201で受注IDを返す。古いversion・不整合・在庫不足は409でDB不変。仕様は[契約](../sales-learning-contract.md)。

`GET /catalog` は学習用JSONを返し、モックの `GET/PUT /admin/status` はstatusを読み書きする。認証は管理用のみ。実IFとモックはHTTPで接続し、本番サービスの実績に数えない。

[db.ts](../../demo/sales/db.ts) の `validateCatalog(value)` は入力を検証しcatalogを返す。不正なら例外。`sync(db,catalog)` は全量を1トランザクションで反映。`order(db,input)` はステータスと本文を返し、受注・在庫・versionを原子的に変更する。SQLiteを採用した理由は専用DBをローカルで起動しやすいためで、MySQLの検証ではない。

[compare.ts](../../tests/targets/sales/compare.ts) の `compareCatalog(db,expected)` はSQLで取得した商品・在庫の差分文字列を返す。キー重複を握りつぶさず孤立を検出する。[kubernetes.ts](../../test-support/kubernetes.ts) の `startJob(target,cronJob,runner)`、`waitJob(target,runner,timeoutMs)`、`stopJob(target,runner,timeoutMs)` は引数配列で操作し、終了・停止を確認する。実クラスタ未検証。[setup.ts](../../test-support/auth/setup.ts) の `setupAuth(state,target,expectedUrl,selector)` は手動ログイン後、指定URLとlocatorを検証し保存状態を新context・再起動後に確認する。秘密値を出力しない。
