import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-platform-early-return-in-tests", {
  filename: "fixture.test.ts",
});

describe("t3code/no-platform-early-return-in-tests", () => {
  rule.valid(
    "allows skipIf/runIf and returns that do not compare the platform",
    `
      import { it } from "@effect/vitest";
      const unrelated = Effect.succeed(false);
      it.effect.skipIf(isWindowsHost)("a", () => Effect.gen(function* () {
        if (cases.length === 0) return;
        if (platform === "win32") return yield* Effect.fail("x");
        if (platform === "win32") { setup(); return; }
        if (yield* unrelated) return;
      }));
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
    "reports an early return guarded by a helper that wraps the platform check",
    `
      const runsOnWindows = Effect.map(HostProcess.Platform, (platform) => platform === "win32");
      function isMac() { return process.platform === "darwin"; }
      it.effect("a", () => Effect.gen(function* () {
        if (yield* runsOnWindows) return;
        if (isMac()) return;
        if (!(yield* runsOnWindows)) { return; }
      }));
    `,
    (output) => {
      assert.equal(output.match(/no-platform-early-return-in-tests/g)?.length, 3);
    },
  );
});
