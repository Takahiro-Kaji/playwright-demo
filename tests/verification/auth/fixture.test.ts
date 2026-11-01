import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { authSettings } from "../../../test-support/auth/fixture.ts";

test("SSO settings activate automatically and require complete valid configuration", () => {
  assert.equal(authSettings({}), undefined);
  assert.equal(
    authSettings({ SALES_AUTH_ENABLED: "0", SALES_AUTH_STATE: "x" }),
    undefined,
  );
  assert.throws(
    () => authSettings({ SALES_AUTH_STATE: ".local/auth/user.json" }),
    /AUTH_CONFIG_REQUIRED/,
  );
  assert.throws(
    () => authSettings({ SALES_AUTH_ENABLED: "yes" }),
    /AUTH_ENABLED_INVALID/,
  );
  assert.throws(
    () => authSettings({ SALES_AUTH_ENABLED: "1" }),
    /AUTH_CONFIG_REQUIRED/,
  );
  assert.throws(
    () =>
      authSettings({
        SALES_AUTH_ENABLED: "1",
        SALES_AUTH_STATE: "/tmp/s.json",
        SALES_AUTH_URL: "https://example.test/",
        SALES_AUTH_SUCCESS_URL: "https://example.test/",
        SALES_AUTH_SUCCESS_SELECTOR: "#ok",
      }),
    /AUTH_PATH_REQUIRED/,
  );
});

test("real application template refuses to run without authentication", () => {
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      "-c",
      "tests/real-app/real-app.config.ts",
    ],
    {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, SALES_AUTH_ENABLED: "0" },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /REAL_APP_AUTH_REQUIRED/);
});

test("SSO fixture loads cookies and blocks business actions for expired or missing state", () => {
  mkdirSync(".local/auth", { recursive: true });
  const dir = mkdtempSync(resolve(".local/auth/fixture-test-"));
  const state = join(dir, "state.json"),
    marker = join(dir, "marker");
  const { SALES_AUTH_ENABLED: _enabled, ...inherited } = process.env;
  try {
    writeFileSync(
      state,
      JSON.stringify({
        cookies: [
          {
            name: "session",
            value: "fixture",
            domain: "example.test",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ],
        origins: [],
      }),
    );
    for (const mode of ["valid", "expired", "missing"]) {
      const result = spawnSync(
        process.execPath,
        [
          "node_modules/@playwright/test/cli.js",
          "test",
          "-c",
          "tests/verification/auth/auth-fixture.config.ts",
        ],
        {
          encoding: "utf8",
          timeout: 45000,
          env: {
            ...inherited,
            SALES_AUTH_STATE:
              mode === "missing" ? join(dir, "missing.json") : state,
            SALES_AUTH_URL: "https://example.test/app",
            SALES_AUTH_SUCCESS_URL: "https://example.test/app",
            SALES_AUTH_SUCCESS_SELECTOR: "#signed-in",
            AUTH_TEST_EXPIRED: mode === "expired" ? "1" : "0",
            AUTH_TEST_MARKER: marker,
          },
        },
      );
      if (mode === "valid") {
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(existsSync(marker), true);
        rmSync(marker);
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(existsSync(marker), false);
        assert.match(
          result.stdout + result.stderr,
          mode === "missing"
            ? /AUTH_STATE_UNAVAILABLE/
            : /AUTH_PREREQUISITE_FAILED/,
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
