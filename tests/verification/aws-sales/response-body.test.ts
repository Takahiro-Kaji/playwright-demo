import { test } from "node:test";
import { strict as a } from "node:assert";
import { readResponseJson } from "../../aws-sales/response-body.ts";
import type { Response } from "@playwright/test";

const response = (
  finished: () => Promise<unknown>,
  text: () => Promise<string>,
) => ({ finished, text }) as Response;
const never = () => new Promise<never>(() => {});

test("本文取得の期限判定で完了通知の欠落と取得の停止を区別する", async () => {
  let read = false;
  await a.rejects(
    readResponseJson(
      response(never, async () => {
        read = true;
        return "{}";
      }),
      30,
    ),
    { message: "HTTP_RESPONSE_FINISH_TIMEOUT" },
  );
  a.equal(read, false);
  await a.rejects(
    readResponseJson(
      response(async () => null, never),
      30,
    ),
    {
      message: "HTTP_BODY_READ_TIMEOUT",
    },
  );
});

test("完了通知・本文取得の失敗と不正JSONでは安全なコードだけを保持する", async () => {
  for (const finished of [
    async () => Error("secret"),
    async () => {
      throw Error("secret");
    },
  ])
    await a.rejects(readResponseJson(response(finished, async () => "{}")), {
      message: "HTTP_RESPONSE_FINISH_FAILED",
    });
  await a.rejects(
    readResponseJson(
      response(
        async () => null,
        async () => {
          throw Error("secret");
        },
      ),
    ),
    {
      message: "HTTP_BODY_READ_FAILED",
    },
  );
  await a.rejects(
    readResponseJson(
      response(
        async () => null,
        async () => "<html>secret SSO</html>",
      ),
    ),
    {
      message: "HTTP_BODY_INVALID_JSON",
    },
  );
  a.deepEqual(
    await readResponseJson(
      response(
        async () => null,
        async () => '{"error":"STALE_VERSION"}',
      ),
    ),
    { error: "STALE_VERSION" },
  );
});

test("期限後に応答本文の取得が失敗しても処理する", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<string>((_, no) => {
    reject = no;
  });
  await a.rejects(
    readResponseJson(
      response(
        async () => null,
        () => pending,
      ),
      20,
    ),
    {
      message: "HTTP_BODY_READ_TIMEOUT",
    },
  );
  reject(Error("secret late protocol failure"));
  await new Promise((resolve) => setImmediate(resolve));
});
