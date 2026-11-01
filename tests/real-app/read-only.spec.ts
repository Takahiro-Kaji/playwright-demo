/** 実アプリの参照画面の雛形。画面固有の期待値を設定してから実行する。 */
import { test, expect } from "../../test-support/auth/fixture.ts";
import { authSettings } from "../../test-support/auth/fixture.ts";
import { validateAuthConfig } from "../../test-support/auth/config.ts";

test.beforeAll(() => {
  // 明示的にSSOを必須にする。設定不足をskipや成功にしない。
  if (!authSettings()) throw Error("REAL_APP_AUTH_REQUIRED");
  const { REAL_APP_URL, REAL_APP_EXPECTED_SELECTOR, REAL_APP_EXPECTED_TEXT } =
    process.env;
  if (
    !REAL_APP_URL ||
    !REAL_APP_EXPECTED_SELECTOR ||
    !REAL_APP_EXPECTED_TEXT ||
    REAL_APP_EXPECTED_SELECTOR.length > 500
  )
    throw Error("REAL_APP_CONFIG_REQUIRED");
  validateAuthConfig(process.env.SALES_AUTH_STATE!, REAL_APP_URL);
});

test("認証済みの業務画面で固定した内容を参照できる", async ({ page }) => {
  // Given: 認証フィクスチャが保存状態を読み込み、業務処理より前に認証を検証する。
  // When: 対象の参照画面を開く。URLは許可された試験環境を指定する。
  // Then: あらかじめ決めた要素と文字列を確認する。
  // After: 読み取り専用のため業務データ変更なし。ページとコンテキストはPlaywrightが閉じる。
  try {
    await page.goto(process.env.REAL_APP_URL!, { timeout: 15000 });
    await expect(
      page.locator(process.env.REAL_APP_EXPECTED_SELECTOR!).first(),
    ).toHaveText(process.env.REAL_APP_EXPECTED_TEXT!, { timeout: 10000 });
  } catch {
    // URLや画面内容をテスト出力に残さない。
    throw Error(
      "REAL_APP_READ_CHECK_FAILED: 業務画面の表示を確認できませんでした。",
    );
  }
});
