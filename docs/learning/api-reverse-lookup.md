# API逆引き

[server.ts](../../demo/sales/server.ts) の `GET /api/products` は有効商品のコード・名称・整数価格・在庫・versionを返す。関連欠落は409 `INCONSISTENT_DATA`。`GET /api/availability` は学習用外部IFへ実HTTP接続し、成功200、障害502 `UPSTREAM_UNAVAILABLE`。`POST /api/orders` は `productCode`、`quantity`、`version` を受け、入力検証後に外部IFへ接続する。非200・通信失敗・期限切れは502 `UPSTREAM_UNAVAILABLE` でDB不変。接続成功後にDBで受注し、201で受注IDを返す。古いversion・不整合・在庫不足は409でDB不変。仕様は[契約](../sales-learning-contract.md)。

`GET /catalog` は学習用JSONを返し、モックの `GET/PUT /admin/status` はstatusを読み書きする。認証は管理用のみ。実IFとモックはHTTPで接続し、本番サービスの実績に数えない。

[db.ts](../../demo/sales/db.ts) の `validateCatalog(value)` は入力を検証しcatalogを返す。不正なら例外。`sync(db,catalog,scope)` は指定した接頭辞の商品群の全量を1トランザクションで反映。`order(db,input)` はステータスと本文を返し、受注・在庫・versionを原子的に変更する。SQLiteを採用した理由は共通DBをローカルで扱いやすいためで、MySQLの検証ではない。

[compare.ts](../../tests/targets/sales/compare.ts) の `compareCatalog(db,expected)` はSQLで取得した商品・在庫の差分文字列を返す。キー重複を握りつぶさず孤立を検出する。[kubernetes.ts](../../test-support/kubernetes.ts) の `startJob(target,cronJob,runner)`、`waitJob(target,runner,timeoutMs)`、`stopJob(target,runner,timeoutMs)` は引数配列で操作し、終了・停止を確認する。実クラスタ未検証。[setup.ts](../../test-support/auth/setup.ts) の `setupAuth(state,target,expectedUrl,selector)` は手動ログイン後、指定URLとlocatorを検証し保存状態を新context・再起動後に確認する。秘密値を出力しない。

## Playwright API逆引き

各例は実際に使用する箇所へのリンクです。APIの戻り値は非同期操作では `Promise` を示します。

- **`page.goto(url)`**：指定URLへ画面遷移。`url` は文字列、戻り値は `Promise<Response | null>`。リダイレクトや遷移失敗に注意する。対象画面を通常のブラウザ経路で開くため採用。[UIケース](../../tests/scenarios/ui/sales.spec.ts)
- **`page.getByRole(role, { name })`**：アクセシビリティ上のロールと名前で要素を探し、`Locator` を返す。名前は表示名、複数一致は操作時にエラーになり得る。利用者が認識するボタン名をそのまま確認できるため採用。[UIケース](../../tests/scenarios/ui/sales.spec.ts)
- **`page.locator(selector)`**：CSS等のセレクターを受け `Locator` を返す。取得時点の要素ではなく操作時に再評価される。内部構造に依存しやすいため、結果欄や商品コードによる特定に限定。[横断ケース](../../tests/scenarios/cross-feature/sales.spec.ts)
- **`locator.click()`**：対象の操作可能状態を待ちクリックし `Promise<void>` を返す。複数一致や操作不能は失敗。実際の画面操作としてイベントを通すため採用。[UIケース](../../tests/scenarios/ui/sales.spec.ts)
- **`expect(locator).toHaveText(text)`**：期待文字列を引数に渡し、一致まで再試行して `Promise<void>` を返す。固定sleepでなく表示結果を検証するため採用。期待値を観測結果から作らない。[UIケース](../../tests/scenarios/ui/sales.spec.ts)
- **`page.waitForResponse(predicate)`**：応答を選ぶ関数を受け、条件に合う `Promise<Response>` を返す。クリックより前に待機を登録し、URL・メソッドなどで対象を識別する。HTTP結果と画面を別に確認するため採用。[UIケース](../../tests/scenarios/ui/sales.spec.ts)
- **`context.storageState({ path })`**：認証状態を返し、`path` 指定時はファイルにも保存する。Cookie等の秘密を含むためGit・証跡に入れず、保存だけで再利用成功としない。[SSO入口](../../test-support/auth/setup.ts)
- **`browser.newContext({ storageState })`**：保存済み状態を指定して分離された `Promise<BrowserContext>` を作る。通常Chromeの状態は共有されず、Session Storage等の対象外もあり得る。新しいcontextで再利用を確認するため採用。[SSO入口](../../test-support/auth/setup.ts)
- **`test.step(title, body)`**：段階名と非同期関数を受け、関数結果を `Promise` で返す。Given／When／Then／Afterの順序を読み取れるため採用。Afterは `finally` 内に置き、step自体を復元保証としない。[バッチケース](../../tests/scenarios/batch/sales.spec.ts)
