import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../../aws/tests",
  testMatch: "local-business.fixture.ts",
  workers: 1,
  maxFailures: 1,
  retries: 0,
  timeout: 360000,
  reporter: "list",
  use: {
    channel: "chrome",
    headless: true,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
