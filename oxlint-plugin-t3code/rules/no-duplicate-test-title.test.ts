import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-duplicate-test-title", {
  filename: "fixture.test.ts",
});

describe("t3code/no-duplicate-test-title", () => {
  rule.valid(
    "allows the same title in different describe blocks and distinct titles",
    `
      import { describe, it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      describe("a", () => {
        it.effect("cancels", () => Effect.void);
        it("other", () => {});
      });
      describe("b", () => {
        it.effect("cancels", () => Effect.void);
      });
    `,
  );

  rule.valid(
    "allows the same title in different named layer blocks",
    `
      import { it, it as effectIt, layer, layer as effectLayer } from "@effect/vitest";
      import * as Effect from "effect/Effect";
      import * as Layer from "effect/Layer";

      it.layer(Layer.empty)("on version 1", (it) => {
        it.effect("lists models", () => Effect.void);
      });
      layer(Layer.empty)("on version 2", (it) => {
        it.effect("lists models", () => Effect.void);
      });
      effectIt.layer(Layer.empty)("on version 3", (it) => {
        it.effect("lists models", () => Effect.void);
      });
      effectLayer(Layer.empty)("on version 4", (it) => {
        it.effect("lists models", () => Effect.void);
      });
    `,
  );

  rule.invalid(
    "reports a title a local layer helper repeats, since it opens no describe block",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      const layer = (_layer: unknown) => (_name: string, body: (it: unknown) => void) => body(it);
      it.effect("lists models", () => Effect.void);
      layer(undefined)("on version 1", (it) => {
        it.effect("lists models", () => Effect.void);
      });
    `,
  );

  rule.invalid(
    "reports a title an aliased it repeats",
    `
      import { it as effectIt } from "@effect/vitest";
      import { it } from "vitest";
      import * as Effect from "effect/Effect";

      it("lists models", () => {});
      effectIt.effect("lists models", () => Effect.void);
    `,
  );

  rule.valid(
    "ignores a parameter that shadows an imported it alias",
    `
      import { it as effectIt } from "@effect/vitest";

      const rows = (effectIt: (name: string) => void) => {
        effectIt("row");
        effectIt("row");
      };
    `,
  );

  rule.invalid(
    "reports a title repeated across calls of a parameter that shadows the imported layer",
    `
      import { it, layer } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      const run = (layer: (_layer: unknown) => (_name: string, body: () => void) => void) => {
        layer(undefined)("on version 1", () => {
          it.effect("lists models", () => Effect.void);
        });
        layer(undefined)("on version 2", () => {
          it.effect("lists models", () => Effect.void);
        });
      };
    `,
  );

  rule.invalid(
    "reports a title an unnamed layer block repeats from the enclosing scope",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";
      import * as Layer from "effect/Layer";

      it.effect("lists models", () => Effect.void);
      it.layer(Layer.empty)((it) => {
        it.effect("lists models", () => Effect.void);
      });
    `,
  );

  rule.valid(
    "ignores dynamic titles and .each cases",
    `
      import { it } from "@effect/vitest";

      it(\`handles \${1}\`, () => {});
      it(\`handles \${2}\`, () => {});
      it.each([1, 2])("same", () => {});
      it.each([3, 4])("same", () => {});
    `,
  );

  rule.invalid(
    "reports two it.effect tests with one title at the top level",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      it.effect("cancels a stalled registration", () => Effect.void);
      it.effect("cancels a stalled registration", () => Effect.void);
    `,
    (output) => {
      assert.equal(output.match(/no-duplicate-test-title/g)?.length, 1);
    },
  );

  rule.invalid(
    "reports a plain it and an it.live that share a title in one describe",
    `
      import { describe, it } from "@effect/vitest";

      describe("a", () => {
        it("same", () => {});
        it.live("same", () => {});
      });
    `,
  );

  rule.valid(
    "allows describe blocks that share a title",
    `
      import { describe } from "vitest";

      describe("same", () => {});
      describe("same", () => {});
    `,
  );
});

const productionRule = createOxlintRuleHarness("t3code/no-duplicate-test-title");

productionRule.valid(
  "ignores non-test files",
  `
    const it = (_name: string) => {};
    it("same");
    it("same");
  `,
);
