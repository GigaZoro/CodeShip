import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  backgroundWorkHoldsCompletion,
  isPullRequestWatchTask,
  turnItemUpdateCanEndBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import {
  CommandId,
  isListedThreadLineage,
  isOrchestrationV2WorkActive,
  type ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { linkCreatedPullRequest } from "../git/linkCreatedPullRequest.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { makeNoPullRequestRechecks } from "./noPullRequestRechecks.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { QUIET_AFTER_MS, QUIET_SYNC_INTERVAL_MS } from "./PullRequestSyncReactor.ts";
import { withGitSpawnBudget } from "../vcs/GitSpawnBudget.ts";

export interface SettlementPullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
// A thread kept active for unmerged work is rechecked this often, not on every sweep.
const UNMERGED_WORK_RECHECK_MS = HOUR_MS;
// Each attempt can run text generation for a commit and pull request, so failures back off.
const UNMERGED_WORK_RETRY_AFTER_FAILURE_MS = 6 * HOUR_MS;
// Each git spawn blocks the server's main thread on Windows, so a sweep stays far below this.
const SETTLEMENT_SWEEP_SPAWN_BUDGET = 150;
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

/**
 * Open a pull request for a worktree's unmerged work, or keep the thread active. Keeping it active
 * holds the check for every thread on the worktree, or for this thread only.
 */
type UnmergedWorkAction =
  | "open-pull-request"
  | "keep-worktree-active"
  | "keep-thread-active"
  // A delivered subagent's work lands as its delegating agent decides: no pull request lookup or action.
  | "keep-for-delegator";

function toMillis(value: DateTime.Utc | null | undefined): number | null {
  return value == null ? null : DateTime.toEpochMillis(value);
}

function latestMillis(values: ReadonlyArray<number | null>): number | null {
  let latest: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (latest === null || value > latest) latest = value;
  }
  return latest;
}

function threadActivityAtMs(thread: SettlementRuleThread): number {
  return (
    latestMillis([
      toMillis(thread.latestUserMessageAt),
      toMillis(thread.latestRunRequestedAt),
      toMillis(thread.latestRunStartedAt),
      toMillis(thread.latestRunCompletedAt),
    ]) ?? DateTime.toEpochMillis(thread.createdAt)
  );
}

function pullRequestMatchesProject(
  pullRequest: GitManager.GitBranchPullRequest,
  project: {
    readonly repositoryIdentity?: { readonly canonicalKey: string } | null | undefined;
  },
): boolean {
  return (
    pullRequest.repositoryKey !== null &&
    project.repositoryIdentity != null &&
    sourceControlDefinitions.canonicalRepositoryKey(pullRequest.repositoryKey) ===
      sourceControlDefinitions.canonicalRepositoryKey(project.repositoryIdentity.canonicalKey)
  );
}

type SettlementPullRequestLink = NonNullable<
  ProjectionStore.ProjectionSettlementCandidate["pullRequests"]
>[number];

