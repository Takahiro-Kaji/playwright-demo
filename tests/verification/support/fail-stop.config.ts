import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "fail-stop.fixture.ts",
  workers: 1,
  retries: 0,
  maxFailures: 1,
  reporter: [["../../../scripts/sales-reporter.ts"]],
});
