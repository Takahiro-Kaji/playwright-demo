import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/scenarios",
  testMatch: "**/*.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 30000,
  reporter: [["list"], ["./scripts/sales-reporter.ts"]],
  use: {
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
