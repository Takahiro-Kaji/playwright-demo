import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("After失敗は後続を停止し本体とAfterの判定を分離", () => {
  const dir = mkdtempSync(join(tmpdir(), "sales-halt-"));
  const marker = join(dir, "marker");
  try {
    for (const failBusiness of [true, false, "skip"] as const) {
      const result = spawnSync(
        process.execPath,
        [
          "node_modules/@playwright/test/cli.js",
          "test",
          "-c",
          "tests/verification/support/fail-stop.config.ts",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            SALES_HALT_MARKER: marker,
            SALES_BUSINESS_FAILURE:
              failBusiness === "skip" ? "skip" : failBusiness ? "1" : "0",
          },
          timeout: 30000,
        },
      );
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(marker), false);
      const match = result.stdout.match(
        /(\.local\/sales-learning-evidence\/[^\s]+\/summary\.json)/,
      );
      assert.ok(match, result.stdout + result.stderr);
      const summary = JSON.parse(readFileSync(match[1], "utf8"));
      assert.equal(summary.cases.length, 7);
      assert.equal(summary.executionScope.allSevenSelected, false);
      assert.deepEqual(summary.executionScope.selectedIds, ["UI-01", "UI-02"]);
      const first = summary.cases.find((c: any) => c.id === "UI-01");
      const next = summary.cases.find((c: any) => c.id === "UI-02");
      assert.equal(
        first.caseStatus,
        failBusiness === "skip"
          ? "unknown"
          : failBusiness
            ? "failed"
            : "passed",
      );
      assert.equal(first.afterStatus, "failed");
      assert.equal(next.caseStatus, "not-run");
      assert.equal(
        summary.caseStatus,
        failBusiness === true ? "failed" : "incomplete",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
