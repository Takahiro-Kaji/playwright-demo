import { readResponseJson } from "./response-body.ts";
import { requireExpectedBatchError } from "./batch-result.ts";
import { test } from "@playwright/test";
import { Unconfirmed, type Harness, type BaseHarness } from "./harness.ts";
export type Scenario =
  | { kind: "ui"; title: string; run: (h: Harness) => Promise<void> }
  | { kind: "batch"; title: string; run: (h: BaseHarness) => Promise<void> };
export const scenarios: Scenario[] = [];
function register(title: string, run: (h: Harness) => Promise<void>) {
  scenarios.push({ kind: "ui", title, run });
}
function registerBatch(title: string, run: (h: BaseHarness) => Promise<void>) {
  scenarios.push({ kind: "batch", title, run });
}
import { requireThat as check } from "./environment.ts";
import { expectedFixture, until } from "./lifecycle.ts";
import { compareMysql, snapshotMysql } from "./db.ts";
import { salesFixture } from "./fixture.ts";
import {
  hasObservedOverlap,
  type Attempt,
  type Observation,
} from "../targets/sales/overlap.ts";
import { syncDisplayMatches } from "../targets/sales/sync-display.ts";
const equal = (a: unknown, b: unknown, code: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), code);
async function batch(h: BaseHarness) {
  check((await h.env.batch()).outcome === "complete", "BATCH_NOT_COMPLETE");
}
async function compare(
  h: BaseHarness,
  expected: Parameters<typeof compareMysql>[1],
  code: string,
) {
  const differences = await compareMysql(h.db, expected);
  if (differences.length) {
    h.differences = {};
    for (const difference of differences) {
      const kind = difference.split(":").slice(0, 2).join(":");
      h.differences[kind] = (h.differences[kind] || 0) + 1;
    }
  }
  check(differences.length === 0, code);
}
async function verify(h: BaseHarness, name: string) {
  await compare(h, expectedFixture(name), "FIXED_DB_MISMATCH");
}
async function show(h: Harness) {
  const wait = h.page.waitForResponse(
    (r) =>
      r.url() === new URL("/api/products", h.page.url()).href &&
      r.request().method() === "GET" &&
      r.frame() === h.page.mainFrame(),
    { timeout: 10000 },
  );
  const [r] = await Promise.all([wait, h.page.locator("#refresh").click()]);
  check(r.status() === 200, "PRODUCT_HTTP_FAILED");
  const body = await readResponseJson(r);
  await until(
    async () =>
      (await h.page.locator("#products > div").count()) ===
      body.products.length,
    3000,
    "DISPLAY_INCOMPLETE",
    50,
  );
  return body.products;
}
async function order(h: Harness, status: number, body: unknown, text: string) {
  const wait = h.page.waitForResponse(
    (r) =>
      r.url() === new URL("/api/orders", h.page.url()).href &&
      r.request().method() === "POST" &&
      r.frame() === h.page.mainFrame(),
    { timeout: 10000 },
  );
  const [r] = await Promise.all([
    wait,
    h.page.locator('[data-product-code="P001"]').click({ timeout: 5000 }),
  ]);
  check(r.status() === status, "ORDER_HTTP_MISMATCH");
  const result = await readResponseJson(r);
  if (body) equal(result, body, "ORDER_BODY_MISMATCH");
  await until(
    async () => (await h.page.locator("#result").textContent()) === text,
    3000,
    "ORDER_DISPLAY_MISMATCH",
    50,
  );
  return result;
}
async function availability(h: Harness, status: number, text: string) {
  const waiting = h.page.waitForResponse(
    (r) =>
      r.url() === new URL("/api/availability", h.page.url()).href &&
      r.request().method() === "GET" &&
      r.frame() === h.page.mainFrame(),
    { timeout: 10000 },
  );
  const [r] = await Promise.all([
    waiting,
    h.page.locator("#availability").click(),
  ]);
  check(r.status() === status, "AVAILABILITY_HTTP_MISMATCH");
  equal(
    await readResponseJson(r),
    status === 200 ? { available: true } : { error: "UPSTREAM_UNAVAILABLE" },
    "AVAILABILITY_BODY_MISMATCH",
  );
  await until(
    async () =>
      (await h.page.locator("#availability-result").textContent()) === text,
    3000,
    "AVAILABILITY_DISPLAY_MISMATCH",
    50,
  );
}

