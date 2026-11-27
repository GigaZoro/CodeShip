/* oxlint-disable t3code/no-wow64-binary-path -- the fixtures are invalid on purpose */
import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-wow64-binary-path");

describe("t3code/no-wow64-binary-path", () => {
  rule.valid(
    "allows 64-bit locations and the 32-bit names in comments",
    `
      import * as NodePath from "node:path";

      // A goto, not a parenthesized block: "Program Files (x86)" would close the block early.
      export const x64 = (root: string) =>
        NodePath.join(root, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
      export const arm64 = (root: string) =>
        NodePath.join(root, "Microsoft.NET", "FrameworkArm64", "v4.0.30319", "csc.exe");
      export const shell = "C:/Windows/System32/cmd.exe";
      export const tools = "C:/Program Files/Tool/tool.exe";
      export const frameworkWord = ["Framework", "Microsoft.NET"];
    `,
  );

  rule.invalid(
    "reports the 32-bit framework directory as a path.join segment",
    `
      import * as NodePath from "node:path";

      export const compiler = (root: string) =>
        NodePath.join(root, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");
    `,
    (output) => {
      assert.match(output, /fspy/);
      assert.match(output, /WOW64/);
    },
  );

  rule.invalid(
    "reports the 32-bit framework directory held in a constant",
    `
      import * as NodePath from "node:path";

      const FRAMEWORK = "Framework";
      export const compiler = (root: string) =>
        NodePath.join(root, "Microsoft.NET", FRAMEWORK, "v4.0.30319", "csc.exe");
    `,
  );

  rule.invalid(
    "reports the 32-bit framework directory as an array segment",
    `export const parts = ["C:/Windows", "microsoft.net", "framework", "csc.exe"];`,
  );

  rule.invalid(
    "reports the 32-bit framework directory inside one path",
    `export const compiler = "C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe";`,
  );

  rule.invalid(
    "reports a template literal naming the 32-bit framework directory",
    "export const compiler = (root: string) => `${root}\\\\Microsoft.NET\\\\Framework\\\\csc.exe`;",
  );

  rule.invalid(
    "reports the 32-bit system directory",
    `export const shell = "C:\\\\Windows\\\\SysWOW64\\\\cmd.exe";`,
  );

  rule.invalid(
    "reports the 32-bit program files directory",
    `export const tool = "C:/Program Files (x86)/Tool/tool.exe";`,
  );
});
