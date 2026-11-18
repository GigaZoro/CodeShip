import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-raw-process-group-signal");

describe("t3code/no-raw-process-group-signal", () => {
  rule.valid(
    "allows the shared group module and signals to one process",
    `
      import { ownProcessGroup } from "@t3tools/shared/processGroup";

      export const stop = (child: import("node:child_process").ChildProcess) => {
        ownProcessGroup(child, undefined).signal("SIGTERM");
        process.kill(child.pid ?? 0, "SIGTERM");
      };
    `,
  );

  rule.invalid(
    "reports a group signal",
    `
      export const stop = (pid: number) => process.kill(-pid, "SIGKILL");
    `,
    (output) => {
      assert.match(output, /@t3tools\/shared\/processGroup/);
    },
  );

  rule.invalid(
    "reports a group probe through globalThis",
    `
      export const exists = (pgid: number) => globalThis.process.kill(-pgid, 0);
    `,
  );
});
