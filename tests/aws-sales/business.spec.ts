import { test, uiTest, business } from "./harness.ts";
import { scenarios } from "./scenarios.ts";
for (const scenario of scenarios) {
  if (scenario.kind === "batch")
    test(scenario.title, async ({ h }) => business(h, () => scenario.run(h)));
  else
    uiTest(scenario.title, async ({ uiHarness: h }) =>
      business(h, () => scenario.run(h)),
    );
}
