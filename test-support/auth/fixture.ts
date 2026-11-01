/** UIテスト用の任意SSO前提。認証確認は業務ケースの準備・変更より前に行う。 */
import { test as base, expect, type Page } from "@playwright/test";
import { validateAuthConfig } from "./config.ts";
import { readFile } from "node:fs/promises";

export function authSettings(env: NodeJS.ProcessEnv = process.env) {
  if (env.SALES_AUTH_ENABLED === "0") return undefined;
  if (env.SALES_AUTH_ENABLED !== undefined && env.SALES_AUTH_ENABLED !== "1")
    throw Error("AUTH_ENABLED_INVALID");
  const {
    SALES_AUTH_STATE: state,
    SALES_AUTH_URL: target,
    SALES_AUTH_SUCCESS_URL: success,
    SALES_AUTH_SUCCESS_SELECTOR: selector,
  } = env;
  if (
    env.SALES_AUTH_ENABLED === undefined &&
    state === undefined &&
    target === undefined &&
    success === undefined &&
    selector === undefined
  )
    return undefined;
  if (!state || !target || !success || !selector || selector.length > 500)
    throw Error("AUTH_CONFIG_REQUIRED");
  const start = validateAuthConfig(state, target);
  const expected = validateAuthConfig(state, success);
  return {
    state: start.path,
    target: start.url,
    expected: expected.url,
    selector,
  };
}

export async function verifyAuthPage(
  page: Page,
  settings: NonNullable<ReturnType<typeof authSettings>>,
) {
  try {
    await page.goto(settings.target, { timeout: 15000 });
    await page.waitForURL(settings.expected, { timeout: 10000 });
    await page
      .locator(settings.selector)
      .first()
      .waitFor({ state: "visible", timeout: 10000 });
  } catch {
    // Playwrightの例外にはURLや認証情報が含まれ得るため表示しない。
    throw Error(
      "AUTH_PREREQUISITE_FAILED: 認証状態を確認できません。手動認証をやり直してください。",
    );
  }
}

export const test = base.extend({
  storageState: async ({}, use) => {
    const settings = authSettings();
    if (!settings) return await use(undefined);
    let state: { cookies: any[]; origins: any[] };
    try {
      state = JSON.parse(await readFile(settings.state, "utf8"));
      if (!Array.isArray(state.cookies) || !Array.isArray(state.origins))
        throw Error();
    } catch {
      throw Error(
        "AUTH_STATE_UNAVAILABLE: 認証状態を読み込めません。手動認証をやり直してください。",
      );
    }
    await use(state);
  },
  page: async ({ page, context }, use, info) => {
    const settings = authSettings();
    if (settings) {
      info.annotations.push({
        type: "auth-prerequisite",
        description: "認証確認前",
      });
      const check = await context.newPage();
      try {
        await verifyAuthPage(check, settings);
      } finally {
        await check.close();
      }
    }
    await use(page);
  },
});
export { expect };
