import type { NeedsYouReason } from "@t3tools/client-runtime/state/thread-inbox";
import type { ManualStepsView } from "@t3tools/client-runtime/state/manualSteps";
import type { ProviderMcpProblem } from "@t3tools/client-runtime/state/provider-mcp-problems";
import type { ServerProvider, ThreadPullRequestLink } from "@t3tools/contracts";

import { getProviderStatusKey } from "../settings/providerStatus";

export type NeedsYouBreakdown = Readonly<Record<NeedsYouReason, number>>;

export function countNeedsYouReasons(reasons: ReadonlyArray<NeedsYouReason>): NeedsYouBreakdown {
  const counts = { approval: 0, input: 0, request: 0, failed: 0, limited: 0 };
  for (const reason of reasons) counts[reason] += 1;
  return counts;
}

export interface PullRequestAttention {
  readonly count: number;
  readonly failingChecks: number;
  readonly conflicts: number;
  readonly changesRequested: number;
}

/** Open pull requests whose checks fail, that conflict, or that were sent back for changes. */
export function pullRequestAttention(
  links: ReadonlyArray<ThreadPullRequestLink>,
): PullRequestAttention {
  const seen = new Set<string>();
  const total = { count: 0, failingChecks: 0, conflicts: 0, changesRequested: 0 };
  for (const link of links) {
    const { snapshot } = link;
    if (snapshot === null || snapshot.state !== "open") continue;
    const key = JSON.stringify([link.host, link.repository, link.number]);
    if (seen.has(key)) continue;
    seen.add(key);
    const failingChecks = snapshot.checksState === "failing";
    const conflicts = snapshot.mergeability === "conflicting";
    const changesRequested = snapshot.reviewDecision === "changes-requested";
    if (!failingChecks && !conflicts && !changesRequested) continue;
    total.count += 1;
    total.failingChecks += Number(failingChecks);
    total.conflicts += Number(conflicts);
    total.changesRequested += Number(changesRequested);
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
          (getProviderStatusKey(provider) === "error" ||
            provider.auth.status === "unauthenticated"),
      )
      .map(({ name }) => ({ name, environmentLabel })),
  );
}
