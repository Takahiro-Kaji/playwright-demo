# 7ケースの読解

まず[契約](../sales-learning-contract.md)を読む。各テストは `harness(mode)` で実行ごとのSQLiteとローカルHTTPプロセスを用意し、`test.step` で Given → When → Then → After を記述する。F1はP001「ペン」120円・在庫5、P002「ノート」300円・在庫2、両version 1。F2はP001在庫3・version 2、P002はF1のまま。金額・数量・versionは整数。F1/F2は学習用固定値であり、実業務の期待値ではない。

ケースとAfterの判定は別に記録する。復元・停止の失敗では後続を停止する。以下の呼出し順はケースを読むための要約であり、詳細な引数と例外処理は実ファイルを正とする。

## UI-01：学習用実接続と受注の正常系

**目的**：実HTTPで学習用外部IFに接続し、画面経由の受注とDB反映を確認する。[実ファイル](../../tests/scenarios/ui/sales.spec.ts)

- **Given**：`harness('upstream')` → `h.batch()` でF1同期 → `page.goto(h.app)`。
- **When**：`getByRole(...外部接続確認).click()` → 「接続可能」を確認 → 商品表示をクリック → `waitForResponse` を先に登録 → P001の受注ボタンをクリック。
- **Then**：HTTP 201、画面「受注しました」、`h.query()` で受注1行のP001・数量1・単価120・`CREATED`、P001在庫4・version 2を確認する。
- **After**：`finally` の `h.cleanup()` で起動プロセスの終了を確認し専用DBを削除する。停止未確認なら失敗し、DBを残す。

呼出しの流れ：`harness` → `batch` → `goto` → `click`／`waitForResponse` → `expect`／`query` → `cleanup`。実HTTPの相手はローカル学習用IFであり、本番外部サービスの受入ではない。

## UI-02：外部IF障害時の画面

**目的**：モック503を受けた接続確認の画面・HTTPとDB不変を確認する。[実ファイル](../../tests/scenarios/ui/sales.spec.ts)

- **Given**：`harness('mock')` → `batch()` でF1同期 → `snapshot()` でproducts・inventory・sync_state・ordersの全列を固定 → `status()` で元値退避 → `status(503)` → 業務 `GET /catalog` が503と確認。
- **When**：`goto` → `waitForResponse` を登録 → 「外部接続確認」をクリック。
- **Then**：HTTP 502、画面「外部システムエラー」、`snapshot()` がGivenで固定した4表と完全一致。
- **After**：`settleAfter()` でモックを元値へ戻し、管理応答と業務GETを確認する。その後 `cleanup()` でプロセスを回収。復元エラー時も回収を試み、専用DBを保持する。

呼出しの流れ：`harness` → `batch` → `snapshot` → `status`／実GET → `goto`／`waitForResponse`／`click` → `expect`／`snapshot` → `settleAfter` → `status`／実GET → `cleanup`。

## BATCH-01：学習用実接続の全件照合

**目的**：同期コマンドの正常終了に加え、DBの全対象を上流の固定期待値と照合する。[実ファイル](../../tests/scenarios/batch/sales.spec.ts)／[照合器](../../tests/targets/sales/compare.ts)

- **Given**：`harness('upstream')` → `fetch('/catalog')`。HTTP 200とJSONの全商品が事前定義のF1と一致することを確認する。
- **When**：`h.batch()` が外部IFを実HTTPで取得し、終了コード0で戻る。
- **Then**：`DatabaseSync` → `compareCatalog()`。期待はP001・P002の名称・価格・有効状態・在庫・version 1、削除許容行なし、`catalogVersion` 1、受注0件。商品・在庫の件数、キー、値、関連、version、sync_state、ordersを比較し、差分配列は `[]`。在庫件数2も確認する。
- **After**：DB接続を閉じ、`cleanup()` でプロセス終了と専用DB削除を確認する。

呼出しの流れ：`harness` → `fetch` → `batch` → `DatabaseSync`／`compareCatalog`／`query` → `cleanup`。終了コード0だけではPASSにしない。照合器の検出力は[故障注入](../../tests/verification/sales-comparison/compare.test.ts)で確認する。

## BATCH-02：モック障害時の同期

**目的**：上流障害で同期が失敗し、事前DBを変更しないことを確認する。[実ファイル](../../tests/scenarios/batch/sales.spec.ts)

