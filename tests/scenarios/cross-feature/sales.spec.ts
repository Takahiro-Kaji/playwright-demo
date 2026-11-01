import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { harness } from "../../targets/sales/harness.ts";

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

test("UI during synchronization", async ({ page }, info) => {
  const h = await harness("upstream");
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<number> | undefined;
  try {
    await test.step("Given: F1とF2を準備", async () => {
      expect(await h.batch()).toBe(0);
      await page.goto(h.app);
      await writeFile(h.catalog, JSON.stringify(f2));
    });
    const observations: { time: number; version: number }[] = [];
    let requestAt = 0,
      responseAt = 0;
    await test.step("When: UI参照と同期を並行し観測", async () => {
      page.on("request", (request) => {
        if (!request.url().endsWith("/api/products")) return;
        requestAt = Date.now();
        const observe = () => {
          const row = h.query("SELECT catalog_version FROM sync_state")[0] as {
            catalog_version: number;
          };
          observations.push({ time: Date.now(), version: row.catalog_version });
        };
        observe();
        timer = setInterval(observe, 1);
        running = h.batch();
      });
      page.on("response", (response) => {
        if (response.url().endsWith("/api/products")) {
          responseAt = Date.now();
          if (timer) clearInterval(timer);
        }
      });
      await page.locator("#refresh").click();
      await expect(page.locator("#products")).toContainText("ペン");
      expect(await running).toBe(0);
    });
    await test.step("Then: 重なりを計算し証拠を保存", async () => {
      const within = observations.filter(
        (x) => x.time >= requestAt && x.time <= responseAt,
      );
      const established = within.some(
        (x, i) =>
          x.version === 1 && within.slice(i + 1).some((y) => y.version === 2),
      );
      await info.attach("overlap.json", {
        body: JSON.stringify({
          requestAt,
          responseAt,
          observations: within,
          established,
        }),
        contentType: "application/json",
      });
      expect(h.query("SELECT catalog_version FROM sync_state")).toEqual([
        { catalog_version: 2 },
      ]);
      test.skip(
        !established,
        "同期更新とUI参照の重なりを証明できないため未確認",
      );
    });
  } finally {
    await test.step("After: 同期とプロセスを回収", async () => {
      if (timer) clearInterval(timer);
      const errors: unknown[] = [];
      if (running)
        try {
          await running;
        } catch (e) {
          errors.push(e);
        }
      try {
        await h.cleanup(errors.length > 0);
      } catch (e) {
        errors.push(e);
      }
      expect.soft(errors.map(String), "After失敗").toEqual([]);
    });
  }
});

test("stale version rejects order", async ({ page }) => {
  const h = await harness("upstream");
  try {
    await test.step("Given: version 1を表示しF2へ同期", async () => {
      expect(await h.batch()).toBe(0);
      await page.goto(h.app);
      await page.locator("#refresh").click();
      await writeFile(h.catalog, JSON.stringify(f2));
      expect(await h.batch()).toBe(0);
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
      expect(h.query("SELECT * FROM orders")).toEqual([]);
      expect(
        h.query(
          "SELECT p.version,i.quantity FROM products p JOIN inventory i USING(product_code) WHERE product_code=?",
          "P001",
        ),
      ).toEqual([{ version: 2, quantity: 3 }]);
    });
  } finally {
    await test.step("After: プロセス回収", async () => {
      try {
        await h.cleanup();
      } catch (error) {
        expect.soft(String(error), "After失敗").toBe("");
      }
    });
  }
});

test("inconsistent relationship rejects order", async ({ page }) => {
  const h = await harness("upstream");
  let removed = false;
  try {
    await test.step("Given: 在庫行を削除", async () => {
      expect(await h.batch()).toBe(0);
      await page.goto(h.app);
      await page.locator("#refresh").click();
      h.execute("DELETE FROM inventory WHERE product_code=?", "P001");
      removed = true;
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
      expect(h.query("SELECT * FROM orders")).toEqual([]);
      expect(
        h.query("SELECT * FROM inventory WHERE product_code=?", "P001"),
      ).toEqual([]);
    });
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
      expect.soft(errors.map(String), "After失敗").toEqual([]);
    });
  }
});
