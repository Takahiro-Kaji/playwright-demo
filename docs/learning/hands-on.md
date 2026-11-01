# ハンズオン

Node 26、npm、Google Chromeを準備し `npm install`。`npm run sales:check`、`npm run sales:test:unit`、`npm run sales:test:verification` を実行する。`npm run sales:test:ui`、`npm run sales:test:batch`、`npm run sales:test:cross` は分類別、`npm run sales:test` は一括。ループバック待受とChromeが必要。同期中の重なりを観測できないときは未確認で一括は非ゼロ。部分実行は成功しても要約の総合判定は未完了で、全7件の選択範囲と未実施が記録される。Afterの復元・停止失敗では後続を止める。要約の出力先は実行時に表示される `.local/sales-learning-evidence/<runId>/summary.json`。

## 意図的にFAILを見る

1. 作業ツリーがクリーンであることを確認し、[バッチケース](../../tests/scenarios/batch/sales.spec.ts) の `expected` にあるP001の `price: 120` を一時的に `price: 121` に変更する。デモの上流fixtureは120のまま。
2. `npm run sales:test:batch` を実行する。実HTTPで取得した値と期待値が一致せず、正常ケースのGivenがFAILになる。後処理で今回の所有行とプロセスは回収される。共通DBの既存行は変更しない。
3. P001の価格を**120へ手で戻し**、`git diff -- tests/scenarios/batch/sales.spec.ts` でこの実習の差分が消えたことを確認する。作業中の他の変更を巻き戻さない。
4. 再度 `npm run sales:test:batch` を実行し2ケースPASSと別runIdの要約を確認する。モック異常ケースは503の実GETと元設定への復元を確認する。

`npm run sales:test:verification` では隔離したメモリDBにinactive余剰・削除済み在庫非ゼロなどを1つずつ混入し、SQL取得から差分を検出する。横断ケースの在庫行削除も今回の所有商品だけで行いAfterで復元する。

## 新規ケースを追加する例

`tests/scenarios/ui/` に新しい `*.spec.ts` を置き、`test.step` でGiven／When／Then／Afterを記述する。例えばF1同期後に商品表示を押し、`getByRole('button', {name:'商品表示'})` と `expect` でP001の表示を確認する。期待値は操作前に固定し、`finally` でハーネスのプロセスを回収する。`npm run sales:test:ui` で実行し、失敗時もAfterを確認する。DBを変更する場合は変更前状態・復元と検証を追加する。[チェックリスト](new-case-checklist.md)も参照。

実SSOは認可されたHTTPS開始URLを `SALES_AUTH_URL`、認証後URLを `SALES_AUTH_SUCCESS_URL`、認証済み画面の可視locatorを `SALES_AUTH_SUCCESS_SELECTOR`、`.local/auth/` 下のJSONパスを `SALES_AUTH_STATE` に指定し、対話端末で `npm run sales:auth:setup` を起動する。Chromeでの認証は利用者が操作する。URLに認証コードやトークンを含めない。
