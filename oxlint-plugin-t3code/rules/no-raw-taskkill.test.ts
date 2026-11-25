import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-raw-taskkill");

describe("t3code/no-raw-taskkill", () => {
  rule.valid(
    "allows the shared tree stop and other commands",
    `
      import { withWindowsTreeStop } from "@t3tools/shared/windowsProcessTree";
      import { execFile } from "node:child_process";

      export const stop = withWindowsTreeStop;
      export const list = () => execFile("tasklist", ["/FI", "taskkill is not a command name here"]);
    `,
  );

  rule.invalid(
    "reports taskkill run directly",
    `
      import { execFile } from "node:child_process";

      export const stop = (pid: number) => execFile("taskkill", ["/PID", String(pid), "/T", "/F"]);
    `,
    (output) => {
      assert.match(output, /@t3tools\/shared\/windowsProcessTree/);
    },
  );

  rule.invalid(
    "reports taskkill.exe in a template literal",
    `
      export const command = \`TASKKILL.EXE\`;
    `,
  );
});
