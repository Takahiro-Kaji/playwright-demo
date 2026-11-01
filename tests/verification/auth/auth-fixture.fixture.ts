import { writeFile } from "node:fs/promises";
import {
  test as authTest,
  expect,
} from "../../../test-support/auth/fixture.ts";

const test = authTest.extend({
  context: async ({ context }, use) => {
    await context.route("https://example.test/**", async (route) => {
      const cookies = route.request().headers().cookie ?? "";
      const authenticated =
        cookies.includes("session=fixture") &&
        process.env.AUTH_TEST_EXPIRED !== "1";
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: authenticated
          ? '<div id="signed-in">ok</div>'
          : '<div id="login">login</div>',
      });
    });
    await use(context);
  },
});

test("business action runs only after authenticated state is loaded", async ({
  page,
}) => {
  await writeFile(process.env.AUTH_TEST_MARKER!, "started");
  await page.goto("https://example.test/app");
  await expect(page.locator("#signed-in")).toBeVisible();
});
