import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-canonical-key-comparison");

describe("t3code/no-canonical-key-comparison", () => {
  rule.valid(
    "allows the contracts matchers and presence checks",
    `
      import { repositoryKeysOf, repositoryMatchRank } from "@t3tools/contracts";

      export const sameRepository = (here, there) =>
        repositoryMatchRank(repositoryKeysOf(here), there.repositoryIdentity) !== -1;
      export const hasKey = (project) => project.repositoryIdentity?.canonicalKey != null;
      export const missing = (identity) => identity.canonicalKey === undefined;
    `,
  );

  rule.invalid(
    "reports a project matched by its primary key alone",
    `
      export const find = (projects, key) =>
        projects.filter((project) => project.repositoryIdentity?.canonicalKey === key);
    `,
    (output) => {
      assert.match(output, /repositoryMatchRank or repositoryKeysOf/);
    },
  );

  rule.invalid(
    "reports a key on the right-hand side",
    `
      export const same = (identity, key) => key !== identity.canonicalKey;
    `,
  );
});
