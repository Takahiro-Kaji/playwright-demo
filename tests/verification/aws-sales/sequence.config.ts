import { defineConfig } from "@playwright/test";
import aws from "../../aws-sales/aws-sales.config.ts";
import local from "../../aws-sales/local.config.ts";
import { resolve } from "node:path";

// 実際の入口設定とreporterを、プロセス内の模擬環境で検証する。
const config = process.env.SEQUENCE_MODE === "local" ? local : aws;
if (config.reporter !== "./support/reporter.ts")
  throw Error("ENTRYPOINT_REPORTER_MISMATCH");
export default defineConfig(config, {
  testDir: ".",
  testMatch: "sequence.fixture.ts",
  reporter: resolve("tests/aws-sales/support/reporter.ts"),
  timeout: 15000,
});
