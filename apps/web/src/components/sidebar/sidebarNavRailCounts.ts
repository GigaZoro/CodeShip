import type { NeedsYouReason } from "@t3tools/client-runtime/state/thread-inbox";
import type { ManualStepsView } from "@t3tools/client-runtime/state/manualSteps";
import type { ProviderMcpProblem } from "@t3tools/client-runtime/state/provider-mcp-problems";
import type { ServerProvider, ThreadPullRequestLink } from "@t3tools/contracts";

import { deriveProviderStatus } from "../settings/providerStatus";

export type NeedsYouBreakdown = Readonly<Record<NeedsYouReason, number>>;

export function countNeedsYouReasons(reasons: ReadonlyArray<NeedsYouReason>): NeedsYouBreakdown {
  const counts = { approval: 0, input: 0, request: 0, failed: 0, limited: 0, stalled: 0 };
  for (const reason of reasons) counts[reason] += 1;
  return counts;
}

export interface PullRequestProblems {
  readonly count: number;
  readonly failingChecks: number;
  readonly conflicts: number;
}

/** Open pull requests whose checks fail or that conflict, each counted once across threads. */
export function pullRequestProblems(
  links: ReadonlyArray<ThreadPullRequestLink>,
): PullRequestProblems {
  const seen = new Set<string>();
  const total = { count: 0, failingChecks: 0, conflicts: 0 };
  for (const link of links) {
    const { snapshot } = link;
    if (snapshot === null || snapshot.state !== "open") continue;
    const key = JSON.stringify([link.host, link.repository, link.number]);
    if (seen.has(key)) continue;
    seen.add(key);
    const failingChecks = snapshot.checksState === "failing";
    const conflicts = snapshot.mergeability === "conflicting";
    if (!failingChecks && !conflicts) continue;
    total.count += 1;
    total.failingChecks += Number(failingChecks);
    total.conflicts += Number(conflicts);
  }
  return total;
}

export interface McpProblemSummary {
  readonly count: number;
  /** Distinct, in the order found. */
  readonly names: ReadonlyArray<string>;
}

/** Only provider instances that still exist and are enabled count; the rest left their list behind. */
export function mcpProblemSummary(
  problemsByInstance: ReadonlyMap<string, ReadonlyArray<ProviderMcpProblem>>,
  activeInstanceKeys: ReadonlySet<string>,
): McpProblemSummary {
  const names = new Set<string>();
  let count = 0;
  for (const [key, problems] of problemsByInstance) {
    if (!activeInstanceKeys.has(key)) continue;
    count += problems.length;
    for (const problem of problems) names.add(problem.displayName ?? problem.name);
  }
  return { count, names: [...names] };
}

export type ManualStepsBadge =
  | { readonly kind: "none" }
  | { readonly kind: "count"; readonly count: number; readonly moneyDecisions: number }
  | {
      readonly kind: "failed";
      readonly reason: Extract<ManualStepsView, { status: "failed" }>["reason"];
    };

export function manualStepsBadge(view: ManualStepsView | null): ManualStepsBadge {
  if (view?.status === "failed") return { kind: "failed", reason: view.reason };
  // Detected steps still list while ThreadPage fails; the failure must not hide behind them.
  if (view?.status === "listed" && view.threadPageIssue !== undefined) {
    return { kind: "failed", reason: view.threadPageIssue };
  }
  if (view?.status !== "listed" || view.count === 0) return { kind: "none" };
  const moneyDecisions = view.groups.reduce(
    (total, group) => total + group.steps.filter((step) => step.kind === "needs-you").length,
    0,
  );
  return { kind: "count", count: view.count, moneyDecisions };
}

export interface BrokenProvider {
  readonly name: string;
  readonly environmentLabel: string;
}

/** Installed, enabled providers that report an error or need a sign-in. Never-installed ones are noise. */
export function brokenProviders(
  environments: ReadonlyArray<{
    readonly environmentLabel: string;
    readonly providers: ReadonlyArray<{ readonly provider: ServerProvider; readonly name: string }>;
  }>,
): ReadonlyArray<BrokenProvider> {
  return environments.flatMap(({ environmentLabel, providers }) =>
    providers
      .filter(
        ({ provider }) =>
          provider.enabled &&
          provider.installed &&
          (deriveProviderStatus(provider).key === "error" ||
            provider.auth.status === "unauthenticated"),
      )
      .map(({ name }) => ({ name, environmentLabel })),
  );
}

/** Every badge the rail may show. A third source would bring back the noise AB#7516 removed. */
export const RAIL_BADGE_SOURCES = ["needs-you", "problems"] as const;
export type RailBadgeSource = (typeof RAIL_BADGE_SOURCES)[number];

export interface RailNeedsYou {
  readonly count: number;
  readonly breakdown: NeedsYouBreakdown;
  readonly moneyDecisions: number;
}

/** What the user must decide: threads waiting on them plus money decisions in manual steps. */
export function railNeedsYou(
  breakdown: NeedsYouBreakdown,
  manualSteps: ManualStepsBadge,
): RailNeedsYou {
  const moneyDecisions = manualSteps.kind === "count" ? manualSteps.moneyDecisions : 0;
  const threads = Object.values(breakdown).reduce((total, n) => total + n, 0);
  return { count: threads + moneyDecisions, breakdown, moneyDecisions };
}

export type RailProblem =
  | { readonly kind: "providers"; readonly providers: ReadonlyArray<BrokenProvider> }
  | { readonly kind: "mcp"; readonly summary: McpProblemSummary }
  | {
      readonly kind: "manual-steps";
      readonly reason: Extract<ManualStepsBadge, { kind: "failed" }>["reason"];
    }
  | { readonly kind: "pull-requests"; readonly pullRequests: PullRequestProblems }
  | { readonly kind: "scheduled-tasks"; readonly failed: number };

/** Failures from every source, most blocking first: a broken provider stops all work. */
export function railProblems(input: {
  readonly providers: ReadonlyArray<BrokenProvider>;
  readonly mcp: McpProblemSummary;
  readonly manualSteps: ManualStepsBadge;
  readonly pullRequests: PullRequestProblems;
  readonly scheduledTaskFailures: number;
}): ReadonlyArray<RailProblem> {
  const problems: Array<RailProblem> = [];
  if (input.providers.length > 0) problems.push({ kind: "providers", providers: input.providers });
  if (input.mcp.count > 0) problems.push({ kind: "mcp", summary: input.mcp });
  if (input.manualSteps.kind === "failed") {
    problems.push({ kind: "manual-steps", reason: input.manualSteps.reason });
  }
  if (input.pullRequests.count > 0) {
    problems.push({ kind: "pull-requests", pullRequests: input.pullRequests });
  }
  if (input.scheduledTaskFailures > 0) {
    problems.push({ kind: "scheduled-tasks", failed: input.scheduledTaskFailures });
  }
  return problems;
}

export function railProblemCount(problems: ReadonlyArray<RailProblem>): number {
  return problems.reduce((total, problem) => {
    switch (problem.kind) {
      case "providers":
        return total + problem.providers.length;
      case "mcp":
        return total + problem.summary.count;
      case "manual-steps":
        return total + 1;
      case "pull-requests":
        return total + problem.pullRequests.count;
      case "scheduled-tasks":
        return total + problem.failed;
    }
  }, 0);
}
