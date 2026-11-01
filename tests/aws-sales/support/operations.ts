/** ケース共通の操作・照合。ケース本体は scenarios/ 配下。 */
import type { BaseHarness, Harness } from "./harness.ts";
import { readResponseJson } from "./response-body.ts";
import { assertCondition } from "../environment/state.ts";
import { expectedFixture } from "../upstream/fixtures.ts";
import { until } from "./polling.ts";
import { compareMysql } from "../database/rows.ts";

export const equal = (a: unknown, b: unknown, code: string) =>
  assertCondition(JSON.stringify(a) === JSON.stringify(b), code);
export async function batch(h: BaseHarness) {
  assertCondition(
    (await h.env.batches.run()).outcome === "complete",
    "BATCH_NOT_COMPLETE",
  );
}
export async function compare(
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
  assertCondition(differences.length === 0, code);
}
export async function verify(h: BaseHarness, name: string) {
  await compare(h, expectedFixture(name), "FIXED_DB_MISMATCH");
}
export async function show(h: Harness) {
  const wait = h.page.waitForResponse(
    (r) =>
      r.url() === new URL("/api/products", h.page.url()).href &&
      r.request().method() === "GET" &&
      r.frame() === h.page.mainFrame(),
    { timeout: 10000 },
  );
  const [r] = await Promise.all([wait, h.page.locator("#refresh").click()]);
  assertCondition(r.status() === 200, "PRODUCT_HTTP_FAILED");
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
export async function order(
  h: Harness,
  status: number,
  body: unknown,
  text: string,
) {
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
  assertCondition(r.status() === status, "ORDER_HTTP_MISMATCH");
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
export async function availability(h: Harness, status: number, text: string) {
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
  assertCondition(r.status() === status, "AVAILABILITY_HTTP_MISMATCH");
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
