import { providerMcpProblemOf } from "@t3tools/client-runtime/state/provider-mcp-problems";
import type { ProviderMcpServer, ServerProvider, ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  brokenProviders,
  countNeedsYouReasons,
  manualStepsBadge,
  mcpProblemSummary,
  pullRequestAttention,
} from "./sidebarNavRailCounts";

const link = (
  number: number,
  snapshot: Partial<NonNullable<ThreadPullRequestLink["snapshot"]>> | null,
  host = "github.com",
) =>
  ({
    host,
    repository: "o/r",
    number,
    snapshot: snapshot === null ? null : { state: "open", ...snapshot },
  }) as unknown as ThreadPullRequestLink;

const provider = (fields: Record<string, unknown>) =>
  ({
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    ...fields,
  }) as unknown as ServerProvider;

describe("sidebar rail counts", () => {
  it("countNeedsYouReasons tallies each reason", () => {
    expect(
      countNeedsYouReasons(["failed", "failed", "limited", "approval", "input", "request"]),
    ).toEqual({ approval: 1, input: 1, request: 1, failed: 2, limited: 1 });
  });

  it.each([
    {
      name: "counts failing checks, conflicts and changes requested; a PR in two buckets counts once",
      links: [
        link(1, { checksState: "failing", mergeability: "conflicting" }),
        link(2, { reviewDecision: "changes-requested" }),
      ],
      expected: { count: 2, failingChecks: 1, conflicts: 1, changesRequested: 1 },
    },
    {
      name: "skips snapshotless, closed, merged and healthy pull requests",
      links: [
        link(1, null),
        link(2, { state: "closed", checksState: "failing" }),
        link(3, { state: "merged", mergeability: "conflicting" }),
        link(4, { checksState: "pending", mergeability: "unknown", reviewDecision: "approved" }),
      ],
      expected: { count: 0, failingChecks: 0, conflicts: 0, changesRequested: 0 },
    },
    {
      name: "counts one pull request linked from two threads once, not across hosts",
      links: [
        link(1, { checksState: "failing" }),
        link(1, { checksState: "failing" }),
        link(1, { checksState: "failing" }, "ghe.example.com"),
      ],
      expected: { count: 2, failingChecks: 2, conflicts: 0, changesRequested: 0 },
    },
  ])("pullRequestAttention $name", ({ links, expected }) => {
    expect(pullRequestAttention(links)).toEqual(expected);
  });

  it.each([
    { status: "failed", origin: "config", counts: true },
    { status: "failed", origin: "plugin", counts: true },
    { status: "needsAuth", origin: "config", counts: true },
    { status: "needsAuth", origin: "connector", counts: true },
    { status: "needsAuth", origin: "plugin", counts: false },
    { status: "connected", origin: "config", counts: false },
    { status: "starting", origin: "config", counts: false },
    { status: "disabled", origin: "config", counts: false },
    { status: "notConfigured", origin: "plugin", counts: false },
  ])("providerMcpProblemOf $status from $origin: $counts", ({ status, origin, counts }) => {
    const server = { name: "s", status, origin } as unknown as ProviderMcpServer;
    expect(providerMcpProblemOf(server) !== null).toBe(counts);
  });

  it("mcpProblemSummary sums only active instances and names each server once", () => {
    const problems = new Map([
      ["a", [{ name: "x", displayName: "X", status: "failed" as const }]],
      [
        "b",
        [
          { name: "y", status: "needsAuth" as const },
          { name: "x", displayName: "X", status: "failed" as const },
        ],
      ],
      ["gone", [{ name: "z", status: "failed" as const }]],
    ]);
    expect(mcpProblemSummary(problems, new Set(["a", "b"]))).toEqual({
      count: 3,
      names: ["X", "y"],
    });
  });

  it.each([
    { view: null, expected: { kind: "none" } },
    { view: { status: "loading" }, expected: { kind: "none" } },
    { view: { status: "listed", groups: [], count: 0 }, expected: { kind: "none" } },
    {
      view: { status: "failed", reason: "unreachable" },
      expected: { kind: "failed", reason: "unreachable" },
    },
    {
      view: {
        status: "listed",
        count: 3,
        groups: [
          { machine: "Mac", steps: [{ kind: "needs-you" }, { kind: "hands-on" }] },
          { machine: "PC", steps: [{ kind: "hands-on" }] },
        ],
      },
      expected: { kind: "count", count: 3, moneyDecisions: 1 },
    },
  ])("manualStepsBadge $expected.kind", ({ view, expected }) => {
    expect(manualStepsBadge(view as never)).toEqual(expected);
  });

  it("brokenProviders lists installed enabled providers in error or signed out", () => {
    const named = (fields: Record<string, unknown>, name: string) => ({
      provider: provider(fields),
      name,
    });
    expect(
      brokenProviders([
        {
          environmentLabel: "Mac",
          providers: [
            named({ status: "error" }, "Broken"),
            named({ auth: { status: "unauthenticated" } }, "Signed out"),
            named({ installed: false, status: "error" }, "Not installed"),
            named({ enabled: false, status: "error" }, "Disabled"),
            named({}, "Fine"),
          ],
        },
      ]),
    ).toEqual([
      { name: "Broken", environmentLabel: "Mac" },
      { name: "Signed out", environmentLabel: "Mac" },
    ]);
  });
});
