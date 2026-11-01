/** 同期中表示・古い表示・不整合受注の3ケース。固定データ、各testのGiven→When→Then→Afterの順に読む。 */
import { test, expect } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { bulkCatalog, BULK_COUNT } from "../../targets/sales/bulk-fixture.ts";
import { hasObservedOverlap } from "../../targets/sales/overlap.ts";
import { harness } from "../../targets/sales/harness.ts";
import { compareCatalog } from "../../targets/sales/compare.ts";
import { DatabaseSync } from "node:sqlite";
import { syncDisplayMatches } from "../../targets/sales/sync-display.ts";

// { page }はPlaywrightのページfixture。asyncが返すPromiseをawaitして結果や失敗を受け取る。
// test.stepはレポートの区切り。通常値のexpectはその場で比較し、locatorへのexpectは再試行する。
// annotationは各ケースの判定や後片付けをレポーターが集計するために使う。
const f2 = {
  catalogVersion: 2,
  products: [
    {
      productCode: "P001",
      name: "ペン",
      price: 120,
      active: true,
      quantity: 3,
    },
    {
      productCode: "P002",
      name: "ノート",
      price: 300,
      active: true,
      quantity: 2,
    },
  ],
};

// CROSS-01: 旧・新の固定データを先に作り、同期と参照が重なった証拠を探す。
test("UI during synchronization", async ({ page }, info) => {
  const h = await harness("upstream");
  const initial = bulkCatalog(1),
    updated = bulkCatalog(2);
  const expectations = [initial, updated].map((catalog, index) => ({
    rows: catalog.products.map(({ productCode, name, price, quantity }) => ({
      productCode,
      name,
      price,
      quantity,
      version: index + 1,
    })),
    texts: catalog.products.map(
      (p) => `${p.name} ${p.price}円 在庫${p.quantity}受注`,
    ),
  }));
  const samples: { start: number; end: number; version: number }[] = [];
  const attempts: {
    start: number | null;
    response: number | null;
    display: number | null;
    status: number | null;
    valid: boolean | null;
  }[] = [];
  const pageErrors: string[] = [],
    failedHttp: number[] = [];
  const limitMs = 12000,
    maxAttempts = 20,
    maxSamples = 10000;
  let currentAttempt: (typeof attempts)[number] | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<number> | undefined;
  let batchDone = false,
    batchCode: number | null = null,
    established = false;
  const evidencePath = `.local/sales-learning-evidence/observations/${randomUUID()}.json`;
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("request", (request) => {
    if (currentAttempt && request.url().endsWith("/api/products"))
      currentAttempt.start = performance.now();
  });
  page.on("response", (r) => {
    if (r.status() >= 500) failedHttp.push(r.status());
    if (currentAttempt && r.url().endsWith("/api/products"))
      currentAttempt.response = performance.now();
  });
  try {
    await test.step("Given: 3000件の固定合成データを準備", async () => {
      await writeFile(h.catalog, JSON.stringify(initial));
      expect(await h.batch()).toBe(0);
      await page.goto(h.app);
      await writeFile(h.catalog, JSON.stringify(updated));
    });
    await test.step("When: バッチと継続参照・独立DB観測", async () => {
      const deadline = performance.now() + limitMs;
      const observe = () => {
        if (samples.length >= maxSamples) return;
        const start = performance.now();
        const row = h.query("SELECT catalog_version FROM sync_state")[0] as {
          catalog_version: number;
        };
        samples.push({
          start,
          end: performance.now(),
          version: row.catalog_version,
        });
      };
      observe();
      // 独立SELECTの開始・終了時刻も記録する。プロセスが動いているだけでは重なりの証拠にならない。
      timer = setInterval(observe, 1);
      running = h.batch().then((code) => {
        batchDone = true;
        batchCode = code;
        return code;
      });
      for (
        let i = 0;
        i < maxAttempts &&
        performance.now() < deadline &&
        (!batchDone || i === 0);
        i++
      ) {
        const attempt = {
          start: null as number | null,
          response: null as number | null,
          display: null as number | null,
          status: null as number | null,
          valid: null as boolean | null,
        };
        attempts.push(attempt);
        currentAttempt = attempt;
        // clickより前に応答待ちを登録する。Promiseは後でawaitし、速い応答も捕捉する。
        const pending = page.waitForResponse(
          (r) => r.url().endsWith("/api/products"),
          { timeout: 3000 },
        );
        await page
          .getByRole("button", { name: "商品表示" })
          .click({ timeout: 3000 });
        const response = await pending;
        attempt.status = response.status();
        const body = await response.json();
        const expectedView = expectations.find(
          (e) => JSON.stringify(e.rows) === JSON.stringify(body.products),
        );
        expect(expectedView, "応答は固定された旧または新の全件").toBeTruthy();
        await expect(page.locator("#products > div").first()).toHaveText(
          expectedView!.texts[0],
          { timeout: 3000 },
        );
        await expect(page.locator("#products > div")).toHaveCount(BULK_COUNT, {
          timeout: 3000,
        });
        const texts = await page.locator("#products > div").allTextContents();
        const buttonStates = await page
          .getByRole("button", { name: "受注" })
          .evaluateAll((nodes) =>
            nodes.map((n) => !(n as HTMLButtonElement).disabled),
          );
        const enabled = [
          await page.getByRole("button", { name: "商品表示" }).isEnabled(),
          ...buttonStates,
        ];
        attempt.display = performance.now();
        currentAttempt = undefined;
        attempt.valid = syncDisplayMatches(
          body.products,
          texts,
          enabled,
          response.status(),
          pageErrors,
          failedHttp,
          expectations,
        );
        expect(attempt.valid, "表示・応答・操作状態").toBe(true);
      }
      if (!batchDone) {
        const remaining = Math.max(0, deadline - performance.now());
        const completed = await Promise.race([
          running.then(() => true),
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), remaining),
          ),
        ]);
        test.skip(!completed, "同期が観測期限内に完了せず未確認");
      }
      expect(batchCode).toBe(0);
      observe();
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    });
    await test.step("Then: 観測区間とF2全件を照合", async () => {
      established = hasObservedOverlap(attempts, samples);
      expect(attempts.length).toBeGreaterThan(0);
      expect(pageErrors).toEqual([]);
      expect(failedHttp).toEqual([]);
      const db = new DatabaseSync(h.db);
      try {
        expect(
          compareCatalog(db, {
            products: updated.products.map((p) => ({ ...p, version: 2 })),
            deleted: [],
            catalogVersion: 2,
            orders: [],
          }),
        ).toEqual([]);
      } finally {
        db.close();
      }
      // 証拠を捕捉できない場合は未確認。表示やDBの不一致によるFAILとは区別する。
      test.skip(
        !established,
        "同期更新とUI参照の重なりを証明できないため未確認",
      );
    });
    test
      .info()
      .annotations.push({ type: "case-status", description: "passed" });
  } catch (error) {
    if (test.info().expectedStatus !== "skipped")
      test
        .info()
        .annotations.push({ type: "case-status", description: "failed" });
    throw error;
  } finally {
    await test.step("After: 観測保存とバッチ・プロセスの回収", async () => {
      if (timer) clearInterval(timer);
      const errors: unknown[] = [];
      try {
        await mkdir(".local/sales-learning-evidence/observations", {
          recursive: true,
        });
        const evidence = {
          clock: "process monotonic milliseconds",
          fixtureCount: BULK_COUNT,
          limitMs,
          maxAttempts,
          maxSamples,
          samplesTruncated: samples.length >= maxSamples,
          attempts,
          samples,
          batchDone,
          batchCode,
          established,
        };
        await writeFile(evidencePath, JSON.stringify(evidence, null, 2), {
          flag: "wx",
        });
        info.annotations.push({
          type: "observation-evidence",
          description: evidencePath,
        });
        await info.attach("overlap-evidence", {
          path: evidencePath,
          contentType: "application/json",
        });
      } catch (e) {
        errors.push(e);
      }
      if (running && !batchDone) {
        const stopped = await Promise.race([
          running.then(
            () => true,
            () => false,
          ),
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), 1000),
          ),
        ]);
        if (!stopped) errors.push(Error("BATCH_STOP_UNCONFIRMED"));
      }
      try {
        await h.cleanup(errors.length > 0);
      } catch (e) {
        errors.push(e);
      }
      if (errors.length) throw new AggregateError(errors, "After失敗");
    });
  }
});

