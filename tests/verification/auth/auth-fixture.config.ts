import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "auth-fixture.fixture.ts",
  reporter: "list",
  use: {
    channel: "chrome",
    headless: true,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
