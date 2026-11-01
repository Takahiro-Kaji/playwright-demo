# 7 ケースの読み方

実装は [SalesScenariosTest.java](src/test/java/learning/SalesScenariosTest.java)、プロセスと DB は [SalesHarness.java](src/test/java/learning/SalesHarness.java)、全表の固定期待値は [CatalogCheck.java](src/test/java/learning/CatalogCheck.java) です。TypeScript の対応は [7 ケース教材](../docs/learning/seven-cases.md) と `tests/scenarios/` を参照してください。各ケースは専用 DB を使い、終了時にモック・データを復元し、子プロセスの停止を確認します。

1. `uiReal`: Given F1 を同期し画面を開く。When 接続確認と P001 受注。Then HTTP 201、受注、価格120、在庫4、版2。After プロセス停止。
2. `uiMock`: Given F1 を同期して商品表示、4表 snapshot、上流503。When 表示済み P001 の受注。Then 502、エラー表示、4表不変。After 上流200へ復元し実 HTTP も確認、停止。
3. `batchReal`: Given F1 を実 HTTP 取得。When 同期。Then 商品・在庫各2件、注文0件、同期版1を SQL で固定期待値と照合。After 停止。
4. `batchMock`: Given F1、4表 snapshot と上流503。When 同期。Then 終了非0、4表不変。After 上流復元確認と停止。
5. `syncUi`: Given 固定3000件の版1と版2。When バッチと表示要求、独立 JDBC スレッドの版観測。Then 全表示が版1か版2、DB 全体は版2、同一 HTTP 区間内に版1→2を観測できれば PASS。捕捉できなければ UNCONFIRMED。After 観測証跡保存と停止。実装は [SyncObservation.java](src/test/java/learning/SyncObservation.java)。
6. `staleOrder`: Given 版1表示後 F2 に同期、4表 snapshot。When 旧画面から受注。Then 409 STALE_VERSION、4表不変。After 停止。
7. `inconsistentOrder`: Given 表示後 P001 在庫行削除、4表 snapshot。When 受注。Then 409 INCONSISTENT_DATA、4表不変。After 在庫5を復元し確認、停止。

## Playwright Java API 逆引き

| API | 用途・引数 | 戻り値 | 注意・採用理由と使用箇所 |
| --- | --- | --- | --- |
| `Page.navigate(url)` | URL を開く | Response | 認証やローカル画面に遷移。[SalesScenariosTest.java](src/test/java/learning/SalesScenariosTest.java) |
| `Page.getByRole(role, options)` | role と表示名で操作要素を取得 | Locator | 表示名でボタンを読む。[SalesScenariosTest.java](src/test/java/learning/SalesScenariosTest.java) |
| `Locator.click()` | 要素をクリック | void | 自動待機を使いユーザー操作に近づける。同上 |
| `assertThat(locator).hasText(text)` | 期待する表示文字列を検証 | void | 自動待機し失敗を明示。同上 |
| `Page.waitForResponse(predicate, callback)` | 条件に一致する応答を操作と同時に待つ | Response | 操作前から待機し競合を防ぐ。同上 |
| `BrowserContext.storageState(options)` | 状態を指定ファイルへ保存 | String | 認証情報を含みうるため `.local` のみ。[SsoManual.java](src/test/java/learning/SsoManual.java) |

画面応答の JSON は試験側の `addInitScript` で `fetch` 応答を複製して取得します。業務処理や応答値は変更せず、巨大な本文は証跡へ保存しません。Playwright オブジェクトは作成したスレッドだけで操作します。同期中は JDBC 観測のみ別スレッドです。[公式スレッド規則](https://playwright.dev/java/docs/multithreading)。

## 新規試験の追加例

`SalesScenariosTest.java` の既存ケースを参照し、別ケースとして `open(false,true)`、`sync()`、`h.snapshot()`、操作、応答と固定期待値の照合を順に記述します。入力から期待値を導出せず、4表の変化または不変を固定します。復元が必要な操作には After の復元と確認を追加し、失敗時は後続を止めます。追加するときはケース識別一覧・総合件数と `RunResultsTest` も更新します。

例えば `src/test/java/learning/AdditionalExampleTest.java` を次の内容で追加すると、既存のプロセス管理と固定期待値を再利用できます。

```java
package learning;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class AdditionalExampleTest {
    @Test void initialCatalogHasNoOrders() throws Exception {
        try (SalesHarness h = SalesHarness.open(false)) {
            assertEquals(0, h.batch());
            assertEquals(java.util.List.of(),
                CatalogCheck.differences(CatalogCheck.f1(), h.snapshot()));
        }
    }
}
```

`./mvnw -Dtest=AdditionalExampleTest test` で実行します。故障検出の練習では、例の snapshot 直前に `h.execute("UPDATE products SET price=121 WHERE product_code='P001'")` を一時追加すると価格不一致で FAIL になります。追加した行を削除して再実行し PASS を確認してください。専用 DB は `try` 終了時に停止確認のうえ削除します。

## 同期観測の時刻と応答取得の制約

Java の Playwright イベントコールバックの実行時刻は実際のネットワーク時刻とは限りません。同期中ケースはブラウザーの Resource Timing の `requestStart` と `responseStart` を使い、ブラウザー時刻を Java の `System.nanoTime()` と要求前後の2回の往復で較正します。往復時間と較正差に加え各側5msの余裕を引いた区間内でのみ DB の版1→版2を採用し、較正不可や区間不成立は未確認とします。表示完了時刻まで区間を延長しません。ただし2回の較正だけでは両時計の間のドリフト上限を証明できないため、現在は候補の重なりが見つかっても未確認にします。観測値と候補判定は保存します。信頼できる時計間の誤差上限を別途確立するまでは PASS にしません。

この環境では `Response.text()` が応答取得中に無期限に待つ現象を確認しました。そのため試験用 `addInitScript` が元の `fetch` を呼び、返す Response は変更せず、複製の JSON を取得します。複製処理には負荷があり画面の時刻に影響し得ます。重なり判定にはコールバック時刻や表示完了時刻を使わず、ブラウザーの Resource Timing と DB の保守的な共通区間のみを使います。本文はメモリー内で照合し、証跡には保存しません。