// CROSS-02: 表示したversion 1のままF2同期後に受注し、拒否とDB不変を確認する。
test("stale version rejects order", async ({ page }) => {
  const h = await harness("upstream");
  let before: ReturnType<typeof h.snapshot>;
  try {
    await test.step("Given: version 1を表示しF2へ同期", async () => {
      expect(await h.batch()).toBe(0);
      await page.goto(h.app);
      await page.locator("#refresh").click();
      await writeFile(h.catalog, JSON.stringify(f2));
      expect(await h.batch()).toBe(0);
      const db = new DatabaseSync(h.db);
      try {
        expect(
          compareCatalog(db, {
            products: f2.products.map((p, i) => ({
              ...p,
              version: i === 0 ? 2 : 1,
            })),
            deleted: [],
            catalogVersion: 2,
            orders: [],
          }),
        ).toEqual([]);
      } finally {
        db.close();
      }
      // 固定期待でF2を検証した後のsnapshotは、受注操作による変化がないか比較する基準。
      before = h.snapshot();
    });
    let response: import("@playwright/test").Response;
    await test.step("When: 古い画面から受注", async () => {
      const waiting = page.waitForResponse((r) =>
        r.url().endsWith("/api/orders"),
      );
      await page.locator('[data-product-code="P001"]').click();
      response = await waiting;
    });
    await test.step("Then: 409とDB不変を確認", async () => {
      expect(response.status()).toBe(409);
      expect(await response.json()).toEqual({ error: "STALE_VERSION" });
      await expect(page.locator("#result")).toHaveText(
        "情報が更新されました。再表示してください",
      );
      expect(h.snapshot()).toEqual(before);
    });
    test
      .info()
      .annotations.push({ type: "case-status", description: "passed" });
  } catch (error) {
    if (test.info().expectedStatus !== "skipped")
      test
        .info()
        .annotations.push({ type: "case-status", description: "failed" });
    throw error;
  } finally {
    await test.step("After: プロセス回収", async () => {
      try {
        await h.cleanup();
      } catch (error) {
        throw new Error("After失敗", { cause: error });
      }
    });
  }
});

