import type {
  Reporter,
  FullConfig,
  Suite,
  TestCase,
  TestResult,
  FullResult,
} from "@playwright/test/reporter";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
export const ids = [
  "UI-01",
  "UI-02",
  "BATCH-01",
  "BATCH-02",
  "CROSS-01",
  "CROSS-02",
  "CROSS-03",
];
export default class AwsReporter implements Reporter {
  selected = new Set<string>();
  results = new Map<string, { verdict: string; after: string }>();
  onBegin(_c: FullConfig, s: Suite) {
    this.selected = new Set(s.allTests().map((t) => t.title.split(" ")[0]));
  }
  onTestEnd(t: TestCase, r: TestResult) {
    const id = t.title.split(" ")[0];
    const verdict =
      t.annotations.find((a) => a.type === "business")?.description ||
      "not-run";
    const after =
      t.annotations.find((a) => a.type === "after")?.description || "unknown";
    this.results.set(id, { verdict, after });
    const annotated = t.annotations.find(
      (a) => a.type === "safe-codes",
    )?.description;
    const message = r.error?.message || "";
    const fallback = message.match(/^(?:Error: )?([A-Z][A-Z0-9_]+)$/)?.[1];
    const codes =
      annotated && /^[A-Z0-9_,]+$/.test(annotated)
        ? annotated
        : fallback || (r.status !== "passed" ? "EXECUTION_FAILED" : "");
    process.stdout.write(
      `${id}: business=${verdict} after=${after} execution=${r.status} codes=${codes}\n`,
    );
  }
  async onEnd(r: FullResult) {
    const cases = ids.map((id) => ({
      id,
      selected: this.selected.has(id),
      ...(this.results.get(id) || { verdict: "not-run", after: "not-run" }),
    }));
    const passed = (c: (typeof cases)[number]) =>
      c.verdict === "passed" && c.after === "confirmed";
    const allSevenPassed = cases.every((c) => c.selected && passed(c));
    const selectedPassed =
      cases.filter((c) => c.selected).every(passed) && this.selected.size > 0;
    const dir = ".local/aws-sales-evidence";
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = `${dir}/${randomUUID()}.json`;
    writeFileSync(
      path,
      JSON.stringify({
        allSevenPassed,
        selectedPassed,
        cases,
        execution: r.status,
      }),
      { flag: "wx", mode: 0o600 },
    );
    process.stdout.write(`AWS試験要約: ${path}\n`);
    // Playwright自身の失敗・タイムアウト・中断の状態を維持する。
    if (!selectedPassed && r.status === "passed")
      return { status: "failed" as const };
  }
  // フレームワークの例外や添付情報には、URLやレスポンス本文が含まれ得る。
  onError() {
    process.stderr.write("AWS_TEST_RUNNER_FAILED\n");
  }
  onStdOut() {}
  onStdErr() {}
}
