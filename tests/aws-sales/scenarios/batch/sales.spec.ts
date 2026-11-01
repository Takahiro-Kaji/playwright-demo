/** 同期バッチの正常・外部IF障害の2ケース。Chrome・保存認証は不要。 */
import { test, business } from "../../fixtures.ts";
import { requireExpectedBatchError } from "../../batch-result.ts";
import { snapshotMysql } from "../../db.ts";
import { batch, equal, verify } from "../../operations.ts";

test("BATCH-01 バッチ正常・全件照合", async ({ h }) => {
  await business(h, async () => {
    await test.step("Given: 通常IFのデータセット1実応答と空DB", async () => {
      await h.env.catalogMatches("f1");
      equal(
        await snapshotMysql(h.db),
        { products: [], inventory: [], sync: [], orders: [] },
        "INITIAL_DB_NOT_EMPTY",
      );
    });
    await test.step("When: 実Kubernetes Jobを起動し正常完了を確認", () =>
      batch(h));
    await test.step("Then: 商品・在庫・同期・受注を固定期待で全件照合", () =>
      verify(h, "f1"));
  });
});

test("BATCH-02 バッチモック503・異常終了とDB不変", async ({ h }) => {
  await business(h, async () => {
    let before: unknown,
      old = 200;
    await test.step("Given: データセット1同期後にモック503", async () => {
      await h.env.catalog("f1", "mock");
      await batch(h);
      await verify(h, "f1");
      before = await snapshotMysql(h.db);
      old = await h.env.mockStatus();
      h.afterActions.push(() =>
        test.step("After: モック元値と業務HTTP応答を復元", async () => {
          await h.env.mockStatus(old);
          await h.env.catalogMatches("f1", old);
        }),
      );
      await h.env.mockStatus(503);
      await h.env.catalogMatches("f1", 503);
    });
    {
      await test.step("When: Job失敗を確認（timeoutは失敗結果と別）", async () => {
        requireExpectedBatchError(await h.env.batch());
        await h.env.catalogMatches("f1", 503);
      });
      await test.step("Then: 4表全件不変", async () =>
        equal(await snapshotMysql(h.db), before, "UNEXPECTED_DB_MUTATION"));
    }
  });
});
