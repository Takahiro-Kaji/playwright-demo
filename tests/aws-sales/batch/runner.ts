import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, type Command } from "../environment/cluster.ts";
import { BatchResult } from "./result.ts";

export type BatchConfig = {
  functionName: string;
  region: string;
  profile: string;
};

/** 既存のLambdaをRequestResponseで呼び、処理完了後の結果を返す。 */
export class BatchRunner {
  readonly config: BatchConfig;
  private readonly invoke: Command;

  constructor(config: BatchConfig, invoke: Command = command) {
    this.config = config;
    this.invoke = invoke;
  }

  async run(input: unknown = {}): Promise<BatchResult> {
    const payload = JSON.stringify(input);
    assert.ok(payload !== undefined, "LAMBDA_INPUT_MUST_BE_JSON");
    const directory = await mkdtemp(join(tmpdir(), "sales-lambda-"));
    try {
      const request = join(directory, "request.json");
      const response = join(directory, "response.json");
      await writeFile(request, payload, { mode: 0o600 });
      const metadata = JSON.parse(
        await this.invoke(
          "aws",
          [
            "--profile",
            this.config.profile,
            "--region",
            this.config.region,
            "lambda",
            "invoke",
            "--function-name",
            this.config.functionName,
            "--invocation-type",
            "RequestResponse",
            "--payload",
            `fileb://${request}`,
            "--cli-connect-timeout",
            "10",
            "--cli-read-timeout",
            "910",
            "--output",
            "json",
            "--no-cli-pager",
            response,
          ],
          undefined,
          930_000,
        ),
      );
      // APIの成功（200）と、関数内の処理成功（FunctionErrorなし）は別。
      assert.equal(metadata.StatusCode, 200, "LAMBDA_INVOKE_FAILED");
      assert.ok(
        metadata.FunctionError === undefined ||
          (typeof metadata.FunctionError === "string" &&
            metadata.FunctionError.length > 0),
        "LAMBDA_FUNCTION_ERROR_INVALID",
      );
      return new BatchResult(
        JSON.parse(await readFile(response, "utf8")),
        metadata.FunctionError,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
