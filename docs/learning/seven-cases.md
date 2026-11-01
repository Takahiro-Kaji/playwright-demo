# 7ケースの読解

各件数・全件比較・snapshotは今回のスコープ内を指す。論理商品名P001等は実際には `h.code("P001")` の一意キーになり、同期世代は `sales_sync_scopes` で分離する。DB全体は空にせず、Afterで既存行の不変も確認する。

まず[契約](../sales-learning-contract.md)を読む。各テストは `harness(mode)` で共通SQLite内の所有商品群とローカルHTTPプロセスを用意し、`test.step` で Given → When → Then → After を記述する。F1はP001「ペン」120円・在庫5、P002「ノート」300円・在庫2、両version 1。F2はP001在庫3・version 2、P002はF1のまま。金額・数量・versionは整数。F1/F2は学習用固定値であり、実業務の期待値ではない。

ケースとAfterの判定は別に記録する。復元・停止の失敗では後続を停止する。以下の呼出し順はケースを読むための要約であり、詳細な引数と例外処理は実ファイルを正とする。

## UI-01：学習用実接続と受注の正常系

**目的**：実HTTPで学習用外部IFに接続し、画面経由の受注とDB反映を確認する。[実ファイル](../../tests/scenarios/ui/sales.spec.ts)

- **Given**：`harness('upstream')` → `h.batch()` でF1同期 → `page.goto(h.app)`。
- **When**：`getByRole(...外部接続確認).click()` → 「接続可能」を確認 → 商品表示をクリック → `waitForResponse` を先に登録 → P001の受注ボタンをクリック。
- **Then**：HTTP 201、画面「受注しました」、`h.query()` で受注1行のP001・数量1・単価120・`CREATED`、P001在庫4・version 2を確認する。
- **After**：`finally` の `h.cleanup()` で起動プロセスの終了を確認し今回の所有行のみ削除する。停止未確認なら失敗し、DBを残す。

呼出しの流れ：`harness` → `batch` → `goto` → `click`／`waitForResponse` → `expect`／`query` → `cleanup`。実HTTPの相手はローカル学習用IFであり、本番外部サービスの受入ではない。

## UI-02：外部IF障害時の画面

`for (const status of [500, 502, 503])` で同じテストを3件登録し、それぞれ準備から後片付けまで実行する。レポーターは各実行結果を残し、UI-02として集計する。

**目的**：受注時の外部接続がモック500・502・503のそれぞれで失敗し、画面・HTTPとDB不変を確認する。[実ファイル](../../tests/scenarios/ui/sales.spec.ts)

- **Given**：`harness('mock')` → `batch()` でF1同期 → `goto`／商品表示でP001のボタンを確認 → `snapshot()` でproducts・inventory・sync_state・ordersの全列を固定 → `status()` で元値退避 → `status(status)` → 業務 `GET /catalog` が同じステータスと確認。
- **When**：`POST /api/orders` の `waitForResponse` を登録 → 表示済みP001の受注ボタンをクリック。
- **Then**：HTTP 502・`UPSTREAM_UNAVAILABLE`、画面「外部システムエラー」、`snapshot()` がGivenで固定した4表と完全一致。
- **After**：`settleAfter()` でモックを元値へ戻し、管理応答と業務GETを確認する。その後 `cleanup()` でプロセスを回収。復元エラー時も回収を試み、所有行と復旧用ロックを保持する。

呼出しの流れ：`harness` → `batch` → `goto`／商品表示 → `snapshot` → `status`／実GET → `waitForResponse`／受注`click` → `expect`／`snapshot` → `settleAfter` → `status`／実GET → `cleanup`。

## BATCH-01：学習用実接続の全件照合

**目的**：同期コマンドの正常終了に加え、DBの全対象を上流の固定期待値と照合する。[実ファイル](../../tests/scenarios/batch/sales.spec.ts)／[照合器](../../tests/targets/sales/compare.ts)

- **Given**：`harness('upstream')` → `fetch('/catalog')`。HTTP 200とJSONの全商品が事前定義のF1と一致することを確認する。
- **When**：`h.batch()` が外部IFを実HTTPで取得し、終了コード0で戻る。
- **Then**：`DatabaseSync` → `compareCatalog()`。期待はP001・P002の名称・価格・有効状態・在庫・version 1、削除許容行なし、`catalogVersion` 1、受注0件。商品・在庫の件数、キー、値、関連、version、sync_state、ordersを比較し、差分配列は `[]`。在庫件数2も確認する。
- **After**：DB接続を閉じ、`cleanup()` でプロセス終了と今回の所有行削除を確認する。

呼出しの流れ：`harness` → `fetch` → `batch` → `DatabaseSync`／`compareCatalog`／`query` → `cleanup`。終了コード0だけではPASSにしない。照合器の検出力は[故障注入](../../tests/verification/sales-comparison/compare.test.ts)で確認する。

## BATCH-02：モック障害時の同期

**目的**：上流障害で同期が失敗し、事前DBを変更しないことを確認する。[実ファイル](../../tests/scenarios/batch/sales.spec.ts)

