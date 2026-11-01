import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, rmSync } from "node:fs";
import {
  salesCases,
  salesCaseTestTitles,
} from "../../../test-support/cases.ts";
import SalesReporter from "../../../scripts/sales-reporter.ts";

test("集計で共有DBの後片付けを確認し未観測の重なりはスキップとして残す", () => {
  const reporter = new SalesReporter();
  const annotations = [
    {
      type: "after",
      description: "停止確認・今回のデータのみ削除・所有行の残存なし",
    },
  ];
  reporter.onTestEnd(
    {
      title: "画面から外部接続を確認して正常に受注できる",
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
    {
      title: "同期中の商品表示が旧状態または新状態で一貫する",
      annotations,
    } as any,
    { status: "skipped" } as any,
  );
  assert.equal(reporter.results.get("CROSS-01")?.afterStatus, "confirmed");
  assert.equal(reporter.results.get("CROSS-01")?.caseStatus, "skipped");
});

for (const caseId of ["UI-02", "BATCH-02"] as const) {
  for (const outcome of ["passed", "failed", "not-run"] as const) {
    test(`集計で${caseId}障害の全種類を保持する: ${outcome}`, async () => {
      const reporter = new SalesReporter();
      const item = salesCases.find((c) => c.id === caseId)!;
      const titles = salesCaseTestTitles(item);
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
                description: "停止確認・今回のデータのみ削除・所有行の残存なし",
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
        assert.deepEqual(summary.executionScope.selectedIds, [caseId]);
        const ui = summary.cases.find((c: any) => c.id === caseId);
        assert.equal(
          ui.caseStatus,
          outcome === "not-run" ? "unknown" : outcome,
        );
        assert.equal(
          ui.afterStatus,
          outcome === "not-run" ? "unknown" : "confirmed",
        );
        assert.deepEqual(
          ui.executions.map((e: any) => e.title),
          titles,
        );
        assert.equal(ui.executions[1].caseStatus, outcome);
        assert.equal(
          result?.status,
          outcome === "passed" ? undefined : "failed",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

for (const only503 of [true, false]) {
  test(`必須パラメータを含む全体完了と部分実行を区別する: only503=${only503}`, async () => {
    const reporter = new SalesReporter();
    const selectedTitles = salesCases
      .flatMap(salesCaseTestTitles)
      .filter((title) => !only503 || !/\((500|502)\)$/.test(title));
    reporter.selected = new Set(selectedTitles);
    for (const title of selectedTitles) {
      reporter.onTestEnd(
        {
          title,
          annotations: [
            { type: "case-status", description: "passed" },
            {
              type: "after",
              description: "停止確認・今回のデータのみ削除・所有行の残存なし",
            },
          ],
        } as any,
        { status: "passed" } as any,
      );
    }
    const dir = `.local/sales-learning-evidence/${reporter.runId}`;
    try {
      const result = await reporter.onEnd({ status: "passed" } as any);
      const summary = JSON.parse(readFileSync(`${dir}/summary.json`, "utf8"));
      assert.equal(result, undefined, "選択したテスト自体は成功として扱う");
      assert.equal(summary.executionScope.selectedIds.length, 7);
      assert.equal(summary.executionScope.allSevenSelected, !only503);
      assert.equal(summary.caseStatus, only503 ? "incomplete" : "passed");
      for (const caseId of ["UI-02", "BATCH-02"]) {
        const ui = summary.cases.find((c: any) => c.id === caseId);
        assert.equal(ui.executions.length, 3);
        assert.deepEqual(
          ui.executions.map((e: any) => e.selected),
          only503 ? [false, false, true] : [true, true, true],
        );
        assert.deepEqual(
          ui.executions.map((e: any) => e.caseStatus),
          only503
            ? ["not-run", "not-run", "passed"]
            : ["passed", "passed", "passed"],
        );
        assert.deepEqual(
          ui.executions.map((e: any) => e.afterStatus),
          only503
            ? ["not-run", "not-run", "confirmed"]
            : ["confirmed", "confirmed", "confirmed"],
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
