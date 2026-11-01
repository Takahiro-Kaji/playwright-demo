import { test, business } from "./harness.ts";
import { scenarios } from "./scenarios.ts";
for (const scenario of scenarios)
  test(scenario.title, async ({ h }) => business(h, () => scenario.run(h)));
