/** 同期中UI・古いversion・不整合受注の3ケース。共通Afterは harness.ts。 */
import { uiTest as test, business } from "../../fixtures.ts";
import { Unconfirmed } from "../../harness.ts";
import { until } from "../../lifecycle.ts";
import { salesFixture } from "../../fixture.ts";
import { readResponseJson } from "../../response-body.ts";
import { order, show } from "../../operations.ts";
import {
  hasObservedOverlap,
  type Attempt,
  type Observation,
} from "../../../targets/sales/overlap.ts";
import { syncDisplayMatches } from "../../../targets/sales/sync-display.ts";
import { assertCondition } from "../../environment.ts";
import { snapshotMysql } from "../../db.ts";
import { batch, equal, verify } from "../../operations.ts";

test("CROSS-02 古いversionによる受注拒否", async ({ uiHarness: h }) => {
  await business(h, async () => {
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
});

test("CROSS-03 不整合情報による受注拒否・復元", async ({ uiHarness: h }) => {
  await business(h, async () => {
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
});

test("CROSS-01 同期中UI・3000件全表示と独立DB観測", async ({
  uiHarness: h,
}) => {
  await business(h, async () => {
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
    let running: Promise<void> | undefined,
      observing: Promise<void> | undefined;
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
        // 両方のPromiseに即座に失敗時の処理を登録し、下で必ず完了を待つ。
        const observeResult = observing.then(
          () => undefined,
          (e) => e,
        );
        running = (async () => {
          const result = await h.env.batch(12000);
          if (result.outcome === "timeout")
            throw new Unconfirmed("BATCH_OBSERVATION_DEADLINE");
          assertCondition(result.outcome === "complete", "BULK_BATCH_FAILED");
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
          assertCondition(view, "BULK_RESPONSE_MISMATCH");
          await until(
            async () =>
              (await h.page.locator("#products > div").count()) === 3000 &&
              (await h.page
                .locator("#products > div")
                .first()
                .textContent()) === view.texts[0],
            3000,
            "BULK_DISPLAY_INCOMPLETE",
            25,
          );
          const texts = await h.page
            .locator("#products > div")
            .allTextContents();
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
          assertCondition(current.valid, "BULK_DISPLAY_MISMATCH");
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
        assertCondition(
          !pageErrors.length && !failedHttp.length,
          "BULK_HTTP_OR_JS_FAILED",
        );
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
      // 失敗は上で処理済み、または外側のテスト本体へ伝播する。
    }
  });
});
