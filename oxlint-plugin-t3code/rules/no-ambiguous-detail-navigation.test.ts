import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-ambiguous-detail-navigation", {
  filename: "apps/mobile/src/features/threads/ThreadFeed.tsx",
});

describe("t3code/no-ambiguous-detail-navigation", () => {
  rule.valid(
    "allows selections, explicit pushes, and other routes",
    `
      selectDetail({ name: "Thread", params });
      navigation.dispatch(StackActions.push("PullRequest", params));
      navigation.navigate("ThreadFiles", params);
    `,
  );

  rule.valid(
    "reads a bracketed method through the const that holds its name",
    `
      const navigate = "push";
      navigation[navigate]("Thread", params);
    `,
  );

  rule.invalid(
    "reports navigate called through brackets",
    `
      const method = "navigate";
      navigation[method]("Thread", params);
      navigation["navigate"]("PullRequest", params);
    `,
    (output) => assert.equal(output.match(/no-ambiguous-detail-navigation/g)?.length, 2),
  );

  rule.invalid("reports navigating to a thread", `navigation.navigate("Thread", params);`);

  rule.invalid(
    "reports a navigate action to a pull request",
    `navigation.dispatch(CommonActions.navigate("PullRequest", params));`,
  );
});
