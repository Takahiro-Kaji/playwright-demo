/** 実アプリ用。ローカルデモの7ケースとは明示的に分けて実行する。 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 45000,
  reporter: "list",
  use: {
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
