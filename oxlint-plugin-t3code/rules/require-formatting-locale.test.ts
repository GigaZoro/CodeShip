import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/require-formatting-locale", {
  filename: "fixture.tsx",
});

describe("t3code/require-formatting-locale", () => {
  rule.valid("allows toLocaleString with a locale", `count.toLocaleString(getFormattingLocale());`);
  rule.valid(
    "allows an Intl formatter with a locale",
    `new Intl.DateTimeFormat(getFormattingLocale(), { dateStyle: "medium" });`,
  );
  rule.valid("allows a fixed tag", `date.toLocaleString("en-US", { month: "short" });`);
  rule.valid(
    "allows reading the runtime locale",
    `const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;`,
  );
  rule.valid("allows other methods", `value.toString();`);

  rule.invalid("reports toLocaleString()", `count.toLocaleString();`);
  rule.invalid("reports toLocaleDateString()", `date.toLocaleDateString();`);
  rule.invalid(
    "reports an undefined locale",
    `date.toLocaleString(undefined, { hour: "numeric" });`,
  );
  rule.invalid("reports an empty locale list", `date.toLocaleTimeString([], { hour: "numeric" });`);
  rule.invalid("reports Intl.DateTimeFormat without a locale", `new Intl.DateTimeFormat();`);
  rule.invalid(
    "reports Intl.NumberFormat with undefined",
    `new Intl.NumberFormat(undefined, { style: "percent" });`,
  );
});
