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

  rule.invalid(
    "applies changes every run makes before the test registers in the order they run, and counts those a loop repeats",
    `
      import { it } from "vitest";
      const skipped = { concurrent: true };
      skipped.skip = true;
      const reenabled = { skip: true };
      reenabled.skip = false;
      reenabled.skip = true;
      const looped = { concurrent: true };
      for (const name of ["first", "second"]) {
        it(name, looped, () => {});
        looped.timeout = 90_000;
      }
      it("skipped", skipped, () => {});
      it("skipped again", reenabled, () => {});
    `,
    (output) => {
      assertTimeoutMessage(output);
      assertSkipMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 3);
    },
  );

  rule.valid(
    "allows a change made after the test registers, and a skip turned off by the last change or set on some runs only",
    `
      import { describe, it } from "vitest";
      const later = { concurrent: true };
      it("registered first", later, () => {});
      later.timeout = 90_000;
      describe("suite", () => {
        const local = { concurrent: true };
        it("registered first too", local, () => {});
        local.retry = 3;
      });
      const reenabled = { skip: false };
      reenabled.skip = true;
      reenabled.skip = false;
      const gated = { concurrent: true };
      if (process.platform === "win32") gated.skip = true;
      it("runs", reenabled, () => {});
      it("gated", gated, () => {});
    `,
  );

  rule.invalid(
    "applies a change some runs make before one every run makes later",
    `
      import { it } from "vitest";
      const ci = process.env.CI === "true";
      const options = { concurrent: true };
      if (ci) options.skip = false;
      options.skip = true;
      it("skipped", options, () => {});
    `,
    (output) => {
      assertSkipMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 1);
    },
  );

  rule.valid(
    "allows a timeout every run deletes after some set it, and a skip a function or class field may turn off later",
    `
      import { it } from "vitest";
      const slow = process.env.SLOW === "true";
      const options = { concurrent: true };
      if (slow) options.timeout = 90_000;
      delete options.timeout;
      const deferred = { concurrent: true };
      const enable = () => {
        deferred.skip = false;
      };
      deferred.skip = true;
      enable();
      const constructed = { concurrent: true };
      class Setup {
        value = (constructed.skip = false);
      }
      constructed.skip = true;
      new Setup();
      it("fast", options, () => {});
      it("runs", deferred, () => {});
      it("runs too", constructed, () => {});
    `,
  );

  rule.invalid(
    "reads the const Object.assign returns as its target, changed through either name after the call",
    `
      import { it } from "vitest";
      const base = {};
      const options = Object.assign(base, {});
      base.timeout = 90_000;
      const shared = { concurrent: true };
      const copy = Object.assign(shared, {});
      copy.retry = 3;
      const target = {};
      const skipped = Object.assign(target, { skip: true });
      it("slow", options, () => {});
      it("flaky", shared, () => {});
      it("skipped", skipped, () => {});
    `,
    (output) => {
      assertTimeoutMessage(output);
      assertSkipMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 3);
    },
  );

  rule.valid(
    "reads Object.assign onto a new object where it is called, and a skip it turns off on its target",
    `
      import { it } from "vitest";
      const defaults = { concurrent: true };
      const options = Object.assign({}, defaults);
      defaults.timeout = 90_000;
      const base = { skip: true };
      const enabled = Object.assign(base, { skip: false });
      it("copied before", options, () => {});
      it("enabled", enabled, () => {});
    `,
  );

  rule.invalid(
    "reports a skip that an assign of the file's own Object leaves on",
    `
      import { it } from "vitest";
      const Object = { assign: (target: object) => target };
      const options = { skip: true };
      Object.assign(options, { skip: false });
      it("skipped", options, () => {});
    `,
    (output) => {
      assertSkipMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 1);
    },
  );

  rule.invalid(
    "reports options copied by Object.assign, a skip every run leaves truthy, and a time limit a call computes",
    `
      import { afterAll, beforeAll, it, vi } from "vitest";
      const ci = process.env.CI === "true";
      const limit = process.env.LIMIT;
      vi.setConfig(Object.assign({}, { testTimeout: 100_000 }));
      it("skipped", { skip: ci || true }, () => {});
      beforeAll(() => {}, Number("90000"));
      afterAll(() => {}, Number.parseInt(limit));
      it("parsed", () => {}, parseInt(limit));
      it("longest", () => {}, Math.max(5_000, 90_000));
    `,
    (output) => {
      assertTimeoutMessage(output);
      assertSkipMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 6);
    },
  );

  rule.valid(
    "allows a timeout behind a value every run finds falsy, and calls that give no number",
    `
      import { it } from "vitest";
      const ci = process.env.CI === "true";
      const gate = ci ? null : false;
      const parseInt = (text: string) => text;
      it("never slow", gate ? { timeout: 90_000 } : {}, () => {});
      it("label", () => {}, parseInt("name"));
      it("text", () => {}, String(90_000));
      it("copied", Object.assign({}, { concurrent: true }), () => {});
    `,
  );

  rule.invalid(
    "reports a timeout a spread or Object.assign source deletes from itself, not from the options it is copied into",
    `
      import { it } from "vitest";
      const overrides = { timeout: 1 };
      delete overrides.timeout;
      it("spread", { timeout: 5_000, ...overrides }, () => {});
      it("assigned", Object.assign({ timeout: 5_000 }, overrides), () => {});
    `,
    (output) => {
      assertTimeoutMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 2);
    },
  );

  rule.invalid(
    "reads a logical assignment as setting the option only on a run whose old value calls for it",
    `
      import { it } from "vitest";
      const unset = {};
      unset.skip ??= true;
      it("skipped when unset", unset, () => {});
      const off = { skip: false };
      off.skip ||= true;
      it("skipped when off", off, () => {});
      const on = { skip: true };
      on.skip ||= false;
      it("still skipped", on, () => {});
      const merged = { ...defaults };
      merged.skip ||= true;
      it("skipped whatever the defaults", merged, () => {});
      const kept = { timeout: 1_000 };
      kept.timeout &&= 5_000;
      it("slow", kept, () => {});
      const undefinedSkip = { skip: undefined };
      undefinedSkip.skip ??= true;
      it("skipped when undefined", undefinedSkip, () => {});
      const nullSkip = { skip: null };
      nullSkip.skip ??= true;
      it("skipped when null", nullSkip, () => {});
      const nothing = { skip: undefined };
      nothing.skip ||= true;
      it("skipped when nothing", nothing, () => {});
    `,
    (output) => {
      assertTimeoutMessage(output);
      assertSkipMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 8);
    },
  );

  rule.valid(
    "allows an option &&= writes only over one the options hold, and a skip ??= or &&= may leave off",
    `
      import { it } from "vitest";
      const options = {};
      options.timeout &&= 5_000;
      it("fast", options, () => {});
      const off = { skip: false };
      off.skip ??= true;
      it("runs", off, () => {});
      const gated = { skip: true };
      gated.skip &&= process.env.CI === "true";
      it("gated", gated, () => {});
      const nullish = { skip: null };
      nullish.skip &&= true;
      it("still runs", nullish, () => {});
    `,
  );

  rule.valid(
    "allows a skip a getter returns, a function's own options copied over a skip, and a test body's own properties",
    `
      import { it } from "vitest";
      it("getter", { get skip() { return false; } }, () => {});
      const flags = () => {};
      flags.skip = false;
      it("spread", { skip: true, ...flags }, () => {});
      it("assigned", Object.assign({ skip: true }, flags), () => {});
      const body = () => {};
      body.timeout = 5_000;
      body.skip = true;
      it("body", body);
      it("options first", {}, body);
    `,
  );

  rule.invalid(
    "reports options a spread, Object.assign or vi.setConfig copies from a function that holds them",
    `
      import { it, vi } from "vitest";
      const extra = () => {};
      extra.timeout = 5_000;
      it("spread", { ...extra }, () => {});
      it("assigned", Object.assign({}, extra), () => {});
      function declared() {}
      declared.timeout = 5_000;
      it("declared", { ...declared }, () => {});
      function configured() {}
      configured.testTimeout = 5_000;
      vi.setConfig(configured);
    `,
    (output) => {
      assertTimeoutMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 4);
    },
  );

  rule.valid(
    "allows a test body chosen by a condition or returned by Object.assign, whatever properties it holds",
    `
      import { it } from "vitest";
      const slowBody = () => {};
      slowBody.timeout = 9_000;
      it("either body", process.env.CI ? slowBody : () => {});
      it("assigned body", Object.assign(() => {}, { timeout: 9_000 }));
      it("assigned either body", Object.assign(process.env.CI ? () => {} : () => {}, { timeout: 9_000 }));
    `,
  );

  rule.invalid(
    "reports a skip every run holds whatever kinds of value a logical assignment writes over",
    `
      import { it } from "vitest";
      const nullOrOn = { skip: process.env.CI ? true : null };
      nullOrOn.skip ??= true;
      it("skipped either way", nullOrOn, () => {});
    `,
    (output) => {
      assertSkipMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 1);
    },
  );

  rule.valid(
    "allows a skip a local named undefined holds, and one a getter returns whatever a setter is given",
    `
      import { it } from "vitest";
      function local(undefined) {
        const shadowed = { skip: undefined };
        shadowed.skip ??= true;
        it("runs when passed false", shadowed, () => {});
      }
      local(false);
      const accessed = { get skip() { return false; }, set skip(value) {} };
      accessed.skip = true;
      it("getter decides", accessed, () => {});
      const assigned = { get skip() { return false; }, set skip(value) {} };
      Object.assign(assigned, { skip: true });
      it("getter decides after Object.assign", assigned, () => {});
    `,
  );

  rule.invalid(
    "reports a skip a spread or a write sets once nothing holds a getter for it",
    `
      import { it } from "vitest";
      it("spread over", { get skip() { return false; }, ...{ skip: true } }, () => {});
      const redefined = { get skip() { return false; }, set skip(value) {} };
      delete redefined.skip;
      redefined.skip = true;
      it("getter gone", redefined, () => {});
    `,
    (output) => {
      assertSkipMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 2);
    },
  );

  rule.invalid(
    "reads a property test's time limit and options from its fourth argument",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";
      import * as Schema from "effect/Schema";
      it.prop("limit", { n: Schema.Number }, () => {}, 90_000);
      it.effect.prop("options", [Schema.Number], () => Effect.void, { timeout: 90_000 });
      it.prop("skipped", { n: Schema.Number }, () => {}, { skip: true });
    `,
    (output) => {
      assertTimeoutMessage(output);
      assertSkipMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 3);
    },
  );

  rule.valid(
    "allows property tests whose arbitraries are named like options",
    `
      import { it } from "@effect/vitest";
      import * as Effect from "effect/Effect";
      import * as Schema from "effect/Schema";
      it.prop("timeouts", { timeout: Schema.Number, skip: Schema.Boolean }, () => {});
      it.effect.prop("retries", { retry: Schema.Number }, () => Effect.void, { fails: false });
    `,
  );

  // Each change's key is a const whose own changes are keyed by the next const: without a bound on how many changes
  // one resolution reads, reading them takes twice as long for each const in the chain.
  const CHAIN = 40;
  rule.valid(
    "reads a long chain of changes keyed by consts in bounded time",
    [
      `import { it } from "vitest";`,
      ...Array.from({ length: CHAIN + 1 }, (_, index) => `const v${index} = { concurrent: true };`),
      ...Array.from({ length: CHAIN }, (_, index) => [
        `v${index}[v${index + 1}] = 1;`,
        `v${index}[v${index + 1}] = 2;`,
      ]).flat(),
      `it("chained", v0, () => {});`,
    ].join("\n"),
  );

  // Each `Object.assign(o, o)` reads `o` where it is called, which reads every earlier one again: without one budget
  // for a test's whole options, the reads grow with the fourth power of the number of lines.
  const COPIES = 40;
  rule.invalid(
    "reads many copies of options onto themselves in bounded time",
    [
      `import { it } from "vitest";`,
      `const slow = { timeout: 90_000 };`,
      `const fast = { concurrent: true };`,
      ...Array.from({ length: COPIES }, () => [
        `Object.assign(slow, slow);`,
        `Object.assign(fast, fast);`,
      ]).flat(),
      `it("slow", slow, () => {});`,
      `it("fast", fast, () => {});`,
    ].join("\n"),
    (output) => {
      assertTimeoutMessage(output);
      assert.equal(output.match(/no-test-timeout-or-unreasoned-skip/g)?.length, 1);
    },
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
