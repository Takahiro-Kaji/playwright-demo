/** 7ケースの業務判定と後片付けを別々に集計する。型、開始・終了時の処理、全体集計の順に読む。 */
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
import { salesCases, salesCaseTestTitles } from "../test-support/cases.ts";
type CaseResult = {
  id: string;
  title: string;
  selected: boolean;
  caseStatus: string;
  afterStatus: string;
  afterDetail: string;
  observationEvidence?: string;
  executions?: CaseResult[];
};
export default class SalesReporter implements Reporter {
  readonly runId = randomUUID();
  private readonly listing = process.argv.includes("--list");
  selected = new Set<string>();
  results = new Map<string, CaseResult>();
  /** 実行対象suiteから選択されたケースを記録する。_configは設定、戻り値なし。書込み失敗は例外。 */
  onBegin(_config: FullConfig, suite: Suite) {
    if (this.listing) return;
    mkdirSync(".local/sales-learning-evidence", { recursive: true });
    this.selected = new Set(suite.allTests().map((t) => t.title));
  }
  /** testとresultから業務判定とAfterを分けて保存する。戻り値なし。通常は例外を送出しない。 */
  onTestEnd(test: TestCase, result: TestResult) {
    const item = salesCases.find(
      (c) => c.title === test.title || test.title.startsWith(c.title + " ("),
    );
    if (!item) return;
    const detail =
      test.annotations.find((a) => a.type === "after")?.description ?? "未確認";
    const prior = test.annotations.find(
      (a) => a.type === "case-status",
    )?.description;
    const afterStatus =
      detail === "停止確認・今回のデータのみ削除・所有行の残存なし"
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
    this.results.set(test.title === item.title ? item.id : test.title, {
      ...item,
      title: test.title,
      selected: true,
      caseStatus,
      afterStatus,
      afterDetail: detail,
      observationEvidence: test.annotations.find(
        (a) => a.type === "observation-evidence",
      )?.description,
    });
  }
  /** 全ケースを集計し証跡を書く。resultはPlaywright全体結果。必要なら失敗statusを返す。書込み失敗は例外。 */
  async onEnd(result: FullResult) {
    if (this.listing) return;
    const cases = salesCases.map((c): CaseResult => {
      const titles = salesCaseTestTitles(c);
      const executions = titles.map(
        (title): CaseResult =>
          this.results.get(title === c.title ? c.id : title) ?? {
            ...c,
            title,
            selected: this.selected.has(title),
            caseStatus: "not-run",
            afterStatus: "not-run",
            afterDetail: "未実施",
          },
      );
      if (executions.length === 1 && titles[0] === c.title)
        return executions[0];
      if (!executions.length)
        return {
          ...c,
          selected: false,
          caseStatus: "not-run",
          afterStatus: "not-run",
          afterDetail: "未実施",
        };
      // パラメータの一部が失敗・未実施でも、最後の成功で上書きしない。
      return {
        ...c,
        selected:
          this.selected.has(c.title) || executions.some((e) => e.selected),
        caseStatus: executions.every((e) => e.caseStatus === "not-run")
          ? "not-run"
          : executions.some((e) => e.caseStatus === "failed")
            ? "failed"
            : executions.every((e) => e.caseStatus === "passed")
              ? "passed"
              : "unknown",
        afterStatus: executions.every((e) => e.afterStatus === "not-run")
          ? "not-run"
          : executions.some((e) => e.afterStatus === "failed")
            ? "failed"
            : executions.every((e) => e.afterStatus === "confirmed")
              ? "confirmed"
              : "unknown",
        afterDetail: executions
          .map((e) => `${e.title}: ${e.afterDetail}`)
          .join("; "),
        executions,
      };
    });
    const executionScope = {
      selectedIds: cases.filter((c) => c.selected).map((c) => c.id),
      allSevenSelected: cases.every(
        (c) => c.selected && (c.executions?.every((e) => e.selected) ?? true),
      ),
    };
    // 7件すべてのPASSとAfter確認が揃う場合だけ全体PASS。未実施・未確認はFAILと区別する。
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
    const selectedIncomplete = cases
      .flatMap((c) => c.executions ?? [c])
      .some(
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
