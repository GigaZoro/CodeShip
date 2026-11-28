import { describe, expect, it } from "vite-plus/test";

import { resolveThreadVitals, type ThreadVitalsInput } from "./threadVitals";

const base: ThreadVitalsInput = {
  machineLabel: "Mac",
  branch: "feat/auth",
  changes: { additions: 142, deletions: 18 },
  branchPullRequest: { number: 88, state: "open" },
  linkedPullRequests: [],
  contextUsedPercentage: 42,
};

describe("resolveThreadVitals", () => {
  it("lists where the thread runs, what it changed and its pull request", () => {
    expect(resolveThreadVitals(base)).toEqual([
      { kind: "machine", label: "Mac" },
      { kind: "branch", name: "feat/auth" },
      { kind: "changes", additions: 142, deletions: 18 },
      { kind: "pullRequest", number: 88 },
    ]);
  });

  it.each([
    { used: 74, context: undefined },
    { used: 75, context: undefined },
    { used: 75.6, context: { kind: "context", percent: 76, attention: false } },
    { used: 80, context: { kind: "context", percent: 80, attention: false } },
    { used: 81, context: { kind: "context", percent: 81, attention: true } },
    { used: 130, context: { kind: "context", percent: 100, attention: true } },
  ])("shows context only above 75% and marks it above 80%: $used", ({ used, context }) => {
    const vitals = resolveThreadVitals({ ...base, contextUsedPercentage: used });
    expect(vitals.find((vital) => vital.kind === "context")).toEqual(context);
  });

  it.each([
    {
      name: "a merged branch pull request gives way to the open one the thread links",
      branch: { number: 88, state: "merged" },
      linked: [{ number: 91, state: "open", checksFailing: true }],
      expected: [{ kind: "pullRequest", number: 91 }, { kind: "checksFailing" }],
    },
    {
      name: "a closed branch pull request with nothing open shows none",
      branch: { number: 88, state: "closed" },
      linked: [{ number: 80, state: "merged", checksFailing: true }],
      expected: [],
    },
    {
      name: "the open branch pull request wins over other linked ones",
      branch: { number: 88, state: "open" },
      linked: [
        { number: 91, state: "open", checksFailing: true },
        { number: 88, state: "open", checksFailing: false },
      ],
      expected: [{ kind: "pullRequest", number: 88 }],
    },
  ])("$name", ({ branch, linked, expected }) => {
    const vitals = resolveThreadVitals({
      ...base,
      branchPullRequest: branch,
      linkedPullRequests: linked,
    });
    expect(
      vitals.filter((vital) => vital.kind === "pullRequest" || vital.kind === "checksFailing"),
    ).toEqual(expected);
  });

  it("surfaces failing checks after the pull request", () => {
    const vitals = resolveThreadVitals({
      ...base,
      linkedPullRequests: [{ number: 88, state: "open", checksFailing: true }],
    });
    expect(vitals.map((vital) => vital.kind)).toEqual([
      "machine",
      "branch",
      "changes",
      "pullRequest",
      "checksFailing",
    ]);
  });

  it("leaves out what the thread does not have", () => {
    expect(
      resolveThreadVitals({
        machineLabel: null,
        branch: null,
        changes: { additions: 0, deletions: 0 },
        branchPullRequest: null,
        linkedPullRequests: [],
        contextUsedPercentage: null,
      }),
    ).toEqual([]);
  });
});
