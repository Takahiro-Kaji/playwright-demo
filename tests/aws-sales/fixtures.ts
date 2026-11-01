/** 実AWSと専用kind検証で同じspecを使用するためのfixture入口。 */
import { test as awsTest, uiTest as awsUiTest } from "./harness.ts";
import { createLocalHarnessTests } from "../../aws/tests/local-harness.ts";
export { business } from "./harness.ts";

// 各Playwright configで明示する。通常の入口は実AWS用fixture。
const fixtures =
  process.env.AWS_SALES_TEST_MODE === "local"
    ? createLocalHarnessTests()
    : { test: awsTest, uiTest: awsUiTest };
export const test = fixtures.test;
export const uiTest = fixtures.uiTest;
