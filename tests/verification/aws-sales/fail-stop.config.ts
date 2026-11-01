import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "fail-stop.fixture.ts",
  workers: 1,
  maxFailures: 1,
  retries: 0,
  timeout: 15000,
  reporter: "list",
  use: {
    channel: "chrome",
    headless: true,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
