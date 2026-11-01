# 新しい Java ケースを作る

1. [7ケースの読み方](learning.md) と [共通契約](../docs/sales-learning-contract.md) で入力・独立期待値・変更すべき4表を決めます。
2. [具体的な新規例](learning.md#新規試験の追加例) を `src/test/java/learning/AdditionalExampleTest.java` に作り、`SalesHarness.open(false)`、`batch()`、`snapshot()`、`CatalogCheck.differences()` を再利用します。
3. Given で fixture と前提、When で1回の操作、Then で応答と DB 全表の固定期待値、After で復元と停止確認を書きます。モック変更は元の状態を GET で保存し、PUT 前に復元フラグを設定します。
4. `./mvnw -Dtest=AdditionalExampleTest test` と全件 `./mvnw test` で確認します。共通7ケースの集約に新しい必須ケースを組み込む場合は [SalesScenariosTest.java](src/test/java/learning/SalesScenariosTest.java) の ID 一覧と [RunResultsTest.java](src/test/java/learning/RunResultsTest.java) の集合・部分実行・After 失敗テストも変更します。
5. `java/target/` と `.local/` はコミットせず、秘密や巨大な応答を証跡に入れないことを確認します。
