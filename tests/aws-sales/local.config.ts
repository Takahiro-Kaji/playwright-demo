import { defineConfig } from "@playwright/test";
process.env.AWS_SALES_TEST_MODE = "local";
export default defineConfig({
  testDir: ".",
  testMatch: "scenarios/*/sales.spec.ts",
  workers: 1,
  maxFailures: 1,
  retries: 0,
  timeout: 360000,
  reporter: process.argv.includes("--list") ? "list" : "./support/reporter.ts",
  use: {
    channel: "chrome",
    headless: true,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
