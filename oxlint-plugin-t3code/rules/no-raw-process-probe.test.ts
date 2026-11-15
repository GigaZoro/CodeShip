import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-raw-process-probe");

describe("t3code/no-raw-process-probe", () => {
  rule.valid(
    "allows the shared probe, real signals and process group probes",
    `
      import { isProcessAlive } from "@t3tools/shared/processProbe";

      export const stop = (pid: number) => {
        if (isProcessAlive(pid)) process.kill(pid, "SIGTERM");
        process.kill(-pid, 0);
      };
    `,
  );

  rule.invalid(
    "reports a local signal 0 probe",
    `
      export const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
    `,
    (output) => {
      assert.match(output, /@t3tools\/shared\/processProbe/);
    },
  );

  rule.invalid(
    "reports a probe through globalThis",
    `
      export const probe = (pid: number) => globalThis.process.kill(pid, 0);
    `,
  );
});
