import { test } from "node:test";
import { strict as a } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { newJournal } from "../../aws-sales/environment.ts";
test("body deadline and After failure preserve verdicts and stop subsequent cases", () => {
  mkdirSync(".local/aws-sales-qa", { recursive: true });
  const dir = mkdtempSync(resolve(".local/aws-sales-qa/fail-stop-"));
  try {
    for (const body of ["0", "1", "timeout"]) {
      const state = ".local/auth/aws-fail-stop.json";
      mkdirSync(".local/auth", { recursive: true });
      writeFileSync(state, JSON.stringify({ cookies: [], origins: [] }), {
        mode: 0o600,
      });
      const ca = join(dir, "ca");
      writeFileSync(ca, "test");
      const j = newJournal({
        account: "123456789012",
        region: "ap-northeast-1",
        profile: "test",
        context: "test",
        cluster: "test",
        image: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/test:v1",
        dbHost: "db.region.rds.amazonaws.com",
        caFile: ca,
        url: "https://test.example.com/",
        stateFile: state,
        certificateArn:
          "arn:aws:acm:ap-northeast-1:123456789012:certificate/test",
        operatorCidr: "192.0.2.1/32",
        userPoolArn:
          "arn:aws:cognito-idp:ap-northeast-1:123456789012:userpool/test",
        userPoolClientId: "test",
        userPoolDomain: "test",
      });
      j.phase = "prepared";
      const file = join(dir, `run-${body}.json`),
        marker = join(dir, `marker-${body}`);
      writeFileSync(file, JSON.stringify(j), { mode: 0o600 });
      const r = spawnSync(
        process.execPath,
        [
          "node_modules/@playwright/test/cli.js",
          "test",
          "-c",
          "tests/verification/aws-sales/fail-stop.config.ts",
        ],
        {
          env: {
            ...process.env,
            AWS_SALES_JOURNAL: file,
            STOP_MARKER: marker,
            INJECT_BODY: body,
          },
          encoding: "utf8",
          timeout: 45000,
        },
      );
      a.equal(r.status, 1, r.stdout + r.stderr);
      a.equal(existsSync(marker), false);
      const result = JSON.parse(readFileSync(file, "utf8"));
      a.equal(result.blocked, body !== "timeout");
      a.equal(result.results.length, 1);
      a.equal(result.results[0].verdict, body === "0" ? "passed" : "failed");
      a.equal(
        result.results[0].after,
        body === "timeout" ? "confirmed" : "failed",
      );
      if (body === "timeout")
        a.deepEqual(result.results[0].codes, ["HTTP_RESPONSE_FINISH_TIMEOUT"]);
      else a.ok(result.results[0].codes.includes("INJECTED_RESTORE_FAILURE"));
      if (body === "1")
        a.ok(result.results[0].codes.includes("INJECTED_BODY_FAILURE"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
