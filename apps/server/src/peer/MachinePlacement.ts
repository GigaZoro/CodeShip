import * as NodeOS from "node:os";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts/baseSchemas";
import {
  type RepositoryIdentity,
  repositoryKeysOf,
  repositoryMatchRank,
} from "@t3tools/contracts/environment";
import type {
  OrchestrationV2AppThread,
  OrchestrationV2LinkOrigin,
} from "@t3tools/contracts/orchestrationV2";
import type {
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpMachineCapacity,
  OrchestratorMcpProviderCapability,
} from "@t3tools/contracts/orchestratorMcp";
import type { PeerLinkSummary } from "@t3tools/contracts/peerLink";
import type { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Tool from "effect/ai/Tool";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type * as ProjectService from "../project/ProjectService.ts";
import type * as HostResources from "../resourceTelemetry/HostResources.ts";
import type * as MemoryAdmission from "../resourceTelemetry/MemoryAdmission.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type * as PeerForwarding from "./PeerForwarding.ts";
import type * as PeerLinks from "./PeerLinks.ts";

const GIB = 1024 ** 3;
const CHECK_SLOT_MEMORY_GIB = 6;
const LANDING_OR_CHECK_COMMAND_PATTERN = /landing-turn\.cjs|check:changed/i;
const READ_ONLY_THREAD_TAGS: ReadonlySet<string> = new Set([
  "plan",
  "review",
  "research",
  "design",
]);
const PEER_PLACEMENT_PROBE_TIMEOUT = Duration.seconds(5);

export interface MachinePlacementCandidate {
  readonly environmentId: EnvironmentId | "local";
  readonly capacity: OrchestratorMcpMachineCapacity;
}

export interface ReadLocalCapacityDeps {
  readonly hostResources: Option.Option<Pick<HostResources.HostResources["Service"], "read">>;
  readonly memoryAdmission: Pick<MemoryAdmission.MemoryAdmission["Service"], "shortage">;
  readonly projections: Option.Option<
    Pick<
      ProjectionStore.ProjectionStoreV2["Service"],
      "getActiveTurnWorkspaces" | "getOpenCommandTasks" | "getThread"
    >
  >;
  readonly projects: Pick<ProjectService.ProjectService["Service"], "getWithRepositoryIdentity">;
}

export interface ResolveAutomaticPlacementInput {
  readonly scope: McpInvocationScope;
  readonly parentProjectId: ProjectId;
  readonly parentWorktreePath?: string | null | undefined;
  readonly parentLinkOrigin?: OrchestrationV2LinkOrigin | undefined;
  readonly inheritedInstanceId: ProviderInstanceId;
  readonly inheritedParentModel: string;
  readonly inheritedAutoAccount?: boolean | undefined;
  readonly hasRoleSelection?: boolean | undefined;
  readonly input: OrchestratorMcpDelegateTaskInput;
  readonly localCapacity:
    | OrchestratorMcpMachineCapacity
    | (() => Effect.Effect<OrchestratorMcpMachineCapacity>);
  readonly peerLinks: Pick<PeerLinks.PeerLinks["Service"], "list">;
  readonly peerForwarding: Pick<
    PeerForwarding.PeerForwarding["Service"],
    "call" | "readCapabilities"
  >;
  readonly projects: Pick<ProjectService.ProjectService["Service"], "getWithRepositoryIdentity">;
  readonly git: Pick<GitVcsDriver.GitVcsDriver["Service"], "execute">;
  readonly probeTimeout?: Duration.Input;
}

const fallbackOnNonInterrupt = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fallback: () => A,
): Effect.Effect<A, never, R> =>
  effect.pipe(
    Effect.orElseSucceed(fallback),
    Effect.catchDefect(() => Effect.sync(fallback)),
  );

function isLandingOrCheckCommand(command: string): boolean {
  return LANDING_OR_CHECK_COMMAND_PATTERN.test(command);
}

function computeCheckSlots(cpuCores: number, availableMemoryBytes: number | null): number {
  const cpuBudget = Math.floor(Math.max(0, cpuCores) / 2);
  const memoryBudget =
    availableMemoryBytes !== null
      ? Math.floor(Math.max(0, availableMemoryBytes) / (CHECK_SLOT_MEMORY_GIB * GIB))
      : cpuBudget;
  return Math.max(1, Math.min(cpuBudget, memoryBudget));
}

