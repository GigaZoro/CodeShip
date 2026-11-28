import {
  providerMcpProblemsKey,
  providerMcpProblemsAtom,
} from "@t3tools/client-runtime/state/provider-mcp-problems";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { threadNeedsYouReason } from "@t3tools/client-runtime/state/thread-inbox";
import { failedScheduledTaskCount } from "@t3tools/client-runtime/scheduled-task-pins";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";

import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import {
  brokenProviders,
  countNeedsYouReasons,
  mcpProblemSummary,
  pullRequestProblems,
  type BrokenProvider,
  type McpProblemSummary,
  type NeedsYouBreakdown,
  type PullRequestProblems,
} from "./sidebarNavRailCounts";

/**
 * Atoms notify by reference, so each summary hands back its previous value while the new one
 * says the same thing; the rail then re-renders only when a count or label changes.
 */
function derivedSummary<T>(label: string, compute: (get: Atom.AtomContext) => T) {
  return Atom.make((get) => {
    const next = compute(get);
    const previous = Option.getOrNull(get.self<T>());
    return previous !== null && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
  }).pipe(Atom.withLabel(`web:sidebar-rail:${label}`));
}

export const needsYouBreakdownAtom = derivedSummary<NeedsYouBreakdown>("needs-you", (get) => {
  const now = new Date().toISOString();
  return countNeedsYouReasons(
    get(environmentThreadShells.needsYouThreadsAtom).threads.flatMap(
      (thread) => threadNeedsYouReason(thread, { now }) ?? [],
    ),
  );
});

export const pullRequestProblemsAtom = derivedSummary<PullRequestProblems>("pull-requests", (get) =>
  pullRequestProblems(
    get(environmentThreadShells.quietThreadShellsAtom).flatMap((thread) =>
      thread.archivedAt === null ? thread.pullRequests : [],
    ),
  ),
);

export const mcpProblemSummaryAtom = derivedSummary<McpProblemSummary>("mcp", (get) => {
  const active = new Set<string>();
  for (const [environmentId, providers] of get(
    environmentPresentations.providersByEnvironmentAtom,
  )) {
    for (const provider of providers) {
      if (provider.enabled) active.add(providerMcpProblemsKey(environmentId, provider.instanceId));
    }
  }
  return mcpProblemSummary(get(providerMcpProblemsAtom), active);
});

export const brokenProvidersAtom = derivedSummary<ReadonlyArray<BrokenProvider>>(
  "providers",
  (get) => {
    const presentations = get(environmentPresentations.presentationsAtom);
    return brokenProviders(
      [...get(environmentPresentations.providersByEnvironmentAtom)].map(
        ([environmentId, providers]) => ({
          environmentLabel:
            presentations.get(environmentId)?.entry.target.label ?? String(environmentId),
          providers: providers.map((provider) => ({
            provider,
            name: resolveProviderInstanceDisplayName(provider),
          })),
        }),
      ),
    );
  },
);

/** Keyed like the sidebar's task atoms, so the rail reads the same live lists. */
export const failedScheduledTaskCountAtom = Atom.family((environmentIdsKey: string) =>
  Atom.make((get) =>
    failedScheduledTaskCount(
      (JSON.parse(environmentIdsKey) as ReadonlyArray<EnvironmentId>).map(
        (environmentId) =>
          AsyncResult.getOrElse(
            get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} })),
            () => null,
          )?.tasks ?? [],
      ),
    ),
  ).pipe(Atom.withLabel(`web:scheduled-task-failures:${environmentIdsKey}`)),
);
