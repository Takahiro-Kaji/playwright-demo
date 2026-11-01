import { test } from "node:test";
import { strict as a } from "node:assert";
import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture } from "./fixtures.ts";
for (const mode of ["missing", "expired"])
  test(`UI環境は対象の更新前に認証状態 ${mode} を拒否する`, () => {
    const f = fixture(),
      target = join(f.dir, "target");
    f.j.phase = "prepared";
    f.j.config.stateFile = resolve(`.local/auth/verify-ui-${f.j.runId}.json`);
    if (mode === "expired")
      writeFileSync(
        f.j.config.stateFile,
        JSON.stringify({ cookies: [], origins: [] }),
        { mode: 0o600 },
      );
    writeFileSync(f.file, JSON.stringify(f.j), { mode: 0o600 });
    try {
      const r = spawnSync(
        process.execPath,
        [
          "node_modules/@playwright/test/cli.js",
          "test",
          "-c",
          "tests/verification/aws-sales/fail-stop.config.ts",
          "--grep",
          "UI-01",
        ],
        {
          env: {
            ...process.env,
            AWS_SALES_JOURNAL: f.file,
            TARGET_MARKER: target,
            UI_AUTH_MODE: mode,
          },
          encoding: "utf8",
          timeout: 45000,
        },
      );
      a.equal(r.status, 1, r.stdout + r.stderr);
      a.match(
        r.stdout + r.stderr,
        mode === "missing"
          ? /AUTH_STATE_UNAVAILABLE/
          : /AUTH_PREREQUISITE_FAILED/,
      );
      a.equal(existsSync(target), false);
    } finally {
      if (mode === "expired") rmSync(f.j.config.stateFile);
      f.close();
    }
  });