register("UI-01 UI正常・学習用通常HTTP IFと受注", async (h: Harness) => {
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
    check(
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

register("UI-02 UIモック503・DB不変", async (h: Harness) => {
  let before: unknown,
    old = 200;
  await test.step("Given: データセット1同期とモック503実応答", async () => {
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
    await test.step("When: 画面から外部接続確認", () =>
      availability(h, 502, "外部システムエラー"));
    await test.step("Then: 4表全件不変", async () =>
      equal(await snapshotMysql(h.db), before, "UNEXPECTED_DB_MUTATION"));
  }
});

registerBatch("BATCH-01 バッチ正常・全件照合", async (h: BaseHarness) => {
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

registerBatch(
  "BATCH-02 バッチモック503・異常終了とDB不変",
  async (h: BaseHarness) => {
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
  },
);

register("CROSS-02 古いversionによる受注拒否", async (h: Harness) => {
  let before: unknown;
  await test.step("Given: データセット1表示を保持してデータセット2同期・固定照合", async () => {
    await batch(h);
    await verify(h, "f1");
    await show(h);
    await h.env.catalog("f2");
    await batch(h);
    await verify(h, "f2");
    before = await snapshotMysql(h.db);
  });
  await test.step("When: 古い画面から受注", () =>
    order(
      h,
      409,
      { error: "STALE_VERSION" },
      "情報が更新されました。再表示してください",
    ).then(() => {}));
  await test.step("Then: 4表全件不変", async () =>
    equal(await snapshotMysql(h.db), before, "UNEXPECTED_DB_MUTATION"));
});

register("CROSS-03 不整合情報による受注拒否・復元", async (h: Harness) => {
  let before: unknown;
  {
    await test.step("Given: データセット1表示後に専用DBの在庫行を欠落", async () => {
      await batch(h);
      await verify(h, "f1");
      await show(h);
      h.afterActions.push(() =>
        test.step("After: 欠落在庫を復元し固定データセット1を全件照合", async () => {
          await h.db.execute(
            "INSERT INTO inventory(product_code,quantity) VALUES (?,?) ON DUPLICATE KEY UPDATE quantity=VALUES(quantity)",
            ["P001", 5],
          );
          await verify(h, "f1");
        }),
      );
      await h.db.execute("DELETE FROM inventory WHERE product_code=?", [
        "P001",
      ]);
      before = await snapshotMysql(h.db);
    });
    await test.step("When: 表示済み商品を受注", () =>
      order(
        h,
        409,
        { error: "INCONSISTENT_DATA" },
        "商品情報に不整合があります",
      ).then(() => {}));
    await test.step("Then: 4表全件不変", async () =>
      equal(await snapshotMysql(h.db), before, "UNEXPECTED_DB_MUTATION"));
  }
});

register("CROSS-01 同期中UI・3000件全表示と独立DB観測", async (h: Harness) => {
  const expectations = [salesFixture("bulk1"), salesFixture("bulk2")].map(
    (f, i) => ({
      rows: f.products.map(({ active, ...p }) => ({ ...p, version: i + 1 })),
      texts: f.products.map(
        (p) => `${p.name} ${p.price}円 在庫${p.quantity}受注`,
      ),
    }),
  );
  const samples: Observation[] = [],
    attempts: Attempt[] = [];
  let current: Attempt | undefined,
    stop = false,
    done = false;
  let running: Promise<void> | undefined, observing: Promise<void> | undefined;
  const pageErrors: number[] = [],
    failedHttp: number[] = [];
  h.page.on("pageerror", () => pageErrors.push(1));
  h.page.on("response", (r) => {
    if (r.status() >= 500) failedHttp.push(r.status());
    if (
      current &&
      r.url() === new URL("/api/products", h.page.url()).href &&
      r.request().method() === "GET" &&
      r.frame() === h.page.mainFrame()
    )
      current.response = performance.now();
  });
  h.page.on("request", (r) => {
    if (
      current &&
      r.url() === new URL("/api/products", h.page.url()).href &&
      r.method() === "GET" &&
      r.frame() === h.page.mainFrame()
    )
      current.start = performance.now();
  });
  try {
    await test.step("Given: 固定旧3000件同期後、新3000件を実応答確認", async () => {
      await h.env.catalog("bulk1");
      await batch(h);
      await verify(h, "bulk1");
      await h.env.catalog("bulk2");
    });
    await test.step("When: 実JobとUI参照・独立SELECTを同一単調時計で並行", async () => {
      const deadline = performance.now() + 12000;
      observing = (async () => {
        while (
          !stop &&
          samples.length < 10000 &&
          performance.now() < deadline
        ) {
          const start = performance.now();
          const [rows] = await h.db.query<any[]>(
            "SELECT catalog_version FROM sync_state WHERE id=1",
          );
          samples.push({
            start,
            end: performance.now(),
            version: rows[0]?.catalog_version,
          });
        }
      })();
      // Both promises get rejection handlers immediately; they are always reaped below.
      const observeResult = observing.then(
        () => undefined,
        (e) => e,
      );
      running = (async () => {
        const result = await h.env.batch(12000);
        if (result.outcome === "timeout")
          throw new Unconfirmed("BATCH_OBSERVATION_DEADLINE");
        check(result.outcome === "complete", "BULK_BATCH_FAILED");
      })().finally(() => {
        done = true;
      });
      const batchResult = running.then(
        () => undefined,
        (e) => e,
      );
      for (
        let i = 0;
        i < 20 && performance.now() < deadline && (!done || i === 0);
        i++
      ) {
        current = {
          start: null,
          response: null,
          display: null,
          status: null,
          valid: null,
        };
        attempts.push(current);
        const pending = h.page.waitForResponse(
          (r) =>
            r.url() === new URL("/api/products", h.page.url()).href &&
            r.request().method() === "GET" &&
            r.frame() === h.page.mainFrame(),
          { timeout: 3000 },
        );
        const [response] = await Promise.all([
          pending,
          h.page.locator("#refresh").click({ timeout: 3000 }),
        ]);
        current.status = response.status();
        const body = await readResponseJson(response, 3000);
        const view = expectations.find(
          (v) => JSON.stringify(v.rows) === JSON.stringify(body.products),
        );
        check(view, "BULK_RESPONSE_MISMATCH");
        await until(
          async () =>
            (await h.page.locator("#products > div").count()) === 3000 &&
            (await h.page.locator("#products > div").first().textContent()) ===
              view.texts[0],
          3000,
          "BULK_DISPLAY_INCOMPLETE",
          25,
        );
        const texts = await h.page.locator("#products > div").allTextContents();
        const enabled = [
          await h.page.locator("#refresh").isEnabled(),
          ...(await h.page
            .locator("[data-product-code]")
            .evaluateAll((nodes) =>
              nodes.map((n) => !(n as HTMLButtonElement).disabled),
            )),
        ];
        current.display = performance.now();
        current.valid = syncDisplayMatches(
          body.products,
          texts,
          enabled,
          response.status(),
          pageErrors.map(String),
          failedHttp,
          expectations,
        );
        check(current.valid, "BULK_DISPLAY_MISMATCH");
        current = undefined;
      }
      stop = true;
      const [observationError, batchError] = await Promise.all([
        observeResult,
        batchResult,
      ]);
      if (observationError) throw Error("OBSERVATION_FAILED");
      if (batchError) throw batchError;
    });
    await test.step("Then: 最終DB全件と同一HTTP参照内の1→2遷移", async () => {
      await verify(h, "bulk2");
      check(!pageErrors.length && !failedHttp.length, "BULK_HTTP_OR_JS_FAILED");
      if (!hasObservedOverlap(attempts, samples))
        throw new Unconfirmed("OVERLAP_NOT_OBSERVED");
    });
  } finally {
    stop = true;
    const settled = await Promise.allSettled(
      [running, observing].filter(Boolean),
    );
    h.observations = {
      clock:
        "runner performance.now milliseconds; network round trips bracket SQL",
      limitMs: 12000,
      maxAttempts: 20,
      maxSamples: 10000,
      attempts,
      samples,
      batchDone: done,
      established: hasObservedOverlap(attempts, samples),
    };
    // Failures were handled above or are propagated by the enclosing body.
  }
});
