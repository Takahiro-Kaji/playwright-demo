import { test } from "node:test";
import { strict as a } from "node:assert";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./fixtures.ts";
test("両バッチ環境は認証状態ファイルとブラウザーなしで対象の照合を維持する", () => {
  const f = fixture();
  f.j.phase = "prepared";
  f.j.config.stateFile = ".local/auth/does-not-exist-" + f.j.runId + ".json";
  writeFileSync(f.file, JSON.stringify(f.j), { mode: 0o600 });
  const browser = join(f.dir, "browser"),
    target = join(f.dir, "target");
  try {
    const r = spawnSync(
      process.execPath,
      [
        "node_modules/@playwright/test/cli.js",
        "test",
        "-c",
        "tests/verification/aws-sales/batch-fixture.config.ts",
      ],
      {
        env: {
          ...process.env,
          AWS_SALES_JOURNAL: f.file,
          BROWSER_MARKER: browser,
          TARGET_MARKER: target,
        },
        encoding: "utf8",
        timeout: 45000,
      },
    );
    a.equal(r.status, 0, r.stdout + r.stderr);
    a.equal(existsSync(browser), false);
    a.equal(existsSync(target), true);
    a.equal(existsSync(f.j.config.stateFile), false);
    const j = JSON.parse(readFileSync(f.file, "utf8"));
    a.deepEqual(
      j.results.map((r: any) => [r.id, r.verdict, r.after]),
      [
        ["BATCH-01", "passed", "confirmed"],
        ["BATCH-02", "passed", "confirmed"],
      ],
    );
  } finally {
    f.close();
  }
});
