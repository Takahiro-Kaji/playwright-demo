import { test } from "node:test";
import { strict as a } from "node:assert";
import Reporter, { ids } from "../../aws-sales/reporter.ts";

test("部分実行・未確認・後処理失敗を全件成功にしない", async () => {
  for (const variant of ["partial", "unknown", "after-failed", "complete"]) {
    const reporter = new Reporter();
    reporter.selected = new Set(variant === "partial" ? ids.slice(0, 1) : ids);
    for (const id of reporter.selected)
      reporter.results.set(id, {
        verdict:
          variant === "unknown" && id === "CROSS-01" ? "unconfirmed" : "passed",
        after:
          variant === "after-failed" && id === "UI-01" ? "failed" : "confirmed",
      });
    const result = await reporter.onEnd({
      status: "passed",
      startTime: new Date(),
      duration: 1,
    } as any);
    if (variant === "unknown" || variant === "after-failed")
      a.equal(result?.status, "failed");
    else a.equal(result, undefined);
    a.equal(reporter.results.size, variant === "partial" ? 1 : 7);
  }
});

test("runner failures and interruptions retain their original status", async () => {
  for (const status of ["failed", "timedout", "interrupted"] as const) {
    const reporter = new Reporter();
    reporter.selected.add("CROSS-01");
    a.equal(
      await reporter.onEnd({ status, startTime: new Date(), duration: 1 }),
      undefined,
    );
  }
});
