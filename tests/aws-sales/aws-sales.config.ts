import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "business.spec.ts",
  workers: 1,
  maxFailures: 1,
  retries: 0,
  fullyParallel: false,
  timeout: 360000,
  reporter: process.argv.includes("--list") ? "list" : "./reporter.ts",
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
