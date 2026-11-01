# 複合ユニークキーでの照合サンプル

[照合処理](../../tests/targets/sales/compare-company-products.ts)と[実行できるテスト](../../tests/verification/sales-comparison/composite-unique.test.ts)を読む。既存の販売7ケースとは別の、インメモリSQLiteで動く学習用サンプル。

商品テーブルに会社コード `company_code` と商品コード `product_code` があり、`UNIQUE (company_code, product_code)` を設定する例。C001のP001は120円、C002のP001は150円。商品コードだけで照合すると別会社の商品を混同するため、2列の組で対応付ける。

```ts
const keyOf = (row) => JSON.stringify([row.company_code, row.product_code]);
```

例えばキーは `["C001","P001"]` になる。実データと期待値の両方に同じキー生成を適用し、Mapで行を取り出して商品名・価格を比較する。SQLの取得順と期待値の並び順が違ってもよい。単純な `company_code + ":" + product_code` ではコード内のコロンで衝突するため、配列をJSON化する。この例のキー列はどちらもNOT NULLの文字列で、値をそのまま比較する。

```ts
const differences = compareCompanyProducts(db, expected, ["C001", "C002"]);
expect(differences).toEqual([]);
```

SELECTするのは関係する `company_products` テーブルの指定会社内の全商品。商品コードでは絞らず、期待していない商品の追加も検出する。差分は `product:missing:["C001","P001"]`、`product:extra:…`、`product:value:…` などで返す。これは実行後DBと固定期待値の比較であり、前後比較ではない。

DBのUNIQUE制約に加え、照合側でもMapへ格納する前に重複を検出する。JOIN等で取得結果が重複した場合や、期待値を誤って重複登録した場合も見逃さない。テストでは並び順の違い、同一商品コードの別会社、重複、欠落、余剰、値違い、会社の誤り、文字列連結によるキー衝突を確認する。

実プロダクトではキーの型、NULLの可否、DBの照合順序も確認する。例えばDBで大文字・小文字を同一視する場合、この文字列比較をそのまま適用せず、DB定義に合う対応付けを設計する。

実行コマンド：

```sh
node --test tests/verification/sales-comparison/composite-unique.test.ts
```

既存の `npm run sales:test:verification` にも含まれる。
