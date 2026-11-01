import type {
  Reporter,
  TestCase,
  TestResult,
  FullResult,
  FullConfig,
  Suite,
} from "@playwright/test/reporter";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { salesCases } from "../test-support/cases.ts";
type CaseResult = {
  id: string;
  title: string;
  selected: boolean;
  caseStatus: string;
  afterStatus: string;
  afterDetail: string;
};
export default class SalesReporter implements Reporter {
  readonly runId = randomUUID();
  selected = new Set<string>();
  results = new Map<string, CaseResult>();
  onBegin(_config: FullConfig, suite: Suite) {
    mkdirSync(".local/sales-learning-evidence", { recursive: true });
    this.selected = new Set(suite.allTests().map((t) => t.title));
  }
  onTestEnd(test: TestCase, result: TestResult) {
    const item = salesCases.find((c) => c.title === test.title);
    if (!item) return;
    const detail =
      test.annotations.find((a) => a.type === "after")?.description ?? "未確認";
    const prior = test.annotations.find(
      (a) => a.type === "case-status",
    )?.description;
    const afterStatus =
      detail === "停止確認・専用DB削除済み"
        ? "confirmed"
        : detail === "要復旧・DB保持" ||
            (prior !== undefined &&
              result.status === "failed" &&
              detail === "未確認")
          ? "failed"
          : "unknown";
    // Preserve the business verdict separately when cleanup fails.
    const caseStatus =
      (result.status === "skipped" && afterStatus === "unknown"
        ? "not-run"
        : undefined) ??
      prior ??
      (result.status === "failed" && afterStatus !== "confirmed"
        ? "unknown"
        : result.status);
    this.results.set(item.id, {
      ...item,
      selected: true,
      caseStatus,
      afterStatus,
      afterDetail: detail,
    });
  }
  onEnd(result: FullResult) {
    const cases = salesCases.map(
      (c) =>
        this.results.get(c.id) ?? {
          ...c,
          selected: this.selected.has(c.title),
          caseStatus: "not-run",
          afterStatus: "not-run",
          afterDetail: "未実施",
        },
    );
    const executionScope = {
      selectedIds: cases.filter((c) => c.selected).map((c) => c.id),
      allSevenSelected: cases.every((c) => c.selected),
    };
    const caseStatus = cases.some((c) => c.caseStatus === "failed")
      ? "failed"
      : cases.every(
            (c) => c.caseStatus === "passed" && c.afterStatus === "confirmed",
          )
        ? "passed"
        : "incomplete";
    const dir = join(".local/sales-learning-evidence", this.runId);
    mkdirSync(dir, { recursive: false });
    writeFileSync(
      join(dir, "summary.json"),
      JSON.stringify(
        { runId: this.runId, executionScope, caseStatus, cases },
        null,
        2,
      ),
      { flag: "wx" },
    );
    process.stdout.write(`安全な実行要約: ${dir}/summary.json\n`);
    const selectedIncomplete = cases.some(
      (c) =>
        c.selected &&
        (["skipped", "interrupted", "unknown", "not-run"].includes(
          c.caseStatus,
        ) ||
          c.afterStatus !== "confirmed"),
    );
    if (selectedIncomplete || result.status === "failed")
      return { status: "failed" as const };
  }
}
