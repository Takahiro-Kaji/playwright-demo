import { test } from "@playwright/test";
import { writeFileSync } from "node:fs";
test("画面から外部接続を確認して正常に受注できる", async () => {
  try {
    test.skip(process.env.SALES_BUSINESS_FAILURE === "skip", "unconfirmed");
    if (process.env.SALES_BUSINESS_FAILURE === "1")
      throw Error("business-failure");
    test
      .info()
      .annotations.push({ type: "case-status", description: "passed" });
  } catch (e) {
    if (test.info().expectedStatus !== "skipped")
      test
        .info()
        .annotations.push({ type: "case-status", description: "failed" });
    throw e;
  } finally {
    test
      .info()
      .annotations.push({ type: "after", description: "要復旧・DB保持" });
    throw Error("after-failure");
  }
});
test("外部IF障害時は受注に失敗し関連データが変わらない", async () => {
  writeFileSync(process.env.SALES_HALT_MARKER!, "ran");
});
