import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-raw-resize-observer");

describe("t3code/no-raw-resize-observer", () => {
  rule.valid(
    "allows observeResize, other observers and keys that name no ResizeObserver",
    `
      const stop = observeResize(element, onResize);
      new IntersectionObserver(onVisible);
      new window.MutationObserver(onChange);
      new custom.ResizeObserver(onResize);
      const name = "MutationObserver";
      new window[name](onChange);
      new globalThis[observerName()](onResize);
    `,
  );

  rule.invalid(
    "reports ResizeObserver built directly or through a global object",
    `
      new ResizeObserver(onResize);
      new window.ResizeObserver(onResize);
      new globalThis["ResizeObserver"](onResize);
    `,
    (output) => {
      assert.match(output, /Use observeResize/);
      assert.equal(output.match(/no-raw-resize-observer/g)?.length, 3);
    },
  );

  rule.invalid(
    "reports ResizeObserver a const key names on a global object",
    `
      const name = "ResizeObserver";
      new self[name](onResize);
    `,
  );
});
