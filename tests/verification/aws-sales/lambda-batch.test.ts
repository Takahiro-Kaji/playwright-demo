import { test } from "node:test";
import { strict as a } from "node:assert";
import { readFile, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BatchRunner } from "../../aws-sales/batch/runner.ts";
import { BatchResult } from "../../aws-sales/batch/result.ts";

const config = {
  functionName: "sales-sync:test",
  region: "ap-northeast-1",
  profile: "sales-test",
};

for (const mode of [
  "complete",
  "function-error",
  "api-error",
  "invalid-json",
  "connection-error",
] as const) {
  test(`Lambda同期呼び出し: ${mode}`, async () => {
    let directory = "";
    let response = "";
    const runner = new BatchRunner(
      config,
      async (binary, args, input, timeout) => {
        a.equal(binary, "aws");
        a.equal(input, undefined);
        a.ok(timeout! > 900_000);
        const option = (key: string) => args[args.indexOf(key) + 1];
        a.equal(option("--invocation-type"), "RequestResponse");
        a.equal(option("--function-name"), config.functionName);
        a.equal(option("--profile"), config.profile);
        a.equal(option("--region"), config.region);
        const request = option("--payload").replace("fileb://", "");
        directory = dirname(request);
        response = args.at(-1)!;
        a.deepEqual(JSON.parse(await readFile(request, "utf8")), {
          fixture: "f1",
        });
        if (mode === "connection-error") throw Error("COMMAND_FAILED");
        await writeFile(
          response,
          mode === "invalid-json"
            ? "invalid"
            : JSON.stringify(
                mode === "function-error"
                  ? {
                      errorType: "UpstreamUnavailable",
                      errorMessage: "HTTP 503",
                    }
                  : { synced: 3 },
              ),
        );
        return JSON.stringify({
          StatusCode: mode === "api-error" ? 202 : 200,
          ...(mode === "function-error" ? { FunctionError: "Unhandled" } : {}),
        });
      },
    );
    if (mode === "api-error") {
      await a.rejects(runner.run({ fixture: "f1" }), /LAMBDA_INVOKE_FAILED/);
    } else if (mode === "invalid-json") {
      await a.rejects(runner.run({ fixture: "f1" }), SyntaxError);
    } else if (mode === "connection-error") {
      await a.rejects(runner.run({ fixture: "f1" }), /COMMAND_FAILED/);
    } else {
      const result = await runner.run({ fixture: "f1" });
      a.equal(result.outcome, mode);
      if (mode === "complete") {
        result.requireComplete();
        a.deepEqual(result.payload, { synced: 3 });
        a.throws(() => result.requireExpectedError("UpstreamUnavailable"));
      } else {
        result.requireExpectedError("UpstreamUnavailable");
        a.throws(() => result.requireComplete());
      }
    }
    a.ok(directory);
    await a.rejects(access(directory), { code: "ENOENT" });
    await a.rejects(access(response), { code: "ENOENT" });
  });
}

test("期待する業務エラーと、タイムアウト・実行時エラーを区別する", () => {
  for (const payload of [
    null,
    {},
    { errorType: "Sandbox.Timedout" },
    { errorType: "Runtime.ExitError" },
  ]) {
    const result = new BatchResult(payload, "Unhandled");
    a.throws(() => result.requireExpectedError("UpstreamUnavailable"));
  }
  a.throws(() => new BatchResult({}, "Unhandled").requireExpectedError(""));
});

test("FunctionErrorがなくても、戻り値の業務結果は呼び出し側で確認する", () => {
  const result = new BatchResult({ statusCode: 500 });
  result.requireComplete();
  a.deepEqual(result.payload, { statusCode: 500 });
});

test("JSONで表せない入力では呼び出さない", async () => {
  const runner = new BatchRunner(config, async () => {
    a.fail("AWS must not be invoked");
  });
  await a.rejects(
    runner.run(() => {}),
    /LAMBDA_INPUT_MUST_BE_JSON/,
  );
});
