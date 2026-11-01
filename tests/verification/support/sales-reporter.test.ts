import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, rmSync } from "node:fs";
import SalesReporter from "../../../scripts/sales-reporter.ts";

test("reporter confirms shared DB cleanup and keeps unobserved overlap as skipped", () => {
  const reporter = new SalesReporter();
  const annotations = [
    {
      type: "after",
      description: "停止確認・今回のデータのみ削除・既存データ不変",
    },
  ];
  reporter.onTestEnd(
    {
      title: "UI real learning HTTP success",
      annotations: [
        ...annotations,
        { type: "case-status", description: "passed" },
      ],
    } as any,
    { status: "passed" } as any,
  );
  assert.equal(reporter.results.get("UI-01")?.afterStatus, "confirmed");
  assert.equal(reporter.results.get("UI-01")?.caseStatus, "passed");
  reporter.onTestEnd(
    { title: "UI during synchronization", annotations } as any,
    { status: "skipped" } as any,
  );
  assert.equal(reporter.results.get("CROSS-01")?.afterStatus, "confirmed");
  assert.equal(reporter.results.get("CROSS-01")?.caseStatus, "skipped");
});

for (const outcome of ["passed", "failed", "not-run"] as const) {
  test(`reporter retains all UI error variants: ${outcome}`, async () => {
    const reporter = new SalesReporter();
    const titles = [500, 502, 503].map(
      (status) => `UI mock upstream unavailable (${status})`,
    );
    reporter.selected = new Set(titles);
    for (const [index, title] of titles.entries()) {
      if (index === 1 && outcome === "not-run") continue;
      const status = index === 1 ? outcome : "passed";
      reporter.onTestEnd(
        {
          title,
          annotations: [
            { type: "case-status", description: status },
            {
              type: "after",
              description: "停止確認・今回のデータのみ削除・既存データ不変",
            },
          ],
        } as any,
        { status } as any,
      );
    }
    const dir = `.local/sales-learning-evidence/${reporter.runId}`;
    try {
      const result = await reporter.onEnd({
        status: outcome === "failed" ? "failed" : "passed",
      } as any);
      const summary = JSON.parse(readFileSync(`${dir}/summary.json`, "utf8"));
      assert.deepEqual(summary.executionScope.selectedIds, ["UI-02"]);
      const ui = summary.cases.find((c: any) => c.id === "UI-02");
      assert.equal(ui.caseStatus, outcome === "not-run" ? "unknown" : outcome);
      assert.equal(
        ui.afterStatus,
        outcome === "not-run" ? "unknown" : "confirmed",
      );
      assert.deepEqual(
        ui.executions.map((e: any) => e.title),
        titles,
      );
      assert.equal(ui.executions[1].caseStatus, outcome);
      assert.equal(result?.status, outcome === "passed" ? undefined : "failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
