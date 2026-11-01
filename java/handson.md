# 期待値の FAIL と SQL 故障を体験する

`java/` で `./mvnw -Dtest=CatalogCheckTest test` を実行し PASS を確認します。[CatalogCheck.java](src/test/java/learning/CatalogCheck.java) の `dataset1()` にあるペンの価格 `120` を一時的に `121` に変更し、同じコマンドを再実行します。テストが価格不一致を検出して FAIL になることを確認し、`121` を `120` に戻して再実行します。試験対象から期待値を自動生成しない理由を確認できます。

次に [CatalogCheckTest.java](src/test/java/learning/CatalogCheckTest.java) の `faults` を読みます。メモリ内 SQLite の商品欠落、重複、余剰、価格、在庫関連、版、同期状態、注文を一つずつ注入し、`SAVEPOINT` と `ROLLBACK` で復元します。上のコマンドで全注入の検出を実行します。削除扱いの在庫非ゼロも別途検出します。学習時に故障 SQL を追加したら `assertFalse` が失敗しないことを確認し、体験後は追加した行を戻します。

修正した期待値が残っていないかは `git diff -- java/src/test/java/learning/CatalogCheck.java` で確認します。実 DB や他ケースに手を加える必要はありません。
