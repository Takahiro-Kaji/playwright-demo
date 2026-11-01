import { test } from "node:test";
import { strict as assert } from "node:assert";
import { validateAuthConfig } from "../../../test-support/auth/setup.ts";
test("認証状態はローカルに保存しURLに秘密情報を含めない", () => {
  assert.ok(
    validateAuthConfig(
      ".local/auth/user.json",
      "https://example.test/app",
    ).path.endsWith("user.json"),
  );
  assert.throws(() =>
    validateAuthConfig("/tmp/user.json", "https://example.test"),
  );
  assert.throws(() =>
    validateAuthConfig(
      ".local/auth/user.json",
      "https://example.test/?token=secret",
    ),
  );
  assert.throws(() =>
    validateAuthConfig(".local/auth/user.json", "http://example.test"),
  );
});
