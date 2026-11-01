import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "batch-fixture.fixture.ts",
  workers: 1,
  retries: 0,
  timeout: 15000,
  reporter: "list",
});
