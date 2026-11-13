import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-remote-git-through-execute");
const testFile = createOxlintRuleHarness("t3code/no-remote-git-through-execute", {
  filename: "git.test.ts",
});

describe("t3code/no-remote-git-through-execute", () => {
  rule.valid(
    "allows local commands, executeRemote and args it cannot read",
    `
      export const run = (git, args) => [
        git.execute({ cwd, args: ["rev-parse", "HEAD"] }),
        git.executeRemote({ cwd, args: ["fetch", "origin"] }),
        git.execute({ cwd, args }),
        git.execute({ cwd, args: [sub, "origin"] }),
      ];
    `,
  );

  rule.invalid(
    "reports fetch",
    `
      export const run = (git) => git.execute({ cwd, args: ["fetch", "origin"] });
    `,
    (output) => {
      assert.match(output, /Run remote Git commands with GitVcsDriver\.executeRemote/);
    },
  );

  rule.invalid(
    "reports ls-remote",
    `
      export const run = (git) => git.execute({ cwd, args: ["ls-remote", url] });
    `,
  );

  rule.invalid(
    "reports push",
    `
      export const run = (driver) => driver.execute({ cwd, args: ["push", "origin", "main"] });
    `,
  );

  rule.invalid(
    "reports clone",
    `
      export const run = (git) => git.execute({ cwd, args: ["clone", "--", url, dir] });
    `,
  );

  rule.invalid(
    "reports a template literal without expressions",
    `
      export const run = (git) => git.execute({ cwd, args: [\`pull\`] });
    `,
  );

  testFile.valid(
    "lets tests drive local fixture remotes",
    `
      export const run = (git) => git.execute({ cwd, args: ["fetch", "origin"] });
    `,
  );
});