- **Given**：`harness('mock')` → `batch()` でF1同期 → `query()` で商品・在庫・sync_stateを保存。受注は0件。モックの元値を `status()` で退避し503に設定、実GETも503と確認。
- **When**：`batch()` を実行し、終了コードが0でないことを確認。
- **Then**：products・inventory・sync_stateが事前取得と一致し、ordersは0件。
- **After**：`settleAfter()` → 元ステータスへの `status(old)` と業務GETで復元確認 → `cleanup()`。復元と停止の失敗は集約し、後続試験を止める。

呼出しの流れ：`harness` → `batch` → `query`／`status`／実GET → `batch` → `query`／`expect` → `settleAfter`／`status`／`cleanup`。

## CROSS-01：同期中のUI参照

**目的**：同期によるDB更新期間中のUI表示を確認する。[実ファイル](../../tests/scenarios/cross-feature/sales.spec.ts)／[固定fixture](../../tests/targets/sales/bulk-fixture.ts)／[成立判定](../../tests/targets/sales/overlap.ts)

- **Given**：`harness('upstream')` → `bulkCatalog(1)` の3,000件を固定生成して `writeFile()` → `batch()` で同期 → `goto()` → `bulkCatalog(2)` を上流ファイルに設定。S0001〜S3000は名称「学習商品」＋番号、価格100〜3099。旧は全在庫5・version 1、新は全在庫3・version 2。
- **When**：独立接続の `query()` を定期実行しながら `batch()` を起動。`waitForResponse`／`click` でUIを繰り返し参照し、各リクエスト開始・応答・表示確認完了、SELECTの開始・終了とversionを記録する。試行開始とバッチ待ちの期限は12秒、UI操作timeoutは3秒、全ケースtimeoutは30秒。上限20回、観測は最大10,000件。上限内の試行をすべて記録する。
- **Then**：各HTTP 200、全3,000件の応答・画面が旧か新のどちらかに一致し、ボタン有効・pageerror／500以上なし。`syncDisplayMatches()` で全表示、`compareCatalog()` で最終DBの新データ全件・同期version 2・受注0件を照合する。
- **成立条件**：`hasObservedOverlap()` は、同じ正常なUI参照の開始からHTTP応答までの期間に、独立SELECTがversion 1、続いてversion 2を完全に観測した場合だけ成立とする。表示確認完了時刻にはテスト側の読取り時間も含まれるため成立判定には使わず、異なる参照間の遷移も採用しない。捕捉できなければ **未確認**。
- **After**：観測timerを解除し、上限・全試行・観測を `.local/sales-learning-evidence/observations/` に保存。バッチの終了を回収し `cleanup()`。回収不明ならDBを保持する。

呼出し順：`harness` → `bulkCatalog`／`writeFile`／`batch` → `goto` → 独立`query`監視と`batch`／繰返し`waitForResponse`・`click` → `syncDisplayMatches`／`hasObservedOverlap`／`compareCatalog` → 証跡保存・回収・`cleanup`。業務処理に試験専用の遅延を入れない。

## CROSS-02：古い表示からの受注

**目的**：表示versionと受注時のDB versionが異なる場合のデモ仕様を確認する。[実ファイル](../../tests/scenarios/cross-feature/sales.spec.ts)

- **Given**：`harness` → F1同期 → `goto`／商品表示でP001 version 1を画面に保持 → 上流をF2に変更し再び `batch()` → `snapshot()` で4表全列を固定。
- **When**：`waitForResponse` を登録して旧画面のP001受注ボタンをクリック。
- **Then**：HTTP 409・`STALE_VERSION`、画面「情報が更新されました。再表示してください」、受注0件、P001在庫3・version 2を含む4表全体がWhen前と一致。
- **After**：`cleanup()` で同期・アプリ・外部IFのプロセス終了を確認し、今回の所有行のみ削除する。

呼出しの流れ：`harness` → `batch` → `goto`／`click` → `writeFile`／`batch`／`snapshot` → `waitForResponse`／`click` → `expect`／`query` → `cleanup`。409はこの学習デモ固有の固定期待値。

## CROSS-03：不整合情報での受注

**目的**：商品に対応する在庫行がない場合に受注を拒否し、When前のDBを変更しないことを確認する。[実ファイル](../../tests/scenarios/cross-feature/sales.spec.ts)

- **Given**：`harness` → F1同期 → 商品画面を表示 → `execute()` で共通DB内の今回所有するP001在庫行を削除 → `snapshot()` で4表全列を固定。
- **When**：`waitForResponse` を登録し、表示済みP001の受注ボタンをクリック。
- **Then**：HTTP 409・`INCONSISTENT_DATA`、画面「商品情報に不整合があります」、`snapshot()` がWhen直前の4表と一致。削除された在庫行がない状態も期待に含む。
- **After**：`execute()` でP001在庫5を戻し、`query()` で確認 → `cleanup()`。復元失敗時もプロセス回収を試し、DBを保持して後続を止める。

呼出しの流れ：`harness` → `batch` → `goto`／`click` → `execute`／`snapshot` → `waitForResponse`／`click` → `expect`／`snapshot` → `execute`／`query`／`cleanup`。不整合は今回の所有商品だけで作る。