/** When the linked pull request merged or closed, or -Infinity if it has not. */
function linkTerminalAtMs(link: SettlementPullRequestLink): number {
  const snapshot = link.snapshot;
  const value = snapshot?.state === "merged" ? snapshot.mergedAt : snapshot?.closedAt;
  const timestamp = Date.parse(value ?? "");
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

/** Exclude links added after merge or close; they record completed work rather than outcomes this thread awaits. */
function settlementPullRequestLinks(
  links: ReadonlyArray<SettlementPullRequestLink>,
): ReadonlyArray<SettlementPullRequestLink> {
  return visibleThreadPullRequests(links).filter((link) => {
    if (link.snapshot === null || link.snapshot.state === "open") return true;
    const linkedAtMs = Date.parse(link.linkedAt);
    return Number.isNaN(linkedAtMs) || linkTerminalAtMs(link) >= linkedAtMs;
  });
}

/** Absolute age bounds clock skew in both directions and expires stale pre-adoption data. */
export function threadHasQueuedTurnStart(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "latestUserMessageAt"
    | "latestRunRequestedAt"
    | "latestRunStartedAt"
    | "latestRunCompletedAt"
    | "latestRunId"
    | "status"
  >,
  nowMs: number,
): boolean {
  const messageAtMs = toMillis(thread.latestUserMessageAt);
  if (messageAtMs === null || thread.status === "failed") return false;
  const age = nowMs - messageAtMs;
  if (Number.isNaN(age) || Math.abs(age) > QUEUED_TURN_START_GRACE_MS) return false;
  if (thread.latestRunId === null) return true;
  return [
    toMillis(thread.latestRunRequestedAt),
    toMillis(thread.latestRunStartedAt),
    toMillis(thread.latestRunCompletedAt),
  ].every((value) => value === null || value < messageAtMs);
}

function pullRequestSettles(
  thread: Pick<
    ProjectionStore.ProjectionSettlementCandidate,
    "createdAt" | "latestUserAuthoredMessageAt"
  >,
  pullRequest: SettlementPullRequest,
  autoSettleOnMerge: boolean,
): boolean {
  // A closed pull request settles under the same per-project rule as a merged one.
  if (!autoSettleOnMerge || pullRequest.state === "open") return false;
  const terminalAt = pullRequest.state === "merged" ? pullRequest.mergedAt : pullRequest.closedAt;
  if (terminalAt == null) return false;
  const userAnchorMs = latestMillis([
    toMillis(thread.createdAt),
    toMillis(thread.latestUserAuthoredMessageAt),
  ]);
  if (userAnchorMs === null) return false;
  const pullRequestAtMs = Date.parse(terminalAt);
  if (Number.isNaN(pullRequestAtMs)) return false;
  return pullRequestAtMs >= userAnchorMs;
}

/** Drops holds that have run out, so threads and worktrees that are gone leave memory. */
export function dropExpiredHolds<K>(holds: Map<K, number>, nowMs: number): void {
  for (const [key, untilMs] of holds) if (untilMs <= nowMs) holds.delete(key);
}

/** The fields the inactivity and pull request rules read; delegated children add their parent's. */
type ScheduledSettlementFields = "startedByScheduledTask" | "hasPendingScheduledWork";
type SettlementRuleThread = Omit<
  ProjectionStore.ProjectionSettlementCandidate,
  "parentWorktreePath" | "parentResultAt" | "parentDone" | ScheduledSettlementFields
>;

export function isAutoSettlementCandidate(
  thread: Omit<SettlementRuleThread, "latestUserAuthoredMessageAt">,
  nowMs: number,
): boolean {
  if (thread.archivedAt !== null || thread.settledOverride !== null) return false;
  if (thread.pinnedAt != null || thread.autoSettleDisabledAt != null) return false;
  if (thread.pendingRuntimeRequest !== null) return false;
  // A guest is waiting on the owner; settling would hide the Request.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return false;
  if (thread.activityRunStatus != null) return false;
  const pendingTasks = thread.pendingBackgroundTasks ?? [];
  if (backgroundWorkHoldsCompletion(pendingTasks)) return false;
  // Settling ends a watch, which would silently drop a reviewer's later comments.
  if (pendingTasks.some(isPullRequestWatchTask)) return false;
  if (threadHasQueuedTurnStart(thread, nowMs)) return false;
  // Interrupted runs must keep the same snooze protection the sidebar shows.
  return !isSnoozed(thread, nowMs);
}

/** Match client effectiveSnoozed so agents and sidebar agree. */
export function isSnoozed(
  thread: Pick<
    ProjectionStore.ProjectionSettlementCandidate,
    | "snoozedUntil"
    | "snoozedAt"
    | "latestRunCompletedAt"
    | "status"
    | "pendingRuntimeRequest"
    | "pendingGuestMessageCount"
  >,
  nowMs: number,
): boolean {
  const snoozedUntilMs = toMillis(thread.snoozedUntil);
  if (snoozedUntilMs === null || snoozedUntilMs <= nowMs) return false;
  // Same as the client: a waiting guest message wakes the thread, and the snooze stays stored.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return false;
  const snoozedAtMs = toMillis(thread.snoozedAt);
  if (
    thread.pendingRuntimeRequest !== null &&
    (thread.pendingRuntimeRequest.kind !== "user_input" ||
      snoozedAtMs === null ||
      DateTime.toEpochMillis(thread.pendingRuntimeRequest.createdAt) > snoozedAtMs)
  ) {
    return false;
  }
  const completedAtMs = toMillis(thread.latestRunCompletedAt);
  const wokeOnError =
    thread.status === "failed" &&
    (snoozedAtMs === null || (completedAtMs !== null && completedAtMs > snoozedAtMs));
  return !wokeOnError;
}

/**
 * A subagent or side chat in its parent's worktree leaves the worktree to the parent, as storage
 * cleanup does: the parent keeps its unmerged work in view and runs its settle action.
 */
function sharesParentWorktree(
  thread: Pick<
    ProjectionStore.ProjectionSettlementCandidate,
    "lineage" | "worktreePath" | "parentWorktreePath"
  >,
): boolean {
  return (
    thread.worktreePath !== null &&
    thread.worktreePath === thread.parentWorktreePath &&
    !isListedThreadLineage(thread.lineage)
  );
}

/**
 * A subagent whose parent holds the result of its latest task, with no run of its own since, has
 * nothing left to do, whatever the inactivity and merge settings say. It settles at the run that
 * produced the result, or at the result for a provider-native subagent, which has no runs.
 */
function deliveredChildSettlementAt(
  thread: ProjectionStore.ProjectionSettlementCandidate,
  nowMs: number,
): DateTime.Utc | null {
  const resultAtMs = toMillis(thread.parentResultAt);
  if (thread.lineage.relationshipToParent !== "subagent" || resultAtMs === null) return null;
  if (!isAutoSettlementCandidate(thread, nowMs)) return null;
  // A watched pull request will still wake the child.
  if ((thread.pullRequests ?? []).some((link) => link.watch !== undefined)) return null;
  if (thread.latestRunId === null) return thread.parentResultAt;
  const ranAt = thread.latestRunCompletedAt;
  if (thread.status !== "completed" || ranAt == null) return null;
  return DateTime.toEpochMillis(ranAt) <= resultAtMs ? ranAt : null;
}

export function resolveAutoSettlementAt(input: {
  readonly thread: SettlementRuleThread &
    Partial<Pick<ProjectionStore.ProjectionSettlementCandidate, ScheduledSettlementFields>>;
  readonly pullRequest: SettlementPullRequest | null;
  readonly nowMs: number;
  readonly autoSettleAfterDays: number | null;
  readonly autoSettleOnMerge: boolean;
  readonly autoSettleScheduledThreads?: boolean;
  readonly autoSettleLegacyRules?: boolean;
  readonly autoSettleKeepPullRequests?: boolean;
}): DateTime.Utc | null {
  const { thread } = input;
  let pullRequest = input.pullRequest;
  const links = settlementPullRequestLinks(thread.pullRequests ?? []);
  if (links.some((link) => link.snapshot === null)) return null;
  // An open link means the pull request has not finished, so only inactivity
  // can settle the thread, never a merged or closed lookup.
  const hasOpenLink = links.some((link) => link.snapshot?.state === "open");
  // A watched merge has not woken the agent yet; its watch clears in the same command as that wake.
  const awaitsMergeWake = links.some(
    (link) => link.snapshot?.state === "merged" && link.watch !== undefined,
  );
  if (hasOpenLink) {
    pullRequest = null;
  } else if (links.length > 0) {
    const latest = links.reduce((current, candidate) =>
      linkTerminalAtMs(candidate) > linkTerminalAtMs(current) ? candidate : current,
    );
    pullRequest =
      latest.snapshot === null
        ? null
        : {
            state: latest.snapshot.state,
            mergedAt: latest.snapshot.mergedAt ?? null,
            closedAt: latest.snapshot.closedAt ?? null,
          };
  }
  if (!isAutoSettlementCandidate(thread, input.nowMs)) return null;
  const activityAtMs = threadActivityAtMs(thread);
  const hasPullRequest =
    hasOpenLink ||
    pullRequest !== null ||
    thread.linkedPullRequest != null ||
    thread.branchPullRequest != null;
  if (
    input.autoSettleScheduledThreads === true &&
    thread.startedByScheduledTask &&
    thread.lineage.parentThreadId === null &&
    thread.status === "completed" &&
    thread.hasPendingScheduledWork === false &&
    !hasOpenLink &&
    !(thread.pullRequests ?? []).some((link) => link.watch !== undefined) &&
    pullRequest?.state !== "open" &&
    (!hasPullRequest || pullRequest !== null)
  ) {
    return thread.latestRunCompletedAt ?? null;
  }
  if (input.autoSettleLegacyRules === false) return null;
  if (
    pullRequest !== null &&
    !awaitsMergeWake &&
    pullRequestSettles(thread, pullRequest, input.autoSettleOnMerge)
  ) {
    return DateTime.makeUnsafe(activityAtMs);
  }
  if (input.autoSettleKeepPullRequests === true && hasPullRequest) return null;
  if (input.autoSettleAfterDays === null) return null;
  const snoozedUntilMs = toMillis(thread.snoozedUntil);
  const timerWakeAtMs =
    snoozedUntilMs !== null && snoozedUntilMs <= input.nowMs ? snoozedUntilMs : null;
  const inactivityAtMs =
    latestMillis([activityAtMs, toMillis(thread.lastSnoozeWakeAt), timerWakeAtMs]) ?? activityAtMs;
  return inactivityAtMs < input.nowMs - input.autoSettleAfterDays * DAY_MS
    ? DateTime.makeUnsafe(inactivityAtMs)
    : null;
}

export class ThreadSettlementServiceV2 extends Context.Service<
  ThreadSettlementServiceV2,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadSettlementService/ThreadSettlementServiceV2") {}

function autoSettlementConfigured(settings: import("@t3tools/contracts").ServerSettings): boolean {
  if (settings.sidebarAutoSettleOnMerge || settings.sidebarAutoSettleAfterDays !== null) {
    return true;
  }
  return Object.values(settings.projectSettingsOverrides).some(
    (entry) =>
      entry.sidebarAutoSettleOnMerge === true ||
      (entry.sidebarAutoSettleAfterDays !== undefined && entry.sidebarAutoSettleAfterDays !== null),
  );
}

/** @internal Exported for tests. */
export function autoSettlementSettingsKey(
  settings: import("@t3tools/contracts").ServerSettings,
): string {
  return JSON.stringify([
    settings.sidebarAutoSettleScheduledThreads,
    settings.sidebarAutoSettleOnMerge,
    settings.sidebarAutoSettleAfterDays,
    settings.sidebarAutoSettleKeepPullRequests,
    settings.sidebarAutoSettleOpensPullRequests,
    Object.entries(settings.projectSettingsOverrides)
      .filter(
        ([, entry]) =>
          entry.sidebarAutoSettleScheduledThreads !== undefined ||
          entry.sidebarAutoSettleOnMerge !== undefined ||
          entry.sidebarAutoSettleAfterDays !== undefined ||
          entry.sidebarAutoSettleKeepPullRequests !== undefined ||
          entry.sidebarAutoSettleOpensPullRequests !== undefined,
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([projectId, entry]) => [
        projectId,
        entry.sidebarAutoSettleScheduledThreads ?? "inherit",
        entry.sidebarAutoSettleOnMerge ?? "inherit",
        entry.sidebarAutoSettleAfterDays === undefined
          ? "inherit"
          : entry.sidebarAutoSettleAfterDays,
        entry.sidebarAutoSettleKeepPullRequests ?? "inherit",
        entry.sidebarAutoSettleOpensPullRequests ?? "inherit",
      ]),
  ]);
}

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitManager.GitManager;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectService = yield* ProjectService.ProjectService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A shell merge or close sends no event, and the branch lookup caches an open pull request for
  // a minute, so these threads' next lookup reads the host fresh.
  const shellClosedThreads = new Set<ThreadId>();
  // Each summary read can be a host CLI process (one `az` per read on Azure DevOps), so a quiet
  // open pull request is read on the sync reactor's quiet cadence rather than every sweep.
  const quietOpenReadAt = new Map<string, number>();
  const quietReadKey = (reference: {
    readonly projectId: string;
    readonly repository: string;
    readonly number: number;
  }) => `${reference.projectId}\0${reference.repository.toLowerCase()}\0${reference.number}`;
  // A host can finish a merge minutes after the app's merge action and its refresh, and Azure's
  // updatedAt never moves while open, so pull requests stay on the fast cadence for a while after.
  // Sweeps that started before the pause fail the same check, so their reads record nothing.
  let quietPausedAtMs = Number.NEGATIVE_INFINITY;
  const pauseQuietReads = Effect.fn("ThreadSettlementServiceV2.pauseQuietReads")(function* () {
    quietPausedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
    quietOpenReadAt.clear();
  });
  const terminals = yield* TerminalManager.TerminalManager;
  const projectScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  // Repeated thread.settled retains settledAt; run the action only once per settlement.
  const settleActionRunAt = new Map<ThreadId, number>();
  // Keyed by worktree path: the unmerged work belongs to the worktree, whichever thread found it.
  const unmergedWorkHeldUntilMs = new Map<string, number>();
  // A thread the user never wrote in may not open a pull request, so it holds only itself: its
  // hold must not keep a thread on the same worktree that may open one from opening it.
  const threadsHeldUntilMs = new Map<ThreadId, number>();
  // A worktree another thread or sweep is checking counts as held until that check sets its hold.
  const worktreesBeingChecked = new Set<string>();
  const holdsUnmergedWork = (cwd: string, nowMs: number) =>
    (unmergedWorkHeldUntilMs.get(cwd) ?? 0) > nowMs || worktreesBeingChecked.has(cwd);
  const holdsThread = (threadId: ThreadId, nowMs: number) =>
    (threadsHeldUntilMs.get(threadId) ?? 0) > nowMs;
  const holdUnmergedWork = (
    threadId: ThreadId,
    cwd: string,
    action: UnmergedWorkAction,
    untilMs: number,
  ) => {
    if (action === "keep-thread-active" || action === "keep-for-delegator")
      threadsHeldUntilMs.set(threadId, untilMs);
    else unmergedWorkHeldUntilMs.set(cwd, untilMs);
  };

  const checkUnmergedWork = Effect.fnUntraced(function* (
    thread: ProjectionStore.ProjectionSettlementCandidate,
    cwd: string,
    action: UnmergedWorkAction,
    nowMs: number,
  ) {
    const hold = (durationMs: number) => {
      holdUnmergedWork(thread.id, cwd, action, nowMs + durationMs);
      return false;
    };
    const release = () => {
      unmergedWorkHeldUntilMs.delete(cwd);
      threadsHeldUntilMs.delete(thread.id);
      return true;
    };
    const work = yield* gitWorkflow.unmergedWork({ cwd });
    if (work.changedFileCount === 0 && work.unmergedCommitCount === 0) {
      return release();
    }
    const pullRequest =
      work.refName === null || action === "keep-for-delegator"
        ? null
        : yield* git.branchPullRequest({ cwd, branch: work.refName }, { freshGitState: true });
    // A pull request accounts for the commits up to its head: an open one ships them and a closed
    // one set them aside on purpose. Work made after its head is in no pull request yet.
    if (
      (pullRequest?.state === "open" || pullRequest?.state === "closed") &&
      work.changedFileCount === 0 &&
      pullRequest.headSha
    ) {
      // A head pushed from elsewhere may be missing here, so the work stays unaccounted for.
      const outsidePullRequest = yield* gitWorkflow
        .countUnmergedCommits({ cwd, baseRef: pullRequest.headSha })
        .pipe(Effect.orElseSucceed(() => null));
      if (outsidePullRequest === 0) return release();
    }
    // The user closed that pull request, so a new one for the same branch is theirs to open.
    if (pullRequest?.state === "closed") return hold(UNMERGED_WORK_RECHECK_MS);
    if (
      action !== "open-pull-request" ||
      work.refName === null ||
      !(yield* gitWorkflow.localStatus({ cwd })).hasPrimaryRemote
    ) {
      return hold(UNMERGED_WORK_RECHECK_MS);
    }
    const uuid = yield* random.uuidV4();
    const opened = yield* gitWorkflow
      .runStackedAction({
        actionId: `auto-settle:${thread.id}:${uuid}`,
        cwd,
        action: "commit_push_pr",
        threadId: thread.id,
        projectId: thread.projectId,
      })
      .pipe(
        Effect.tap((result) =>
          linkCreatedPullRequest({
            threadId: thread.id,
            result,
            commandId: Effect.succeed(CommandId.make(`server:auto-settle-pr:${thread.id}:${uuid}`)),
          }),
        ),
        Effect.as(true),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("opening a pull request before automatic settlement failed", {
              threadId: thread.id,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
        ),
        Effect.provideService(Orchestrator.OrchestratorV2, orchestrator),
        Effect.provideService(ProjectService.ProjectService, projectService),
      );
    if (!opened) return hold(UNMERGED_WORK_RETRY_AFTER_FAILURE_MS);
    unmergedWorkHeldUntilMs.delete(cwd);
    return false;
  });

  /**
   * False keeps the thread active so its worktree's unmerged work stays in view. That work gets a
   * pull request first when the setting allows and the user wrote in the thread; the link it adds
   * sweeps the thread again.
   */
  const releasesUnmergedWork = Effect.fnUntraced(function* (
    thread: ProjectionStore.ProjectionSettlementCandidate,
    opensPullRequests: boolean,
    deliveredToParent: boolean,
    nowMs: number,
  ) {
    const cwd = thread.worktreePath;
    if (cwd === null || !(yield* fileSystem.exists(cwd))) return true;
    if (holdsThread(thread.id, nowMs) || holdsUnmergedWork(cwd, nowMs)) return false;
    worktreesBeingChecked.add(cwd);
    return yield* Effect.gen(function* () {
      // Only a thread the user wrote in is theirs to publish; agents and scheduled tasks decide how
      // the work of the threads they started lands.
      const action: UnmergedWorkAction = deliveredToParent
        ? "keep-for-delegator"
        : !opensPullRequests
          ? "keep-worktree-active"
          : (yield* projections.hasUserWrittenMessage(thread.id))
            ? "open-pull-request"
            : "keep-thread-active";
      return yield* checkUnmergedWork(thread, cwd, action, nowMs).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("checking unmerged work before automatic settlement failed", {
              threadId: thread.id,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  holdUnmergedWork(thread.id, cwd, action, nowMs + UNMERGED_WORK_RECHECK_MS);
                  return false;
                }),
              ),
            ),
        ),
      );
    }).pipe(Effect.ensuring(Effect.sync(() => worktreesBeingChecked.delete(cwd))));
  });
  const noPullRequestRechecks = makeNoPullRequestRechecks();

  const sweep = Effect.fn("ThreadSettlementServiceV2.sweep")(function* (
    mergedPullRequest: PullRequestService.PullRequestMergeEvent | null,
    threadId?: ThreadId,
  ) {
    // A thread that is not a candidate now (still running) must not keep a merged PR's quiet entry.
    if (mergedPullRequest !== null) yield* pauseQuietReads();
    const settings = yield* settingsService.getSettings;
    // Subagents settle with their parent or on their result even when no inactivity or merge rule is on.
    const automaticSettlementEnabled = autoSettlementConfigured(settings);
    if (threadId === undefined) {
      // An archived, deleted or hand-settled thread is no candidate, so only this drops its hold.
      const sweptAtMs = DateTime.toEpochMillis(yield* DateTime.now);
      dropExpiredHolds(unmergedWorkHeldUntilMs, sweptAtMs);
      dropExpiredHolds(threadsHeldUntilMs, sweptAtMs);
    }
    const readCandidates = projections.getSettlementCandidates(threadId);
    const threads = yield* threadId === undefined
      ? NodeSqliteClient.inBackground(readCandidates)
      : readCandidates;
    if (threads.length === 0) return;
    const projectShells = yield* projectStore.listShells();
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const projects = new Map(projectShells.map((project) => [project.id, project]));
    for (const [key, readAtMs] of quietOpenReadAt) {
      if (nowMs - readAtMs >= QUIET_SYNC_INTERVAL_MS) quietOpenReadAt.delete(key);
    }
    // Merge events resweep all candidates because unlinked threads settle through branch lookup.
    const candidates = threads.filter(
      (thread) =>
        (automaticSettlementEnabled ||
          thread.lineage.relationshipToParent === "subagent" ||
          (thread.startedByScheduledTask &&
            thread.status === "completed" &&
            !thread.hasPendingScheduledWork &&
            resolveProjectSettings(settings, thread.projectId).settings
              .sidebarAutoSettleScheduledThreads)) &&
        isAutoSettlementCandidate(thread, nowMs),
    );

    // Runs per candidate thread, thousands per sweep on busy servers; the sweep owns the span.
    const settleThread = Effect.fnUntraced(
      function* (thread: (typeof candidates)[number], pullRequest: SettlementPullRequest | null) {
        const decisionNowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const deliveredAt = deliveredChildSettlementAt(thread, decisionNowMs);
        // The store returns a subagent only once its parent is done or holds its result. One whose
        // parent is done settles with the parent and never runs its own lookup; a result it
        // delivered still dates the settle.
        const subagent = thread.lineage.relationshipToParent === "subagent";
        const settlesWithParent = subagent && thread.parentDone;
        if (subagent && !settlesWithParent && deliveredAt === null) return null;
        let settledAt = deliveredAt;
        if (!settlesWithParent) {
          // thread.auto-settle does not recheck settings, so read them per decision; reads are cached.
          const currentSettings = resolveProjectSettings(
            yield* settingsService.getSettings,
            thread.projectId,
          ).settings;
          settledAt ??= resolveAutoSettlementAt({
            thread,
            pullRequest,
            nowMs: decisionNowMs,
            autoSettleAfterDays: currentSettings.sidebarAutoSettleAfterDays,
            autoSettleOnMerge: currentSettings.sidebarAutoSettleOnMerge,
            autoSettleScheduledThreads: currentSettings.sidebarAutoSettleScheduledThreads,
            autoSettleLegacyRules: automaticSettlementEnabled,
            autoSettleKeepPullRequests: currentSettings.sidebarAutoSettleKeepPullRequests,
          });
          if (settledAt === null) return thread;
          if (
            !sharesParentWorktree(thread) &&
            !(yield* releasesUnmergedWork(
              thread,
              currentSettings.sidebarAutoSettleOpensPullRequests,
              deliveredAt !== null,
              decisionNowMs,
            ))
          ) {
            return null;
          }
        }
        const uuid = yield* random.uuidV4();
        // Its own prefix keeps settles on delivery apart from the other rules' settles.
        const rule = deliveredAt === null ? "auto-settle" : "settle-delivered-child";
        yield* orchestrator.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make(`server:${rule}:${thread.id}:${uuid}`),
          threadId: thread.id,
          snapshotAt: thread.updatedAt,
          ...(settledAt === null ? {} : { settledAt }),
          // Without it the recheck needs the parent still done, so a reopened parent keeps the child.
          ...(deliveredAt === null || settlesWithParent || thread.parentResultAt === null
            ? {}
            : { parentResultAt: thread.parentResultAt }),
        });
        return null;
      },
      (effect, thread) =>
        effect.pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("automatic thread settlement skipped", {
                threadId: thread.id,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(null)),
          ),
        ),
    );

    const lookupCandidates = (yield* Effect.forEach(
      candidates,
      (thread) => {
        if (thread.lineage.relationshipToParent === "subagent") return settleThread(thread, null);
        const projectSettings = resolveProjectSettings(settings, thread.projectId).settings;
        // Skip no-op decisions; actual settlement still reads fresh settings before dispatch.
        const settledAt = resolveAutoSettlementAt({
          thread,
          pullRequest: null,
          nowMs,
          autoSettleAfterDays: projectSettings.sidebarAutoSettleAfterDays,
          autoSettleOnMerge: projectSettings.sidebarAutoSettleOnMerge,
          autoSettleScheduledThreads: projectSettings.sidebarAutoSettleScheduledThreads,
          autoSettleLegacyRules: automaticSettlementEnabled,
          autoSettleKeepPullRequests: projectSettings.sidebarAutoSettleKeepPullRequests,
        });
        return settledAt === null ? Effect.succeed(thread) : settleThread(thread, null);
      },
      { concurrency: 8 },
    ))
      .filter((thread) => thread !== null)
      .filter((thread) => visibleThreadPullRequests(thread.pullRequests ?? []).length === 0)
      .filter(
        (thread) =>
          thread.branch !== null ||
          thread.linkedPullRequest != null ||
          thread.branchPullRequest != null,
      );
    const lookupCwdByThreadId = new Map<string, string>();
    yield* Effect.forEach(
      lookupCandidates,
      (thread) =>
        Effect.gen(function* () {
          const project = projects.get(thread.projectId);
          if (project === undefined || thread.branch === null) return;
          // A worktree folder can outlive its .git, and git there fails with not_a_repository.
          // An unreadable .git keeps the worktree, so git fails there and the thread is skipped.
          lookupCwdByThreadId.set(
            thread.id,
            thread.worktreePath !== null &&
              (yield* fileSystem
                .exists(path.join(thread.worktreePath, ".git"))
                .pipe(Effect.orElseSucceed(() => true)))
              ? thread.worktreePath
              : project.workspaceRoot,
          );
        }),
      { concurrency: 8, discard: true },
    );
    if (mergedPullRequest !== null) {
      // Invalidate checkout caches on merge; cached open branches would delay settlement beyond this sweep.
      const cwds = [...new Set(lookupCwdByThreadId.values())];
      yield* Effect.forEach(cwds, (cwd) => git.invalidateStatus(cwd), {
        concurrency: 8,
        discard: true,
      });
    }
    const lookupKey = (thread: (typeof lookupCandidates)[number]) => {
      const reference = thread.linkedPullRequest ?? thread.branchPullRequest;
      if (reference != null) {
        return JSON.stringify([
          "linked",
          reference.projectId,
          reference.repository,
          reference.number,
          lookupCwdByThreadId.get(thread.id),
          thread.branch,
        ]);
      }
      if (thread.branch === null) return JSON.stringify(["none", thread.id]);
      const cwd = lookupCwdByThreadId.get(thread.id);
      return JSON.stringify(
        cwd === undefined ? ["missing-project", thread.id] : ["branch", cwd, thread.branch],
      );
    };
    // A held worktree cannot settle before its hold ends; looking up its branch would only start git.
    const unheldCandidates = lookupCandidates.filter(
      (thread) =>
        thread.worktreePath === null ||
        lookupCwdByThreadId.get(thread.id) !== thread.worktreePath ||
        (!holdsThread(thread.id, nowMs) && !holdsUnmergedWork(thread.worktreePath, nowMs)),
    );
    const groups = Map.groupBy(unheldCandidates, lookupKey);

    // wouldSettle and pullRequestFor run per lookup group; the git and pull request reads they make carry the spans.
    const wouldSettle = Effect.fnUntraced(function* (
      group: ReadonlyArray<(typeof lookupCandidates)[number]>,
      pullRequest: SettlementPullRequest,
    ) {
      const currentSettings = yield* settingsService.getSettings;
      const decisionNow = yield* DateTime.now;
      return group.some((thread) => {
        const { settings } = resolveProjectSettings(currentSettings, thread.projectId);
        return (
          resolveAutoSettlementAt({
            thread,
            pullRequest,
            nowMs: DateTime.toEpochMillis(decisionNow),
            autoSettleAfterDays: settings.sidebarAutoSettleAfterDays,
            autoSettleOnMerge: settings.sidebarAutoSettleOnMerge,
            autoSettleScheduledThreads: settings.sidebarAutoSettleScheduledThreads,
            autoSettleLegacyRules: automaticSettlementEnabled,
            autoSettleKeepPullRequests: settings.sidebarAutoSettleKeepPullRequests,
          }) !== null
        );
      });
    });

    const pullRequestFor = Effect.fnUntraced(function* (
      group: ReadonlyArray<(typeof lookupCandidates)[number]>,
    ) {
      const thread = group[0]!;
      const reference = thread.linkedPullRequest ?? thread.branchPullRequest;
      if (reference != null) {
        // Only matching PR links settle from this merge event; unrelated links require fresh lookup.
        const matchesMerge =
          mergedPullRequest !== null &&
          reference.projectId === mergedPullRequest.projectId &&
          reference.repository.toLowerCase() === mergedPullRequest.repository.toLowerCase() &&
          reference.number === mergedPullRequest.number;
        if (!matchesMerge && !projects.has(reference.projectId)) {
          return yield* Effect.die(new Error("linked pull request project not found"));
        }
        const readKey = quietReadKey(reference);
        const shellClosed =
          group.filter((member) => shellClosedThreads.delete(member.id)).length > 0;
        if (shellClosed) quietOpenReadAt.delete(readKey);
        else if (!matchesMerge && quietOpenReadAt.has(readKey)) {
          return { state: "open", closedAt: null, mergedAt: null } satisfies SettlementPullRequest;
        }
        const summary = matchesMerge
          ? ({
              state: "merged",
              closedAt: null,
              mergedAt: mergedPullRequest.mergedAt,
            } satisfies SettlementPullRequest)
          : yield* pullRequests.summary(
              {
                projectId: reference.projectId,
                repository: reference.repository,
                number: reference.number,
              },
              { recoverTransientFailure: false, bypassCache: shellClosed },
            );
        if (
          "updatedAt" in summary &&
          summary.state === "open" &&
          nowMs - quietPausedAtMs >= QUIET_SYNC_INTERVAL_MS &&
          nowMs - Date.parse(summary.updatedAt) >= QUIET_AFTER_MS
        ) {
          quietOpenReadAt.set(readKey, nowMs);
        }
        const terminal = {
          state: summary.state,
          closedAt: summary.closedAt ?? null,
          mergedAt: summary.mergedAt ?? null,
        } satisfies SettlementPullRequest;
        const cwd = lookupCwdByThreadId.get(thread.id);
        if (summary.state !== "open" && thread.branch !== null && cwd !== undefined) {
          if (!(yield* wouldSettle(group, terminal))) return undefined;
          const current = yield* git.branchPullRequest(
            { cwd, branch: thread.branch },
            { refresh: true },
          );
          const project = projects.get(thread.projectId);
          if (
            current?.state === "open" &&
            project !== undefined &&
            pullRequestMatchesProject(current, project)
          ) {
            return current;
          }
        }
        return terminal;
      }
      if (thread.branch === null) return null;
      const cwd = lookupCwdByThreadId.get(thread.id);
      if (cwd === undefined) {
        return yield* Effect.die(new Error("thread project not found"));
      }
      const refresh = group.filter((member) => shellClosedThreads.delete(member.id)).length > 0;
      const key = lookupKey(thread);
      if (scheduledLookups !== null && !refresh && !scheduledLookups.has(key)) return undefined;
      // Remembered git state is enough to rule a thread out; only an answer
      // that would settle it is confirmed against fresh git state.
      const remembered = yield* git.branchPullRequest(
        { cwd, branch: thread.branch },
        { refresh, confirmTerminal: false },
      );
      noPullRequestRechecks.record(key, nowMs, remembered !== null);
      if (refresh || remembered === null || remembered.state === "open") return remembered;
      if (!(yield* wouldSettle(group, remembered))) return undefined;
      return yield* git.branchPullRequest({ cwd, branch: thread.branch }, { freshGitState: true });
    });

    // A merge, a shell close and a thread's own events read at once; only scheduled sweeps wait.
    const scheduledLookups =
      mergedPullRequest !== null || threadId !== undefined
        ? null
        : noPullRequestRechecks.select(
            nowMs,
            [...groups]
              .filter(([key]) => key.startsWith('["branch",'))
              .map(([key, group]) => ({
                key,
                activityAtMs: Math.max(...group.map(threadActivityAtMs)),
              })),
          );

    yield* Effect.forEach(
      groups.values(),
      (group) =>
        Effect.gen(function* () {
          const pullRequest = yield* pullRequestFor(group);
          if (pullRequest === undefined) return;
          yield* Effect.forEach(group, (thread) => settleThread(thread, pullRequest), {
            discard: true,
          });
        }).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("automatic thread settlement skipped", {
                threadIds: group.map((thread) => thread.id),
                cause: Cause.pretty(cause),
              }),
          ),
        ),
      { concurrency: 8, discard: true },
    );
    if (threadId === undefined) noPullRequestRechecks.retain(groups);
  });

  const runSweep = (
    mergedPullRequest: PullRequestService.PullRequestMergeEvent | null,
    threadId?: ThreadId,
  ) =>
    sweep(mergedPullRequest, threadId).pipe(
      Effect.provideService(GitVcsDriver.BackgroundGitWork, true),
      withGitSpawnBudget("thread-settlement-sweep", SETTLEMENT_SWEEP_SPAWN_BUDGET),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("automatic thread settlement sweep failed", {
            cause: Cause.pretty(cause),
          }),
      ),
    );
  let fullSweepPending = false;
  // A thread that just stopped must not wait behind a full sweep or another thread's host
  // reads: clients hold it in Working only briefly, so a late settle makes it appear and then vanish.
  const fullSweeps = yield* makeDrainableWorker(() => {
    // Clear at the start so events during this sweep can request one follow-up.
    fullSweepPending = false;
    return runSweep(null);
  });
  const enqueueFullSweep = () =>
    Effect.suspend(() => {
      if (fullSweepPending) return Effect.void;
      fullSweepPending = true;
      return fullSweeps.enqueue(undefined);
    });
  const threadSweeps = yield* FiberSet.make<void>();
  const threadSweepSlots = yield* Semaphore.make(8);
  // One sweep per thread at a time; events during a running sweep coalesce into one more pass.
  const threadSweepStates = new Map<ThreadId, "queued" | "running" | "rerun">();
  const sweepThread = (
    threadId: ThreadId,
  ): Effect.Effect<void, Effect.Error<ReturnType<typeof runSweep>>> =>
    Effect.sync(() => threadSweepStates.set(threadId, "running")).pipe(
      Effect.andThen(runSweep(null, threadId)),
      threadSweepSlots.withPermits(1),
      Effect.andThen(
        Effect.suspend(() => {
          if (threadSweepStates.get(threadId) === "rerun") return sweepThread(threadId);
          threadSweepStates.delete(threadId);
          return Effect.void;
        }),
      ),
    );
  const enqueueThread = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const state = threadSweepStates.get(threadId);
      if (state === "running") threadSweepStates.set(threadId, "rerun");
      if (state !== undefined) return Effect.void;
      threadSweepStates.set(threadId, "queued");
      return sweepThread(threadId).pipe(FiberSet.run(threadSweeps), Effect.asVoid);
    });

  // Skip settle scripts in shared checkouts where other threads may still work.
  const cleanUpSettledThread = Effect.fn("ThreadSettlementServiceV2.cleanUpSettledThread")(
    function* (threadId: ThreadId) {
      const settled = yield* projections.getThread(threadId);
      if (settled.settledOverride !== "settled") return;
      yield* terminals.closeOnSettle({ threadId });
      const worktreePath = settled.worktreePath;
      if (worktreePath === null || !(yield* fileSystem.exists(worktreePath))) return;
      const parentThreadId = settled.lineage.parentThreadId;
      const parentWorktreePath =
        parentThreadId === null
          ? null
          : yield* projections.getThread(parentThreadId).pipe(
              Effect.map((parent) => parent.worktreePath),
              Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
            );
      if (sharesParentWorktree({ ...settled, parentWorktreePath })) return;
      // Recheck after closing and worktree I/O; re-engaged threads must not be cleaned up.
      const thread = yield* projections.getThread(threadId);
      if (thread.settledOverride !== "settled") return;
      const settledAtMs = toMillis(thread.settledAt);
      if (settledAtMs === null || settleActionRunAt.get(threadId) === settledAtMs) return;
      const run = yield* projectScripts.runForThread({
        threadId,
        projectId: thread.projectId,
        worktreePath,
        trigger: "settle",
        observeCompletion: {},
      });
      settleActionRunAt.set(threadId, settledAtMs);
      if (run.status === "started" && run.completion) {
        yield* run.completion.pipe(Effect.forkDetach);
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("cleaning up a settled thread failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
        ),
      ),
  );

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "thread.settled":
        return cleanUpSettledThread(event.threadId).pipe(Effect.andThen(enqueueFullSweep()));
      case "thread.archived":
      case "thread.deleted":
        return enqueueFullSweep();
      case "thread.pull-request-link-updated":
      case "thread.pull-request-synced":
      case "provider-session.detached":
      case "run.background-work-cancelled":
        return enqueueThread(event.threadId);
      // Sweep only when the work can have ended: progress updates cannot settle anything.
      case "subagent.updated": {
        if (isOrchestrationV2WorkActive(event.payload.status)) return Effect.void;
        // The parent's result is what settles a delegated child.
        const childThreadId = event.payload.childThreadId;
        return childThreadId === null
          ? enqueueThread(event.threadId)
          : Effect.andThen(enqueueThread(event.threadId), enqueueThread(childThreadId));
      }
      case "provider-thread.updated":
        return backgroundWorkHoldsCompletion(event.payload.pendingBackgroundTasks ?? [])
          ? Effect.void
          : enqueueThread(event.threadId);
      case "turn-item.updated": {
        const item = event.payload;
        if (
          item.type === "command_execution" &&
          !isOrchestrationV2WorkActive(item.status) &&
          sourceControlDefinitions.definitions.some(
            (definition) => definition.changeRequestCloseCommand?.test(item.input) === true,
          )
        ) {
          shellClosedThreads.add(event.threadId);
        }
        return turnItemUpdateCanEndBackgroundWork(item)
          ? enqueueThread(event.threadId)
          : Effect.void;
      }
      case "runtime-request.updated":
        return event.payload.status === "pending" ? Effect.void : enqueueThread(event.threadId);
      case "plan.updated":
        return event.payload.status === "active" ? Effect.void : enqueueThread(event.threadId);
      case "provider-session.updated":
        return event.payload.status !== "starting" && event.payload.status !== "running"
          ? enqueueThread(event.threadId)
          : Effect.void;
      case "run.updated":
        return ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
          event.payload.status,
        )
          ? enqueueThread(event.threadId)
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  const start: ThreadSettlementServiceV2["Service"]["start"] = Effect.fn(
    "ThreadSettlementServiceV2.start",
  )(function* () {
    const settingsChanges = yield* settingsService.subscribeChanges;
    const mergedPullRequests = yield* pullRequests.subscribeMerges;
    const events = orchestrator.streamDomainEvents;
    const initialSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    let lastSettlementSettings = autoSettlementSettingsKey(initialSettings);
    yield* forkParked(
      Effect.gen(function* () {
        yield* enqueueFullSweep();
        yield* fullSweeps.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
    yield* forkParked(
      Stream.runForEach(settingsChanges, (settings) => {
        const key = autoSettlementSettingsKey(settings);
        if (key === lastSettlementSettings) {
          return Effect.void;
        }
        lastSettlementSettings = key;
        unmergedWorkHeldUntilMs.clear();
        threadsHeldUntilMs.clear();
        return enqueueFullSweep();
      }),
    );
    yield* forkParked(Stream.runForEach(mergedPullRequests, (event) => runSweep(event)));
    yield* forkParked(Stream.runForEach(pullRequests.subscribeRefreshes, pauseQuietReads));
    yield* forkParked(
      Stream.runForEach(events, processEvent).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Thread settlement event stream failed", { cause }),
        ),
      ),
    );
  });

  return {
    start,
    drain: Effect.andThen(fullSweeps.drain, FiberSet.awaitEmpty(threadSweeps)),
  } satisfies ThreadSettlementServiceV2["Service"];
});
