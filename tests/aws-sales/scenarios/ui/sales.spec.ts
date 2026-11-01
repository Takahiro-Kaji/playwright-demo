/** UI正常・外部IF障害の2ケース。共通の準備・Afterは harness.ts。 */
import { uiTest as test, business } from "../../support/fixtures.ts";
import { expectedFixture } from "../../upstream/fixtures.ts";
import { availability, compare, order, show } from "../../support/operations.ts";
import { assertCondition } from "../../environment/state.ts";
import { snapshotMysql } from "../../database/rows.ts";
import { batch, equal, verify } from "../../support/operations.ts";

test("UI-01 UI正常・学習用通常HTTP IFと受注", async ({ uiHarness: h }) => {
  await business(h, async () => {
    const initial = expectedFixture("f1");
    const expected = expectedFixture("f1");
    expected.products[0].quantity = 4;
    expected.products[0].version = 2;
    await test.step("Given: データセット1を実Jobで同期し固定期待と照合", async () => {
      await batch(h);
      await verify(h, "f1");
    });
    let response: any;
    await test.step("When: 接続確認・商品表示・P001受注", async () => {
      await availability(h, 200, "接続可能");
      const rows = await show(h);
      equal(
        rows,
        initial.products.map(({ active, ...p }) => p),
        "PRODUCT_API_MISMATCH",
      );
      equal(
        await h.page.locator("#products > div").allTextContents(),
        ["ペン 120円 在庫5受注", "ノート 300円 在庫2受注"],
        "PRODUCT_DISPLAY_MISMATCH",
      );
      response = await order(h, 201, null, "受注しました");
    });
    await test.step("Then: 画面・受注API・4表全件を照合", async () => {
      assertCondition(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          response.orderId,
        ),
        "ORDER_ID_INVALID",
      );
      equal(
        response,
        {
          orderId: response.orderId,
          productCode: "P001",
          quantity: 1,
          unitPrice: 120,
          status: "CREATED",
        },
        "ORDER_BODY_MISMATCH",
      );
      const want = {
        ...expected,
        orders: [
          {
            order_id: response.orderId,
            product_code: "P001",
            quantity: 1,
            unit_price: 120,
            status: "CREATED",
          },
        ],
      };
      await compare(h, want, "ORDER_DB_MISMATCH");
    });
  });
});

test("UI-02 UIモック503・DB不変", async ({ uiHarness: h }) => {
  await business(h, async () => {
    let before: unknown,
      old = 200;
    await test.step("Given: データセット1同期とモック503実応答", async () => {
      await h.env.upstream.useFixture("f1", "mock");
      await batch(h);
      await verify(h, "f1");
      before = await snapshotMysql(h.db);
      old = await h.env.upstream.mockStatus();
      h.afterActions.push(() =>
        test.step("After: モック元値と業務HTTP応答を復元", async () => {
          await h.env.upstream.mockStatus(old);
          await h.env.upstream.verifyFixture("f1", old);
        }),
      );
      await h.env.upstream.mockStatus(503);
      await h.env.upstream.verifyFixture("f1", 503);
    });
    {
      await test.step("When: 画面から外部接続確認", () =>
        availability(h, 502, "外部システムエラー"));
      await test.step("Then: 4表全件不変", async () =>
        equal(await snapshotMysql(h.db), before, "UNEXPECTED_DB_MUTATION"));
    }
  });
});
