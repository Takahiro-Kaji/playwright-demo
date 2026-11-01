import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./fixtures.ts";
import { ids } from "../../aws-sales/reporter.ts";

for (const config of ["aws-sales", "local"]) {
  test(`${config}: actual entrypoint lists scenarios in execution order`, () => {
    const result = spawnSync(
      process.execPath,
      [
        "node_modules/@playwright/test/cli.js",
        "test",
        "-c",
        `tests/aws-sales/${config}.config.ts`,
        "--list",
      ],
      { encoding: "utf8", timeout: 45000 },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(
      [...result.stdout.matchAll(/(?:UI|BATCH|CROSS)-\d\d/g)].map((m) => m[0]),
      ids,
    );
  });
}

for (const mode of ["aws", "local"]) {
  for (const scenario of ["unconfirmed", "failure", "after", "passed"]) {
    test(`${mode}: ${scenario} respects order, cleanup, and run verdict`, () => {
      const f = fixture();
      f.j.phase = "prepared";
      writeFileSync(f.file, JSON.stringify(f.j));
      const marker = join(f.dir, "marker");
      let evidence: string | undefined;
      try {
        const result = spawnSync(
          process.execPath,
          [
            "node_modules/@playwright/test/cli.js",
            "test",
            "-c",
            "tests/verification/aws-sales/sequence.config.ts",
          ],
          {
            env: {
              ...process.env,
              AWS_SALES_JOURNAL: f.file,
              SEQUENCE_MARKER: marker,
              SEQUENCE_MODE: mode,
              SEQUENCE_CASE: scenario,
            },
            encoding: "utf8",
            timeout: 45000,
          },
        );
        assert.equal(
          result.status,
          scenario === "passed" ? 0 : 1,
          result.stdout + result.stderr,
        );
        const expected =
          scenario === "failure" || scenario === "after"
            ? ids.slice(0, 5)
            : ids;
        assert.deepEqual(
          readFileSync(marker, "utf8").trim().split("\n"),
          expected,
        );
        const journal = JSON.parse(readFileSync(f.file, "utf8"));
        assert.deepEqual(
          journal.results.map((r: any) => r.id),
          expected,
        );
        assert.equal(
          journal.results[4].verdict,
          scenario === "failure"
            ? "failed"
            : scenario === "passed"
              ? "passed"
              : "unconfirmed",
        );
        assert.equal(
          journal.results[4].after,
          scenario === "after" ? "failed" : "confirmed",
        );
        assert.equal(journal.blocked, scenario === "after");
        if (scenario === "after")
          assert.ok(
            journal.results[4].codes.includes("INJECTED_RESTORE_FAILURE"),
          );
        evidence = result.stdout.match(/AWS試験要約: (\S+)/)?.[1];
        assert.ok(evidence, result.stdout + result.stderr);
        const summary = JSON.parse(readFileSync(evidence, "utf8"));
        assert.equal(summary.selectedPassed, scenario === "passed");
        assert.equal(summary.allSevenPassed, scenario === "passed");
        assert.equal(summary.cases[4].verdict, journal.results[4].verdict);
        assert.equal(summary.cases[4].after, journal.results[4].after);
        assert.equal(
          summary.execution,
          scenario === "failure" || scenario === "after" ? "failed" : "passed",
        );
        if (scenario === "unconfirmed")
          assert.match(
            result.stdout,
            /CROSS-01: business=unconfirmed after=confirmed execution=skipped/,
          );
      } finally {
        if (evidence && existsSync(evidence)) rmSync(evidence);
        f.close();
      }
    });
  }
}
