import { defineConfig } from "@playwright/test";
process.env.AWS_SALES_TEST_MODE = "aws";
export default defineConfig({
  testDir: ".",
  testMatch: "scenarios/*/sales.spec.ts",
  workers: 1,
  maxFailures: 1,
  retries: 0,
  fullyParallel: false,
  timeout: 360000,
  reporter: process.argv.includes("--list") ? "list" : "./support/reporter.ts",
  use: {
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    trace: "off",
    screenshot: "off",
    video: "off",
    actionTimeout: 10000,
    navigationTimeout: 15000,
  },
});
