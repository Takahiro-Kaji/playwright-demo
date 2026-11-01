import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  startJob,
  waitJob,
  stopJob,
  type Runner,
} from "../../../test-support/kubernetes.ts";
const target = { context: "dev-context", namespace: "demo", job: "run-1" };
test("安全な引数配列と完了・失敗・停止確認を検証する", async () => {
  const calls: string[][] = [];
  let result = "Complete";
  const run: Runner = async (a) => {
    calls.push(a);
    return {
      code: 0,
      stderr: "",
      stdout: a.includes("json")
        ? JSON.stringify({
            status: { conditions: [{ type: result, status: "True" }] },
          })
        : "",
    };
  };
  await startJob(target, "sync", run);
  assert.deepEqual(calls[0], [
    "--context",
    "dev-context",
    "--namespace",
    "demo",
    "create",
    "job",
    "run-1",
    "--from=cronjob/sync",
  ]);
  assert.equal(await waitJob(target, run, 1000), "complete");
  result = "Failed";
  assert.equal(await waitJob(target, run, 1000), "failed");
  await stopJob(target, run, 1000);
  assert.rejects(() => startJob({ ...target, namespace: "-bad" }, "sync", run));
});
test("停止未確認を成功にしない", async () => {
  const run: Runner = async (a) => ({
    code: 0,
    stderr: "",
    stdout: a.includes("get") ? "job/run-1" : "",
  });
  await assert.rejects(() => stopJob(target, run, 1000), /UNCONFIRMED/);
});

test("模擬CLIにシェル解釈なしで引数を渡す", async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { makeRunner } = await import("../../../test-support/kubernetes.ts");
  const dir = mkdtempSync(join(tmpdir(), "fake-kubectl-"));
  try {
    const file = join(dir, "kubectl");
    writeFileSync(
      file,
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n",
    );
    chmodSync(file, 0o700);
    const r = await makeRunner(file)(
      ["--context", "dev", "get", "job", "demo"],
      3000,
    );
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), [
      "--context",
      "dev",
      "get",
      "job",
      "demo",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
