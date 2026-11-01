import type {
  Reporter,
  TestCase,
  TestResult,
  FullResult,
} from "@playwright/test/reporter";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

type CaseResult = {
  title: string;
  caseStatus: string;
  afterStatus: string;
  afterDetail: string;
};
export default class SalesReporter implements Reporter {
  readonly runId = randomUUID();
  readonly results: CaseResult[] = [];
  onTestEnd(test: TestCase, result: TestResult) {
    const detail =
      test.annotations.find((a) => a.type === "after")?.description ?? "未確認";
    const afterStatus =
      detail === "停止確認・専用DB削除済み"
        ? "confirmed"
        : detail === "要復旧・DB保持"
          ? "failed"
          : "unknown";
    // A failure in After can mask the business result; do not claim it passed or failed.
    const caseStatus =
      result.status === "failed" && afterStatus !== "confirmed"
        ? "unknown"
        : result.status;
    this.results.push({
      title: test.title,
      caseStatus,
      afterStatus,
      afterDetail: detail,
    });
  }
  onEnd(result: FullResult) {
    const directory = join(".local/sales-learning-evidence", this.runId);
    mkdirSync(directory, { recursive: false });
    const incomplete = this.results.some(
      (r) =>
        ["skipped", "interrupted", "unknown"].includes(r.caseStatus) ||
        r.afterStatus !== "confirmed",
    );
    const caseStatus = this.results.some((r) => r.caseStatus === "failed")
      ? "failed"
      : incomplete
        ? "incomplete"
        : result.status;
    writeFileSync(
      join(directory, "summary.json"),
      JSON.stringify(
        { runId: this.runId, caseStatus, cases: this.results },
        null,
        2,
      ),
      { flag: "wx" },
    );
    process.stdout.write(`安全な実行要約: ${directory}/summary.json\n`);
    if (incomplete) return { status: "failed" as const };
  }
  onBegin() {
    mkdirSync(".local/sales-learning-evidence", { recursive: true });
  }
}
