import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";

test("default Playwright discovery lists seven sales scenarios with three UI error variants", () => {
  const result = spawnSync(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test", "--list"],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Total: 9 tests in 3 files/);
  assert.doesNotMatch(
    result.stdout,
    /old\/aws-demo|create-item\.integration\.spec/,
  );
  assert.doesNotMatch(result.stdout, /安全な実行要約/);
});

test("VS Code extension configuration glob matches only the standard sales entry", async () => {
  const { readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const matches: string[] = [];
  function walk(dir: string) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.isDirectory()) {
        if (!["node_modules", ".git", ".local"].includes(item.name))
          walk(join(dir, item.name));
      } else if (/playwright.*\.config\.(ts|js|mts|mjs)$/i.test(item.name)) {
        matches.push(join(dir, item.name));
      }
    }
  }
  walk(".");
  assert.deepEqual(matches, ["playwright.config.ts"]);
});
