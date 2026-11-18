import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const RULE = "t3code/no-test-timeout-or-unreasoned-skip";
const rule = createOxlintRuleHarness(RULE, { filename: "fixture.test.ts" });

const assertTimeoutMessage = (output: string) =>
  assert.match(output, /project timeout is the ceiling/);
const assertSkipMessage = (output: string) => assert.match(output, /quarantine: #1234/);

describe(RULE, () => {
  rule.valid(
    "allows tests without overrides, conditional skips, and waitFor timeouts",
    `
      import { describe, it, vi } from "vitest";

      describe.skipIf(process.env.CI)("suite", () => {
        it.runIf(true)("runs", async () => {
          await vi.waitFor(() => {}, { timeout: 10_000 });
        });
        it.each([1, 2])("handles %s", (value) => {});
      });
      vi.setConfig({ restoreMocks: true });
    `,
  );

  rule.valid(
    "allows a skip with a quarantine issue or a GitHub issue URL",
    `
      import { describe, it } from "vitest";

      // quarantine: #1234 flakes on Windows until the pty fix lands
      it.skip("pending", () => {});

      // https://github.com/pingdotgg/t3code/issues/42
      describe.only("focused", () => {});
    `,
  );

  rule.invalid(
    "reports a numeric timeout on it.effect",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      it.effect("slow", () => Effect.void, 20_000);
    `,
    assertTimeoutMessage,
  );

  rule.invalid(
    "reports a timeout through .each and .skipIf chains",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      it.live.skipIf(false)("slow", () => Effect.void, 5_000);
      it.effect.each([1])("case %s", () => Effect.void, { timeout: 1_000 });
    `,
    (output) => {
      assertTimeoutMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 2);
    },
  );

  rule.invalid(
    "reports retry options, options-first timeouts, and hook timeouts",
    `
      import { beforeAll, describe, it } from "vitest";

      describe("suite", () => {
        beforeAll(() => {}, 60_000);
        it("flaky", () => {}, { retry: 3 });
        it("slow", { timeout: 30_000 }, () => {});
      });
    `,
    (output) => {
      assertTimeoutMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 3);
    },
  );

  rule.invalid(
    "reports vi.setConfig timeouts",
    `
      import { vi } from "vitest";

      vi.setConfig({ testTimeout: 30_000 });
    `,
    assertTimeoutMessage,
  );

  rule.invalid(
    "reports a skip whose comment has no issue",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";

      // flaky, will fix later
      it.effect.skip("pending", () => Effect.void);
    `,
    assertSkipMessage,
  );

  rule.invalid(
    "reports todo, only, and the x/f aliases",
    `
      import { describe, it, test } from "vitest";

      test.todo("later");
      describe.only("focused", () => {});
      xit("disabled", () => {});
      fdescribe("focused", () => {});
    `,
    (output) => {
      assertSkipMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 4);
    },
  );
  rule.invalid(
    "flags an options-object timeout when the callback is a reference",
    `
      import { it } from "vitest";
      const run = async () => {};
      it("slow", { timeout: 30_000 }, run);
    `,
    assertTimeoutMessage,
  );

  rule.invalid(
    "reports a timeout, retry or skip passed through a const or a spread",
    `
      import { beforeAll, it, vi } from "vitest";
      const options = { timeout: 180_000 };
      const slow = options;
      const LIMIT = 60_000;
      const config = { testTimeout: LIMIT };
      const SKIP = true;
      const skipped = { skip: SKIP };
      const spread = { concurrent: true, ...options };

      beforeAll(() => {}, LIMIT);
      vi.setConfig(config);
      it("slow", slow, () => {});
      it("slower", () => {}, LIMIT);
      it.each([1])("case %s", () => {}, { ...options });
      it("spread of a spread", { ...spread }, () => {});
      it("pending", skipped, () => {});
    `,
    (output) => {
      assertTimeoutMessage(output);
      assertSkipMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 7);
    },
  );

  rule.valid(
    "allows options passed through a const that set neither a timeout nor a retry",
    `
      import { it } from "vitest";
      const options = { concurrent: true };
      let later = { timeout: 1 };
      later = {};
      it("parallel", options, () => {});
      it("spread", { ...options, sequential: false }, () => {});
      it("reassigned", later, () => {});
    `,
  );

  rule.invalid(
    "reports a timeout or skip behind a bracketed key, a satisfies or a later spread",
    `
      import { it } from "vitest";
      const key = "timeout";
      const modifier = "skip";
      const typed = { timeout: 1_000 } satisfies Record<string, unknown>;
      const skipped = { skip: true };

      it("bracketed", { [key]: 1_000 }, () => {});
      it("typed", typed, () => {});
      it("typed spread", { ...typed }, () => {});
      it("skipped again", { skip: false, ...skipped }, () => {});
      it[modifier]("later", () => {});
    `,
    (output) => {
      assertTimeoutMessage(output);
      assertSkipMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 5);
    },
  );

  rule.invalid(
    "reports vi.setConfig behind a const key, and a timeout or skip a conditional spread keeps",
    `
      import { it, vi } from "vitest";
      const setConfig = "setConfig";
      const parallel = process.env.CI === "true";
      const slow = process.platform === "win32";
      vi[setConfig]({ testTimeout: 120_000 });
      it("skipped", { skip: true, ...(parallel && { concurrent: true }) }, () => {});
      it("slow here", { ...(slow ? { timeout: 5_000 } : {}) }, () => {});
      it("slow there", slow ? { timeout: 5_000 } : undefined, () => {});
    `,
    (output) => {
      assertTimeoutMessage(output);
      assertSkipMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 4);
    },
  );

  rule.valid(
    "allows a skip the test file turns off before the test runs, or sets on some runs only",
    `
      import { it } from "vitest";
      const options = { skip: true };
      options.skip = false;
      const assigned = { only: true };
      Object.assign(assigned, { only: false });
      const parallel = process.env.CI === "true";
      it("runs", options, () => {});
      it("runs too", assigned, () => {});
      it("sometimes", { ...(parallel && { skip: true }) }, () => {});
      it("plain values", { ...null, ...undefined, ...(parallel || {}) }, () => {});
    `,
  );

  rule.invalid(
    "reports a timeout a change to another option leaves, a key in a template literal, and a skip every run keeps",
    `
      import { it } from "vitest";
      const options = { timeout: 90_000 };
      options.concurrent = true;
      const key = \`timeout\`;
      const parallel = process.env.CI === "true";
      it("changed elsewhere", options, () => {});
      it("template key", { [key]: 90_000 }, () => {});
      it("skipped either way", { skip: true, ...(parallel && { skip: true }) }, () => {});
      it("skipped on both branches", parallel ? { skip: true } : { skip: true }, () => {});
    `,
    (output) => {
      assertTimeoutMessage(output);
      assertSkipMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 4);
    },
  );

  rule.valid(
    "allows a skip turned off through a type assertion, and a timeout on a branch no run takes",
    `
      import { it } from "vitest";
      type Options = { skip?: boolean; only?: boolean };
      const options = { skip: true };
      (options as Options).skip = false;
      const focused = { only: true };
      focused!.only = false;
      const defaults = { concurrent: true };
      it("runs", options, () => {});
      it("runs too", focused, () => {});
      it("defaults", { ...(defaults || { timeout: 90_000 }) }, () => {});
      it("never slow", { ...(null ?? {}), ...(false && { timeout: 90_000 }) }, () => {});
    `,
  );

  rule.valid(
    "allows a skip a later option turns off, and bracketed keys that name no timeout or skip",
    `
      import { it } from "vitest";
      const windowsHost = process.platform === "win32";
      const defaults = { skip: true };
      const timeout = "concurrent";
      const skip = "concurrent";
      it("runs", { ...defaults, skip: false }, () => {});
      it("gated", { ...defaults, skip: windowsHost }, () => {});
      it("parallel", { [timeout]: true }, () => {});
      it("unknown key", { skip: true, [String(Math.random())]: false }, () => {});
      it[skip]("concurrent", () => {});
    `,
  );

  rule.valid(
    "allows a computed skip option, which is a platform gate like skipIf",
    `
      import { it } from "vitest";
      const windowsHost = process.platform === "win32";
      it.each([{ name: "a" }])("x $name", { skip: windowsHost }, () => {});
    `,
  );

  rule.invalid(
    "flags the suite alias and option-object skips",
    `
      import { suite, test } from "vitest";
      suite.skip("later", () => {});
    `,
    assertSkipMessage,
  );

  rule.invalid(
    "flags a skip option without a quarantine issue",
    `
      import { test } from "vitest";
      test("later", { skip: true }, () => {});
    `,
    assertSkipMessage,
  );

  rule.invalid(
    "flags a bracket-access skip without a quarantine issue",
    `
      import { it } from "vitest";
      it["skip"]("later", () => {});
    `,
    assertSkipMessage,
  );

  rule.valid(
    "reads a const used as its own bracketed key, and a delete of an option the object does not set",
    `
      import { it } from "vitest";
      const key = "concurrent";
      key[key] = true;
      const options = { concurrent: true };
      options[options] = 1;
      const plain = { concurrent: true };
      delete plain.timeout;
      it("own key", { [key]: true }, () => {});
      it("own object", options, () => {});
      it("deleted", plain, () => {});
    `,
  );

  rule.valid(
    "allows a skip turned off through another const name, Object[key] or delete, and options set on the test function",
    `
      import { it } from "vitest";
      const options = { skip: true };
      const alias = options;
      alias.skip = false;
      const assign = "assign";
      const assigned = { only: true };
      Object[assign](assigned, { only: false });
      const removed = { skip: true };
      delete removed.skip;
      const body = async () => {};
      body.retry = 3;
      it("runs", options, () => {});
      it("runs too", assigned, () => {});
      it("runs again", removed, () => {});
      it("parallel", { concurrent: true }, body);
    `,
  );

  rule.invalid(
    "reports a timeout set through another const name, a delete of another option, and a computed time limit",
    `
      import { beforeAll, it } from "vitest";
      const options = { concurrent: true };
      const alias = options;
      alias.timeout = 90_000;
      const kept = { timeout: 90_000 };
      delete kept.concurrent;
      const slow = process.platform === "win32";
      const MINUTE = 60_000;
      it("through an alias", options, () => {});
      it("kept", kept, () => {});
      beforeAll(() => {}, slow ? 60_000 : undefined);
      it("product", () => {}, 2 * MINUTE);
      it("fallback", () => {}, Number(process.env.LIMIT) || 5_000);
    `,
    (output) => {
      assertTimeoutMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 5);
    },
  );

  rule.valid(
    "allows a time limit no run passes, a label, and a timeout behind a value every run finds truthy",
    `
      import { beforeAll, it } from "vitest";
      const parallel = process.env.CI === "true";
      const defaults = { concurrent: true };
      beforeAll(() => {}, false ? 60_000 : undefined);
      it("label", () => {}, "name" + "suffix");
      it("either branch", { ...((parallel ? defaults : {}) || { timeout: 90_000 }) }, () => {});
      it("or object", { ...((parallel || {}) || { timeout: 90_000 }) }, () => {});
    `,
  );
});

createOxlintRuleHarness(RULE, { filename: "Provider.live.test.ts" }).invalid(
  "still flags an option-object skip in a live file",
  `
    import { it } from "vitest";
    it("later", { skip: true }, () => {});
  `,
  assertSkipMessage,
);

createOxlintRuleHarness(RULE, { filename: "Provider.live.test.ts" }).valid(
  "allows timeouts in opt-in live provider suites",
  `
    import { it } from "@effect/vitest";
    import * as Effect from "effect/Effect";

    it.live("real turn", () => Effect.void, 360_000);
  `,
);

createOxlintRuleHarness(RULE).valid(
  "ignores non-test files",
  `
    const it = (_name: string, _fn: () => void, _ms: number) => {};
    it("x", () => {}, 1_000);
  `,
);