function effectiveLoadPressure(capacity: OrchestratorMcpMachineCapacity): number {
  return (
    (capacity.activeThreads + capacity.activeLandingCommands) / Math.max(1, capacity.checkSlots) +
    capacity.loadPerCore
  );
}

function isNonImplementationThread(
  thread: Pick<OrchestrationV2AppThread, "interactionMode" | "reviewAssignment" | "tags">,
): boolean {
  if (thread.interactionMode === "plan") return true;
  if (thread.reviewAssignment !== undefined) return true;
  return thread.tags?.some((tag) => READ_ONLY_THREAD_TAGS.has(tag.trim().toLowerCase())) === true;
}

function finiteNonNegativeOrZero(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

function finiteNonNegativeOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

function readOsFallbackHostMetrics(platform: NodeJS.Platform): {
  readonly loadAverage1m: number;
  readonly cpuCores: number;
  readonly availableMemoryBytes: number | null;
  readonly totalMemoryBytes: number | null;
} {
  const cpuCores = Math.max(0, Math.floor(NodeOS.cpus().length));
  const [one = 0] = platform === "win32" ? [0] : NodeOS.loadavg();
  return {
    loadAverage1m: finiteNonNegativeOrZero(one),
    cpuCores,
    availableMemoryBytes: finiteNonNegativeOrNull(NodeOS.freemem()),
    totalMemoryBytes: finiteNonNegativeOrNull(NodeOS.totalmem()),
  };
}

/**
 * Samples live local host load, memory shortage, active/landing thread counts,
 * and per-repository implementation concurrency for `orchestrator_capabilities`
 * and automatic peer placement.
 */
export const readLocalCapacity = Effect.fn("MachinePlacement.readLocalCapacity")(function* (
  deps: ReadLocalCapacityDeps,
): Effect.fn.Return<OrchestratorMcpMachineCapacity> {
  const platform = yield* HostProcess.Platform;

  const readHostMetrics = Option.isSome(deps.hostResources)
    ? fallbackOnNonInterrupt(
        deps.hostResources.value.read.pipe(
          Effect.map((snapshot) => ({
            loadAverage1m:
              snapshot.loadAverage == null ? 0 : finiteNonNegativeOrZero(snapshot.loadAverage[0]),
            cpuCores: Number.isFinite(snapshot.cpuCount)
              ? Math.max(0, Math.floor(snapshot.cpuCount))
              : 0,
            availableMemoryBytes: finiteNonNegativeOrNull(snapshot.availableMemoryBytes),
            totalMemoryBytes: finiteNonNegativeOrNull(snapshot.totalMemoryBytes),
          })),
        ),
        () => readOsFallbackHostMetrics(platform),
      )
    : Effect.sync(() => readOsFallbackHostMetrics(platform));

  const readShortage = fallbackOnNonInterrupt(deps.memoryAdmission.shortage, () => null);

  const readProjectionCounts = Effect.gen(function* () {
    let activeThreads = 0;
    let activeLandingCommands = 0;
    const activeImplementationThreadsByRepo: Record<string, number> = {};

    if (Option.isNone(deps.projections)) {
      return { activeThreads, activeLandingCommands, activeImplementationThreadsByRepo };
    }

    const store = deps.projections.value;
    const [activeWorkspaces, openCommands] = yield* Effect.all(
      [
        fallbackOnNonInterrupt(store.getActiveTurnWorkspaces(), () => []),
        fallbackOnNonInterrupt(store.getOpenCommandTasks, () => []),
      ],
      { concurrency: "unbounded" },
    );

    const landingCommands = openCommands.filter(
      (task) => task.threadClosed === null && isLandingOrCheckCommand(task.command),
    );
    activeLandingCommands = landingCommands.length;

    const activeThreadIds = new Set<ThreadId>();
    for (const workspace of activeWorkspaces) {
      activeThreadIds.add(workspace.threadId);
    }
    for (const command of landingCommands) {
      activeThreadIds.add(command.parentThreadId);
    }

    if (activeThreadIds.size > 0) {
      const threadEntries = yield* Effect.forEach(
        [...activeThreadIds],
        (threadId) =>
          fallbackOnNonInterrupt(store.getThread(threadId), () => null).pipe(
            Effect.map((thread) => ({ threadId, thread })),
          ),
        { concurrency: "unbounded" },
      );

      // getActiveTurnWorkspaces intentionally includes archived threads; count only live ones.
      const liveThreads = threadEntries.filter(
        (
          entry,
        ): entry is { readonly threadId: ThreadId; readonly thread: OrchestrationV2AppThread } =>
          entry.thread != null && entry.thread.archivedAt == null,
      );
      activeThreads = liveThreads.length;

      const implementationCountByProject = new Map<ProjectId, number>();
      for (const { thread } of liveThreads) {
        if (isNonImplementationThread(thread)) {
          continue;
        }
        implementationCountByProject.set(
          thread.projectId,
          (implementationCountByProject.get(thread.projectId) ?? 0) + 1,
        );
      }

      if (implementationCountByProject.size > 0) {
        const projectEntries = yield* Effect.forEach(
          [...implementationCountByProject.entries()],
          ([projectId, count]) =>
            fallbackOnNonInterrupt(deps.projects.getWithRepositoryIdentity(projectId), () =>
              Option.none(),
            ).pipe(Effect.map((project) => ({ project, count }))),
          { concurrency: "unbounded" },
        );

        for (const { project, count } of projectEntries) {
          if (Option.isNone(project) || project.value.repositoryIdentity == null) continue;
          for (const key of repositoryKeysOf(project.value.repositoryIdentity)) {
            activeImplementationThreadsByRepo[key] =
              (activeImplementationThreadsByRepo[key] ?? 0) + count;
          }
        }
      }
    }

    return { activeThreads, activeLandingCommands, activeImplementationThreadsByRepo };
  });

  const [hostMetrics, shortage, projectionCounts] = yield* Effect.all(
    [readHostMetrics, readShortage, readProjectionCounts],
    { concurrency: "unbounded" },
  );

  const checkSlots = computeCheckSlots(hostMetrics.cpuCores, hostMetrics.availableMemoryBytes);
  const freeCheckSlots = Math.max(0, checkSlots - projectionCounts.activeLandingCommands);
  const loadPerCore = hostMetrics.loadAverage1m / Math.max(1, hostMetrics.cpuCores);

  return {
    loadAverage1m: hostMetrics.loadAverage1m,
    cpuCores: hostMetrics.cpuCores,
    loadPerCore,
    activeThreads: projectionCounts.activeThreads,
    activeLandingCommands: projectionCounts.activeLandingCommands,
    checkSlots,
    freeCheckSlots,
    availableMemoryBytes: hostMetrics.availableMemoryBytes,
    totalMemoryBytes: hostMetrics.totalMemoryBytes,
    memoryShort: shortage !== null,
    activeImplementationThreadsByRepo: projectionCounts.activeImplementationThreadsByRepo,
  };
});

/** Orders candidates least-loaded first: healthy memory, free check slots, lower load pressure, then local/lexicographical tie-break. */
function comparePlacementCandidates(
  a: MachinePlacementCandidate,
  b: MachinePlacementCandidate,
): number {
  if (a.capacity.memoryShort !== b.capacity.memoryShort) {
    return a.capacity.memoryShort ? 1 : -1;
  }
  const aHasFreeSlot = a.capacity.freeCheckSlots > 0;
  const bHasFreeSlot = b.capacity.freeCheckSlots > 0;
  if (aHasFreeSlot !== bHasFreeSlot) {
    return aHasFreeSlot ? -1 : 1;
  }
  const pressureDelta = effectiveLoadPressure(a.capacity) - effectiveLoadPressure(b.capacity);
  if (pressureDelta !== 0) {
    return pressureDelta;
  }
  const aIsLocal = a.environmentId === "local";
  const bIsLocal = b.environmentId === "local";
  if (aIsLocal !== bIsLocal) {
    return aIsLocal ? -1 : 1;
  }
  if (a.environmentId < b.environmentId) return -1;
  if (a.environmentId > b.environmentId) return 1;
  return 0;
}

export function selectLeastLoadedMachine(
  candidates: ReadonlyArray<MachinePlacementCandidate>,
): MachinePlacementCandidate | undefined {
  let best: MachinePlacementCandidate | undefined;
  for (const candidate of candidates) {
    if (best === undefined || comparePlacementCandidates(candidate, best) < 0) {
      best = candidate;
    }
  }
  return best;
}

function isRunnablePeerProvider(provider: OrchestratorMcpProviderCapability): boolean {
  return (
    provider.canRunChildTask && provider.usageLimited !== true && provider.constraints.length === 0
  );
}

function providerOffersModel(
  provider: OrchestratorMcpProviderCapability,
  requestedModel: string,
): boolean {
  const matched = provider.models.find((model) => model.id === requestedModel);
  return matched !== undefined && matched.usageLimited !== true;
}

function peerSatisfiesTarget(
  providers: ReadonlyArray<OrchestratorMcpProviderCapability>,
  target: OrchestratorMcpDelegateTaskInput["target"],
  inherited: {
    readonly instanceId: ProviderInstanceId;
    readonly parentModel: string;
  },
): boolean {
  if (target?.options !== undefined) return false;

  if (target?.providerInstanceId !== undefined) {
    const requestedModel =
      target.model ??
      (target.providerInstanceId === inherited.instanceId ? inherited.parentModel : undefined);
    if (requestedModel === undefined) return false;
    const provider = providers.find(
      (candidate) => candidate.providerInstanceId === target.providerInstanceId,
    );
    if (provider === undefined || !isRunnablePeerProvider(provider)) return false;
    if (target.driverKind !== undefined && provider.driverKind !== target.driverKind) {
      return false;
    }
    return providerOffersModel(provider, requestedModel);
  }

  if (target?.driverKind !== undefined) {
    if (target.model === undefined) return false;
    // Match RemoteDelegation.resolveRemoteInstance's exact selection order.
    const ofDriver = providers.filter((provider) => provider.driverKind === target.driverKind);
    const selected =
      ofDriver.find(
        (provider) => provider.usageLimited !== true && provider.constraints.length === 0,
      ) ?? ofDriver[0];
    if (selected === undefined || !isRunnablePeerProvider(selected)) return false;
    return providerOffersModel(selected, target.model);
  }

  const requestedModel = target?.model ?? inherited.parentModel;
  const provider = providers.find(
    (candidate) => candidate.providerInstanceId === inherited.instanceId,
  );
  if (provider === undefined || !isRunnablePeerProvider(provider)) return false;
  return providerOffersModel(provider, requestedModel);
}

const peerHasUniqueMatchingProject = Effect.fn("MachinePlacement.peerHasUniqueMatchingProject")(
  function* (input: {
    readonly scope: McpInvocationScope;
    readonly environmentId: EnvironmentId;
    readonly parentIdentity: RepositoryIdentity;
    readonly peerForwarding: Pick<PeerForwarding.PeerForwarding["Service"], "call">;
  }) {
    let matchesCount = 0;
    let bestRank = Number.POSITIVE_INFINITY;
    let cursor: number | null = 0;
    while (cursor !== null) {
      const listed: Tool.Success<typeof ProjectToolkit.tools.t3_project_list> =
        yield* input.peerForwarding.call(
          input.scope,
          ProjectToolkit.tools.t3_project_list,
          input.environmentId,
          { cursor, limit: 100 },
        );
      for (const project of listed.projects) {
        const rank = repositoryMatchRank(input.parentIdentity, project.repositoryIdentity);
        if (rank === -1 || rank > bestRank) continue;
        if (rank < bestRank) {
          bestRank = rank;
          matchesCount = 1;
        } else {
          matchesCount += 1;
        }
      }
      cursor = listed.nextCursor;
    }
    return matchesCount === 1;
  },
);

function hasLinkedOrigin(
  scope: McpInvocationScope,
  parentLinkOrigin: OrchestrationV2LinkOrigin | undefined,
): boolean {
  return parentLinkOrigin !== undefined || scope.client?.linked === true;
}

/**
 * Selects the least-loaded linked environment for an unpinned worktree
 * implementation delegate, or returns `undefined` to keep execution local.
 */
export const resolveAutomaticPlacement = Effect.fn("MachinePlacement.resolveAutomaticPlacement")(
  function* (params: ResolveAutomaticPlacementInput): Effect.fn.Return<EnvironmentId | undefined> {
    const {
      scope,
      parentProjectId,
      parentWorktreePath,
      parentLinkOrigin,
      inheritedInstanceId,
      inheritedParentModel,
      inheritedAutoAccount,
      hasRoleSelection,
      input,
      peerLinks,
      peerForwarding,
      projects,
      git,
    } = params;

    // Preserve explicit pinning, local-tree isolation, non-implementation roles, and no multi-hop.
    if (input.target?.environmentId !== undefined) return undefined;
    if (input.target?.projectId !== undefined) return undefined;
    if (hasLinkedOrigin(scope, parentLinkOrigin)) return undefined;
    if (scope.linkedEnvironments === false) return undefined;
    if (input.isolation !== "worktree") return undefined;
    if (input.role !== "implementation") return undefined;
    if (input.routing !== undefined) return undefined;
    if (hasRoleSelection === true) return undefined;
    if (input.target?.options !== undefined) return undefined;
    if (input.auto === true) return undefined;

    const targetNamesProviderOrModel =
      input.target?.providerInstanceId !== undefined ||
      input.target?.driverKind !== undefined ||
      input.target?.model !== undefined;
    if (inheritedAutoAccount === true && input.auto !== false && !targetNamesProviderOrModel) {
      return undefined;
    }
    if (
      input.target?.model === undefined &&
      (input.target?.driverKind !== undefined ||
        (input.target?.providerInstanceId !== undefined &&
          input.target.providerInstanceId !== inheritedInstanceId))
    ) {
      return undefined;
    }

    const links = yield* fallbackOnNonInterrupt(peerLinks.list, () => []);
    const reachablePeers = links.filter(
      (link) =>
        link.status === "reachable" &&
        link.access === "full-access" &&
        link.environmentId !== scope.environmentId,
    );
    if (reachablePeers.length === 0) return undefined;

    const parentProject = yield* fallbackOnNonInterrupt(
      projects.getWithRepositoryIdentity(parentProjectId),
      () => Option.none(),
    );
    const parentIdentity = Option.isSome(parentProject)
      ? (parentProject.value.repositoryIdentity ?? null)
      : null;
    if (Option.isNone(parentProject) || parentIdentity === null) return undefined;

    // Verify locally (no network) that HEAD is contained in at least one remote-tracking branch so
    // a peer worktree starting from HEAD will not fail with ThreadLaunchBaseRefError.
    const parentCwd = parentWorktreePath ?? parentProject.value.workspaceRoot;
    const headIsPushed = yield* fallbackOnNonInterrupt(
      git
        .execute({
          operation: "MachinePlacement.checkHeadPushed",
          cwd: parentCwd,
          args: ["branch", "-r", "--contains", "HEAD"],
        })
        .pipe(Effect.map((result) => result.stdout.trim().length > 0)),
      () => false,
    );
    if (!headIsPushed) return undefined;

    const inherited = { instanceId: inheritedInstanceId, parentModel: inheritedParentModel };
    const probeTimeout = params.probeTimeout ?? PEER_PLACEMENT_PROBE_TIMEOUT;
    const probePeer = Effect.fn("MachinePlacement.probePeer")(
      function* (link: PeerLinkSummary) {
        const capabilities = yield* peerForwarding.readCapabilities(scope, link.environmentId);
        const capacity = capabilities.capacity;
        if (capacity === undefined || capacity.memoryShort) {
          return Option.none<MachinePlacementCandidate>();
        }
        if (!peerSatisfiesTarget(capabilities.providers, input.target, inherited)) {
          return Option.none<MachinePlacementCandidate>();
        }
        const hasUniqueProject = yield* peerHasUniqueMatchingProject({
          scope,
          environmentId: link.environmentId,
          parentIdentity,
          peerForwarding,
        });
        if (!hasUniqueProject) return Option.none<MachinePlacementCandidate>();
        return Option.some<MachinePlacementCandidate>({
          environmentId: link.environmentId,
          capacity,
        });
      },
      Effect.orElseSucceed(Option.none<MachinePlacementCandidate>),
      Effect.timeoutOption(probeTimeout),
      Effect.map(Option.flatten),
    );

    const probed = yield* Effect.forEach(reachablePeers, probePeer, { concurrency: "unbounded" });
    const eligiblePeers = probed.filter(Option.isSome).map((candidate) => candidate.value);
    if (eligiblePeers.length === 0) return undefined;

    const localCapacity =
      typeof params.localCapacity === "function"
        ? yield* params.localCapacity()
        : params.localCapacity;

    const winner = selectLeastLoadedMachine([
      { environmentId: "local", capacity: localCapacity },
      ...eligiblePeers,
    ]);
    return winner === undefined || winner.environmentId === "local"
      ? undefined
      : winner.environmentId;
  },
);
