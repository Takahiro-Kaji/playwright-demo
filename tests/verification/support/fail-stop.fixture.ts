import { test } from "@playwright/test";
import { writeFileSync } from "node:fs";
test("UI real learning HTTP success", async () => {
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
test("UI mock upstream unavailable", async () => {
  writeFileSync(process.env.SALES_HALT_MARKER!, "ran");
});