- **Given**：`harness('mock')` → `batch()` でF1同期 → `query()` で商品・在庫・sync_stateを保存。受注は0件。モックの元値を `status()` で退避し503に設定、実GETも503と確認。
- **When**：`batch()` を実行し、終了コードが0でないことを確認。
- **Then**：products・inventory・sync_stateが事前取得と一致し、ordersは0件。
- **After**：`settleAfter()` → 元ステータスへの `status(old)` と業務GETで復元確認 → `cleanup()`。復元と停止の失敗は集約し、後続試験を止める。

呼出しの流れ：`harness` → `batch` → `query`／`status`／実GET → `batch` → `query`／`expect` → `settleAfter`／`status`／`cleanup`。

## CROSS-01：同期中のUI参照

**目的**：同期によるDB更新期間中に、UIが一貫した表示を保つか確認する。[実ファイル](../../tests/scenarios/cross-feature/sales.spec.ts)／[表示判定](../../tests/targets/sales/sync-display.ts)

- **Given**：`harness('upstream')` → F1を `batch()` で同期 → `goto` → 学習用IFのファイルへF2を書き込む。
- **When**：商品表示のリクエスト開始イベントから `query()` で同期versionを観測し、並行して `batch()` を起動。`waitForResponse` と表示を待ち、バッチ終了を回収する。pageerrorと500以上の応答も記録する。
- **Then**：HTTP 200、商品2件の応答・画面全体がF1かF2のどちらかに一致。P002は「ノート 300円 在庫2」、P001は「ペン 120円 在庫5」または「ペン 120円 在庫3」。商品表示・両受注ボタンは有効、pageerror・500以上はなし。`syncDisplayMatches()` と `compareCatalog()` で表示と最終DBのF2全件を照合する。
- **成立条件**：UIの対象HTTPリクエスト開始から応答までの観測値に、同期version 1→2を確認できた場合のみ、観測したUI結果を判定する。捕捉できなければ **未確認**。プロセスが動いていた事実は重なりの証明にならない。
- **After**：監視timerを解除し、起動したバッチの終了を回収してから `cleanup()`。回収不明ならDBを保持する。

呼出しの流れ：`harness` → `batch` → `goto`／`writeFile` → リクエスト観測・`query`／並行`batch` → `waitForResponse`／`syncDisplayMatches`／`compareCatalog` → バッチ回収／`cleanup`。一括結果が未確認を含む場合は非ゼロ。

## CROSS-02：古い表示からの受注

**目的**：表示versionと受注時のDB versionが異なる場合のデモ仕様を確認する。[実ファイル](../../tests/scenarios/cross-feature/sales.spec.ts)

- **Given**：`harness` → F1同期 → `goto`／商品表示でP001 version 1を画面に保持 → 上流をF2に変更し再び `batch()`。
- **When**：`waitForResponse` を登録して旧画面のP001受注ボタンをクリック。
- **Then**：HTTP 409・`STALE_VERSION`、画面「情報が更新されました。再表示してください」、受注0件、P001在庫3・version 2。
- **After**：`cleanup()` で同期・アプリ・外部IFのプロセス終了を確認し、専用DBを削除する。

呼出しの流れ：`harness` → `batch` → `goto`／`click` → `writeFile`／`batch` → `waitForResponse`／`click` → `expect`／`query` → `cleanup`。409はこの学習デモ固有の固定期待値。

## CROSS-03：不整合情報での受注

**目的**：商品に対応する在庫行がない場合に受注を拒否し、When前のDBを変更しないことを確認する。[実ファイル](../../tests/scenarios/cross-feature/sales.spec.ts)

- **Given**：`harness` → F1同期 → 商品画面を表示 → `execute()` で専用DBのP001在庫行を削除 → `snapshot()` で4表全列を固定。
- **When**：`waitForResponse` を登録し、表示済みP001の受注ボタンをクリック。
- **Then**：HTTP 409・`INCONSISTENT_DATA`、画面「商品情報に不整合があります」、`snapshot()` がWhen直前の4表と一致。削除された在庫行がない状態も期待に含む。
- **After**：`execute()` でP001在庫5を戻し、`query()` で確認 → `cleanup()`。復元失敗時もプロセス回収を試し、DBを保持して後続を止める。

呼出しの流れ：`harness` → `batch` → `goto`／`click` → `execute`／`snapshot` → `waitForResponse`／`click` → `expect`／`snapshot` → `execute`／`query`／`cleanup`。不整合は専用DBだけで作る。