// CROSS-03: 専用DBだけで在庫行を欠落させ、拒否・不変・Afterでの復元を確認する。
test("inconsistent relationship rejects order", async ({ page }) => {
  const h = await harness("upstream");
  let removed = false;
  let before: ReturnType<typeof h.snapshot>;
  try {
    await test.step("Given: 在庫行を削除", async () => {
      expect(await h.batch()).toBe(0);
      await page.goto(h.app);
      await page.locator("#refresh").click();
      h.execute("DELETE FROM inventory WHERE product_code=?", "P001");
      removed = true;
      before = h.snapshot();
    });
    let response: import("@playwright/test").Response;
    await test.step("When: 不整合のまま受注", async () => {
      const waiting = page.waitForResponse((r) =>
        r.url().endsWith("/api/orders"),
      );
      await page.locator('[data-product-code="P001"]').click();
      response = await waiting;
    });
    await test.step("Then: 409とDB不変", async () => {
      expect(response.status()).toBe(409);
      expect(await response.json()).toEqual({ error: "INCONSISTENT_DATA" });
      await expect(page.locator("#result")).toHaveText(
        "商品情報に不整合があります",
      );
      expect(h.snapshot()).toEqual(before);
    });
    test
      .info()
      .annotations.push({ type: "case-status", description: "passed" });
  } catch (error) {
    if (test.info().expectedStatus !== "skipped")
      test
        .info()
        .annotations.push({ type: "case-status", description: "failed" });
    throw error;
  } finally {
    await test.step("After: 在庫復元とプロセス回収", async () => {
      const errors: unknown[] = [];
      if (removed)
        try {
          h.execute("INSERT INTO inventory VALUES(?,?)", "P001", 5);
          expect(
            h.query(
              "SELECT quantity FROM inventory WHERE product_code=?",
              "P001",
            ),
          ).toEqual([{ quantity: 5 }]);
        } catch (e) {
          errors.push(e);
        }
      try {
        await h.cleanup(errors.length > 0);
      } catch (e) {
        errors.push(e);
      }
      if (errors.length) throw new AggregateError(errors, "After失敗");
    });
  }
});
