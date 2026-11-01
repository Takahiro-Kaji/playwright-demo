/** 手動SSOの保存と再利用を確認する入口。設定検証、setupAuth、コマンド入口の順に読む。 */
import { chromium } from "@playwright/test";
import { mkdir, chmod } from "node:fs/promises";
import { resolve, sep, dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * 保存先stateと対象URLを検証し、正規化したpathとurlを返す。
 * ローカル指定外、HTTPS以外、秘密を含み得るURLなどは例外。
 */
export function validateAuthConfig(state: string, target: string) {
  const root = resolve(".local/auth") + sep;
  const path = resolve(state);
  if (!path.startsWith(root) || !path.endsWith(".json"))
    throw Error("AUTH_PATH_REQUIRED");
  const url = new URL(target);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error("HTTPS_TARGET_REQUIRED");
  return { path, url: url.toString() };
}
/**
 * 手動認証後の状態を保存し、新contextとChrome再起動後の再利用を検証する。
 * stateは保存先、targetは開始URL、expectedUrlとselectorは認証済み画面の条件。戻り値なし。
 * 認証・保存・再利用の検証に失敗すると例外。実SSOでの成立は別途確認が必要。
 */
export async function setupAuth(
  state: string,
  target: string,
  expectedUrl: string,
  selector: string,
) {
  if (!selector || selector.length > 500) throw Error("AUTH_SELECTOR_REQUIRED");
  const expected = validateAuthConfig(state, expectedUrl).url;
  /** pageが指定URLと可視要素を満たすまで待つ。戻り値なし。期限切れは例外。 */
  async function verify(page: import("@playwright/test").Page) {
    await page.waitForURL(expected, { timeout: 15000 });
    await page
      .locator(selector)
      .first()
      .waitFor({ state: "visible", timeout: 15000 });
  }
  const { path, url } = validateAuthConfig(state, target);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const terminal = createInterface({ input: stdin, output: stdout });
  let browser = await chromium.launch({ channel: "chrome", headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url);
    await terminal.question(
      "ブラウザーで手動ログインし、完了後にEnterを押してください。",
    );
    await verify(page);
    // Cookieやトークンを含み得るため秘密としてローカルに限定し、内容をログや証跡に出さない。
    const oldMask = process.umask(0o077);
    try {
      await context.storageState({ path });
      await chmod(path, 0o600);
    } finally {
      process.umask(oldMask);
    }
    await context.close();
    const check = await browser.newContext({ storageState: path });
    const p = await check.newPage();
    await p.goto(url);
    await verify(p);
    await check.close();
    await browser.close();
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const restarted = await browser.newContext({ storageState: path });
    const again = await restarted.newPage();
    await again.goto(url);
    await verify(again);
    await restarted.close();
    console.log(
      "認証済み画面を新規コンテキストとChrome再起動後に確認しました。",
    );
  } finally {
    terminal.close();
    await browser.close();
  }
}
if (import.meta.main) {
  if (!process.stdin.isTTY) throw Error("INTERACTIVE_TERMINAL_REQUIRED");
  try {
    await setupAuth(
      process.env.SALES_AUTH_STATE!,
      process.env.SALES_AUTH_URL!,
      process.env.SALES_AUTH_SUCCESS_URL!,
      process.env.SALES_AUTH_SUCCESS_SELECTOR!,
    );
  } catch {
    console.error("認証準備を完了できませんでした。");
    process.exitCode = 1;
  }
}
