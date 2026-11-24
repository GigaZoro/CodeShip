import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-platform-early-return-in-tests", {
  filename: "fixture.test.ts",
});

describe("t3code/no-platform-early-return-in-tests", () => {
  rule.invalid(
    "reports an early return in a test whose private method is named like a hook",
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
    "reports an early return guarded by a helper that wraps the platform check or a host flag",
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
    `,
    (output) => {
      assert.equal(output.match(/no-platform-early-return-in-tests/g)?.length, 5);
    },
  );
});
