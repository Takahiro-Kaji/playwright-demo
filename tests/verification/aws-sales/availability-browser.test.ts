import { test } from "node:test";
import { strict as a } from "node:assert";
import { createServer } from "node:http";
import { chromium, type Browser } from "@playwright/test";
import { page as html, script } from "../../../demo/sales/server.ts";
import { readResponseJson } from "../../aws-sales/response-body.ts";

test("Chrome completes the actual availability request and compares its body before displaying success", async () => {
  let status = 200,
    body: unknown = { available: true },
    requests = 0;
  const server = createServer((req, res) => {
    if (req.url === "/") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(html);
    }
    if (req.url === "/app.js") {
      res.setHeader("content-type", "text/javascript");
      return res.end(script);
    }
    if (req.url !== "/api/availability") {
      res.writeHead(404);
      return res.end();
    }
    requests++;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ serviceWorkers: "block" });
    await page.goto(
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    );
    for (const [code, json, text] of [
      [200, { available: true }, "接続可能"],
      [502, { error: "UPSTREAM_UNAVAILABLE" }, "外部システムエラー"],
      [200, { available: false }, "外部システムエラー"],
    ] as const) {
      status = code;
      body = json;
      await page.locator("#availability-result").evaluate((node) => {
        node.textContent = "";
      });
      const pending = page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/availability",
      );
      await page.locator("#availability").click();
      const response = await pending;
      a.equal(response.status(), code);
      a.deepEqual(await readResponseJson(response, 2000), json);
      await page
        .locator("#availability-result")
        .filter({ hasText: text })
        .waitFor();
      a.equal(await page.locator("#availability-result").textContent(), text);
    }
    a.equal(requests, 3); // One click means one request, including errors.
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await browser?.close();
  }
});
