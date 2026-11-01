import { strict as assert } from "node:assert";

/** Lambdaの同期呼び出し結果。業務データやDB更新内容は呼び出し側で照合する。 */
export class BatchResult {
  readonly payload: unknown;
  readonly functionError?: string;

  constructor(payload: unknown, functionError?: string) {
    this.payload = payload;
    this.functionError = functionError;
  }

  get outcome(): "complete" | "function-error" {
    return this.functionError === undefined ? "complete" : "function-error";
  }

  requireComplete(): void {
    assert.equal(this.outcome, "complete", "LAMBDA_BATCH_FAILED");
  }

  /** 任意の関数エラーを成功扱いせず、期待する例外の種類まで確認する。 */
  requireExpectedError(errorType: string): void {
    assert.ok(errorType.trim(), "EXPECTED_ERROR_TYPE_REQUIRED");
    assert.equal(this.outcome, "function-error", "EXPECTED_LAMBDA_ERROR");
    const payload = this.payload;
    assert.ok(
      payload !== null && typeof payload === "object" && "errorType" in payload,
      "LAMBDA_ERROR_PAYLOAD_INVALID",
    );
    assert.equal(payload.errorType, errorType, "UNEXPECTED_LAMBDA_ERROR_TYPE");
  }
}
