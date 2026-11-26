import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-platform-early-return-in-tests", {
  filename: "fixture.test.ts",
});

describe("t3code/no-platform-early-return-in-tests", () => {
  rule.valid(
    "allows an early return in a callback that a private method named like a hook runs",
    `
      class Suite {
        #beforeEach(run) { run(); }
        register() {
          it("a", () => { this.#beforeEach(() => { if (process.platform === "win32") return; }); });
        }
      }
    `,
  );

  rule.valid(
    "allows skipIf/runIf and returns that do not compare the platform",
    `
      import { afterEach, beforeAll, it } from "@effect/vitest";
      import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
      const unrelated = Effect.succeed(false);
      beforeAll(() => { if (process.platform !== "win32") return; setupWindowsFixture(); });
      afterEach(() => { if (!isWindowsHost) return; cleanupWindowsFixture(); });
      it.effect.skipIf(isWindowsHost)("a", () => Effect.gen(function* () {
        if (cases.length === 0) return;
        if (platform === "win32") return yield* Effect.fail("x");
        if (platform === "win32") { setup(); return; }
        if (yield* unrelated) return;
      }));
    `,
  );

  rule.valid(
    "allows an early return in a lifecycle hook a const key names",
    `
      import * as vitest from "vitest";
      const hook = "beforeEach";
      vitest[hook](() => { if (process.platform !== "win32") return; setupWindowsFixture(); });
    `,
  );

  rule.invalid(
    "reports an early return in a test whose bracketed key is a variable named like a hook",
    `
      import * as vitest from "vitest";
      const beforeEach = "it";
      vitest[beforeEach]("a", () => { if (process.platform === "win32") return; });
    `,
  );

  rule.valid(
    "allows platform checks that branch or skip, values that give no platform check, and returns that end only a callback",
    `
      import * as HostProcess from "@t3tools/shared/HostProcess";
      import { isWindows } from "@t3tools/shared/HostProcess";
      it.effect("a", ({ skip }) => Effect.gen(function* () {
        const separator = (yield* HostProcess.isWindows) ? ";" : ":";
        const onWindows = yield* isWindows;
        if (yield* HostProcess.isWindows) { expect(separator).toBe(";"); } else { expect(separator).toBe(":"); }
        if (onWindows) return skip("needs sh");
        if (separator === ":") return;
      }));
      it.effect("b", () => Effect.gen(function* () {
        const onWindows = queue.length === 0;
        if (onWindows) return;
      }));
      it.effect("c", () => Effect.gen(function* () {
        const flag = yield* HostProcess.isWindows;
        const check = (flag) => { if (flag) return; verify(); };
        check(queue.length === 0);
        { const ready = yield* isWindows; expect(ready).toBe(true); }
        { const ready = queue.length === 0; if (ready) return; }
        let pending = yield* HostProcess.isWindows;
        pending = queue.length === 0;
        if (pending) return;
      }));
      it.effect("d", () => Effect.gen(function* () {
        const { done } = { windows: process.platform === "win32", done: queue.length === 0 };
        if (done) return;
        const state = { windows: process.platform === "win32", done: queue.length === 0 };
        if (state.done) return;
        const steps = { first: () => steps.next(), next: () => steps.first() };
        if (steps.first()) return;
        yield* Effect.addFinalizer(() => Effect.gen(function* () {
          if (yield* HostProcess.isWindows) return;
          yield* resetPermissions();
        }));
        if (early) return;
        var early = isWindows;
        function ready() { return process.platform === "win32"; }
        ready = () => queue.length === 0;
        if (ready()) return;
        const typed = { windows: process.platform === "win32", done: false } as const;
        if (typed.done) return;
        const nested = { flags: { windows: process.platform === "win32", done: false } };
        if (nested.flags.done) return;
        const overridden = { skip: process.platform === "win32" };
        overridden.skip = false;
        if (overridden.skip) return;
        const spread = { skip: process.platform === "win32", ...overrides };
        if (spread.skip) return;
        yield* Effect.forEach(items, () => Effect.gen(function* () {
          if (yield* HostProcess.isWindows) return;
          yield* step();
        }));
        if (yield* HostProcess.isWindows.pipe(Effect.as(false))) return;
        function shellReady() {
          const shell = process.platform === "win32" ? "cmd" : "sh";
          expect(shell).toBeTruthy();
          return false;
        }
        if (shellReady()) return;
        const key = "skip";
        const computed = { skip: process.platform === "win32", [key]: false };
        if (computed.skip) return;
        const asserted = { skip: process.platform === "win32" };
        asserted!.skip = false;
        if (asserted.skip) return;
        const reassigned = { skip: process.platform === "win32" };
        [reassigned.skip] = [false];
        if (reassigned.skip) return;
        if (hoisted?.skip) return;
        var hoisted = { skip: process.platform === "win32" };
        const map = (_value: boolean) => false;
        if (map(process.platform === "win32")) return;
        const known = { skip: false };
        const { skip: knownSkip = process.platform === "win32" } = known;
        if (knownSkip) return;
        function shellName() { if (process.platform === "win32") return "cmd"; return "sh"; }
        if (!shellName()) return;
      }));
      it.effect("g", () => Effect.gen(function* () {
        function map(value: boolean): boolean;
        function map(value: string): boolean;
        function map(value: boolean | string) { return typeof value === "string"; }
        if (map(process.platform === "win32")) return;
      }));
      it.effect("h", () =>
        Effect.ensuring(
          Effect.gen(function* () {
            if (yield* HostProcess.isWindows) return;
            yield* cleanup();
          }),
        )(Effect.sync(() => expect(1).toBe(1))),
      );
      it.effect("i", () =>
        Effect.andThen(
          Effect.gen(function* () {
            if (yield* HostProcess.isWindows) return;
            yield* setup();
          }),
          Effect.sync(() => expect(1).toBe(1)),
        ),
      );
      it.effect("e", () =>
        Effect.ensuring(
          Effect.sync(() => expect(1).toBe(1)),
          Effect.gen(function* () {
            if (yield* HostProcess.isWindows) return;
            yield* cleanup();
          }),
        ),
      );
      it.effect("f", () =>
        Effect.gen(function* () {
          yield* step();
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (yield* HostProcess.isWindows) return;
              yield* cleanup();
            }),
          ),
        ),
      );
      it.effect("j", () =>
        Effect.gen(function* () {
          if (yield* HostProcess.isWindows) return;
          yield* setup();
        }).pipe(Effect.provide(layer), Effect.andThen(Effect.sync(() => expect(1).toBe(1)))),
      );
      it.effect("k", () =>
        pipe(
          Effect.gen(function* () {
            if (yield* HostProcess.isWindows) return;
            yield* setup();
          }),
          Effect.andThen(Effect.sync(() => expect(1).toBe(1))),
        ),
      );
    `,
  );

  rule.valid(
    "gives up on aliases and expressions nested too deep to follow instead of exhausting the stack",
    [
      `import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";`,
      "const alias0 = isWindowsHost;",
      ...Array.from({ length: 2047 }, (_, index) => `const alias${index + 1} = alias${index};`),
      `it("a", () => { if (alias2047) return; });`,
      ...Array.from(
        { length: 80 },
        (_, batch) =>
          `const batch${batch} = ${[
            batch === 0 ? "start" : `batch${batch - 1}`,
            ...Array.from({ length: 140 }, (_, flag) => `flag${flag}`),
          ].join(" || ")};`,
      ),
      `it("b", () => { if (batch79) return; });`,
    ].join("\n"),
  );

  rule.invalid(
    "reports a platform comparison that returns early, in every spelling",
    `
      it.effect("a", () => Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const platform = yield* HostProcess.Platform;
        if (platform !== "win32") return;
        if (process.platform === "darwin" || platform === "linux") { return; }
      }));
    `,
    (output) => {
      assert.match(output, /Early return on the host platform/);
      assert.equal(output.match(/no-platform-early-return-in-tests/g)?.length, 3);
    },
  );

  rule.invalid(
    "reports an early return from a test or suite body guarded by a helper, a value or a host flag that gives the platform check",
    `
      import { isWindowsHost as onWindows } from "@t3tools/shared/testing/hostPlatform";
      import * as HostPlatform from "@t3tools/shared/testing/hostPlatform";
      const runsOnWindows = Effect.map(HostProcess.Platform, (platform) => platform === "win32");
      function isMac() { return process.platform === "darwin"; }
      it.effect("a", () => Effect.gen(function* () {
        if (yield* runsOnWindows) return;
        if (isMac()) return;
        if (!(yield* runsOnWindows)) { return; }
        if (!onWindows) return;
        if (HostPlatform.isLinuxHost) return;
      }));
      it("b", () => { if (late) return; verify(); });
      const late = onWindows;
      it("c", () => { type onWindows = boolean; if (onWindows) return; verify(); });
      it("d", () => {
        const { isWindowsHost: skipHere } = HostPlatform;
        if (skipHere) return;
        const state = { windows: process.platform === "win32", done: queue.length === 0 };
        if (state.windows) return;
      });
      it("e", () => {
        const typedFlags = { windows: onWindows } satisfies Record<string, boolean>;
        if (typedFlags.windows) return;
        const nestedFlags = { flags: { windows: onWindows } };
        if (nestedFlags.flags.windows) return;
        const skip = process.env.CI ? onWindows : false;
        if (skip) return;
      });
      describe("f", () => {
        if (process.platform === "win32") return;
        it("g", () => {});
      });
      it("h", () => {
        type flag = boolean;
        const flag = onWindows;
        if (flag) return;
        const flagged = { skip: onWindows };
        const { skip: defaulted = false } = flagged;
        if (defaulted) return;
        const unset = { skip: undefined };
        const { skip: unsetSkip = onWindows } = unset;
        if (unsetSkip) return;
        const key = "skip";
        const keyed = { [key]: onWindows };
        if (keyed.skip) return;
      });
    `,
    (output) => {
      assert.equal(output.match(/no-platform-early-return-in-tests/g)?.length, 17);
    },
  );

  rule.invalid(
    "reports an early return from a test body passed by name, registered under an aliased import or wrapped by calls that keep its outcome",
    `
      import { it as spec } from "vitest";
      import { it as effectIt } from "@effect/vitest";
      import * as vitest from "vitest";
      import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
      function body() { if (isWindowsHost) return; expect(1).toBe(1); }
      it("a", body);
      spec("b", () => { if (isWindowsHost) return; });
      const genBody = () => Effect.gen(function* () { if (isWindowsHost) return; });
      effectIt.effect("c", genBody);
      effectIt.effect("d", () => Effect.scoped(Effect.gen(function* () { if (isWindowsHost) return; })));
      effectIt.effect("e", () => Effect.ensuring(cleanup)(Effect.gen(function* () { if (isWindowsHost) return; })));
      effectIt.effect("f", () => pipe(Effect.gen(function* () { if (isWindowsHost) return; }), Effect.provide(layer), Effect.scoped));
      effectIt.effect("g", () => Effect.gen(function* () { if (isWindowsHost) return; }).pipe(Effect.provideService(Tag, impl), Effect.orDie));
      vitest.describe.each(cases)("h", () => { if (isWindowsHost) return; });
      const wrapper = "scoped";
      effectIt.effect("i", () => Effect[wrapper](Effect.gen(function* () { if (isWindowsHost) return; })));
    `,
    (output) => {
      assert.equal(output.match(/no-platform-early-return-in-tests/g)?.length, 9);
    },
  );

  rule.invalid(
    "reports an early return on a yielded HostProcess platform predicate, however it is imported or held",
    `
      import * as HostProcess from "@t3tools/shared/HostProcess";
      import { isWindows, isWindows as onWindows } from "@t3tools/shared/HostProcess";
      it.effect("a", () => Effect.gen(function* () {
        if (yield* HostProcess.isWindows) return;
        if (!(yield* HostProcess.isWindows)) { return; }
        if (yield* isWindows) return;
        if (!(yield* onWindows)) return;
        const windows = yield* HostProcess.isWindows;
        if (windows) return;
        const windowsCheck = () => HostProcess.isWindows;
        if (yield* windowsCheck()) return;
        const { isWindows: win } = HostProcess;
        if (yield* win) return;
        if (yield* HostProcess["isWindows"]) return;
        const predicate = "isWindows";
        if (yield* HostProcess[predicate]) return;
        const genCheck = Effect.gen(function* () {
          return yield* HostProcess.isWindows;
        });
        if (yield* genCheck) return;
      }));
      it.effect("b", () =>
        Effect.gen(function* () {
          if (yield* HostProcess.isWindows) return;
        }).pipe(Effect.provide(layer)),
      );
    `,
    (output) => {
      assert.equal(output.match(/no-platform-early-return-in-tests/g)?.length, 11);
    },
  );
});
