// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import {
  GitCommandError,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderSessionJson,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  OrchestrationV2ThreadShell,
  ProjectId,
  ServerSettings,
  ServerSettingsError,
  TerminalSummary,
  WorktreeCleanupRules,
  StorageCleanupReport,
  StorageCleanupReportEntry,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { compactLegacyId } from "@t3tools/provider-core/server/compactId";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import type { UnknownError } from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { parse as parseYaml } from "yaml";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import {
  provenTaskResultReadsSql,
  publicationTransferIdSql,
  recordedTaskReadsSql,
  resultFingerprint,
} from "./orchestration-v2/taskResultReadEvidence.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "./orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import { threadHasQueuedTurnStart } from "./orchestration-v2/ThreadSettlementService.ts";
import { forkParked } from "./serverActivation.ts";
import * as Settings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import {
  isFilesystemRoot,
  managedWorktreesDirectories,
  makeIsManagedWorktreePath,
} from "./worktreesDirectory.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { gitErrorLines, isNonRepositoryGitStderr } from "./vcs/GitVcsDriverCore.ts";
import { prepareLinkedWorktreeRemoval } from "./vcs/worktreeRemoval.ts";
import { gitOutputLine } from "@t3tools/shared/git";
import {
  checkoutActivityFloor,
  decodeReleaseRequest,
  hasNonDirectoryParent,
  finishInterruptedRemoval,
  restoreStagedWindowsCheckout,
  observedCheckoutPath,
  worktreeReleaseName,
  worktreeOwner,
  releasePath,
  releaseReceiptPath,
  releaseHold,
  trackedPosixMetadataHold,
  type ReleaseRequest,
} from "./workspace/worktreeRelease.ts";
import {
  existingWorkspacePath,
  observeWorkspaceStarts,
  withWorkspaceLease,
  WorkspaceLeasePathError,
} from "./workspace/workspaceLease.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { isNetworkPath } from "@t3tools/shared/path";
import { missingSetupPath, setupStageName } from "../../../scripts/lib/worktree-setup-proof.ts";

const decodeCleanupThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeCleanupSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);
// pnpm 11 writes this file as JSON, older versions as YAML.
const decodePnpmModulesManifest = Schema.decodeUnknownEffect(
  Schema.Struct({
    storeDir: Schema.String,
    virtualStoreDir: Schema.optional(Schema.String),
  }),
);

const DAY_MS = 86_400_000;
// Give settle scripts time to open terminals that protect the worktree.
const SETTLE_SCRIPT_GRACE_MS = 60_000;
// Worktree creation can precede its thread row, including review-guide checkouts.
const ORPHAN_WORKTREE_GRACE_MS = 60 * 60 * 1_000;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const REPORT_ENTRY_LIMIT = 200;
const isGitCommandError = Schema.is(GitCommandError);
const encodeMemberIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

function cleanupFailureReason(error: { readonly message: string }) {
  return isGitCommandError(error)
    ? `${error.command}: ${error.detail.split(/\r?\n/)[0]}${error.reason ? ` (${error.reason})` : ""}`
    : (error.message.split(/\r?\n/)[0] ?? error.message);
}

const worktreeCleanupEnabled = (rules: WorktreeCleanupRules) =>
  rules.worktreeAfterDays !== null ||
  rules.worktreeSettledAfterDays !== null ||
  rules.worktreeOnMerge ||
  rules.worktreeOnDelete ||
  rules.worktreeUnchanged;

function anyWorktreePolicy(
  settings: ServerSettings,
  predicate: (rules: WorktreeCleanupRules) => boolean,
): boolean {
  return (
    predicate(resolveWorktreeCleanup(settings, null)) ||
    Object.keys(settings.projectSettingsOverrides).some((projectId) =>
      predicate(resolveWorktreeCleanup(settings, projectId as ProjectId)),
    )
  );
}

function sameProjectWorktreePolicies(left: ServerSettings, right: ServerSettings): boolean {
  return [
    ...new Set([
      ...Object.keys(left.projectSettingsOverrides),
      ...Object.keys(right.projectSettingsOverrides),
    ]),
  ].every((projectId) =>
    Equal.equals(
      left.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
      right.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
    ),
  );
}

type LimitRecoverySettings = Pick<
  ServerSettings,
  "autoResumeLimitedThreads" | "snoozeLimitedThreads"
>;

export function storageCleanupThreadIdle(
  thread: OrchestrationV2ThreadShell,
  now: number,
  settings: LimitRecoverySettings,
): boolean {
  return (
    thread.worktreePath !== null &&
    thread.activeRunId === null &&
    (thread.status === "idle" ||
      thread.status === "completed" ||
      thread.status === "interrupted" ||
      thread.status === "failed" ||
      thread.status === "cancelled" ||
      thread.status === "rolled_back") &&
    (thread.pendingBackgroundTasks?.length ?? 0) === 0 &&
    thread.pendingRuntimeRequest === null &&
    !threadHasQueuedTurnStart(thread, now) &&
    !heldForLimitRecovery(thread, now, settings)
  );
}

// A run held for its usage-limit reset has its work still ahead of it, and a
// fresh worktree would otherwise look unchanged and be removed before it runs.
function heldForLimitRecovery(
  thread: OrchestrationV2ThreadShell,
  now: number,
  settings: LimitRecoverySettings,
): boolean {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled"
  )
    return false;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  const recovery = thread.limitRecovery;
  if (recovery?.runId === thread.latestRunId && recovery.resetAt === thread.usageLimitResetAt)
    // An auto-resume holds until its continuation replaces the failed run.
    return recovery.autoResume || (recovery.snooze === true && resetMs > now);
  // The recovery worker arms this failure on a later tick; hold it until then.
  // Like the worker, skip a reset that had already passed when the run ended.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return false;
  return settings.autoResumeLimitedThreads || (settings.snoozeLimitedThreads && resetMs > now);
}

/** PR metadata refreshes must not reset the inactivity clock. */
export function storageCleanupActivityAt(thread: OrchestrationV2ThreadShell): number {
  return Math.max(
    ...[
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestRunRequestedAt,
      thread.latestRunStartedAt,
      thread.latestRunCompletedAt,
    ].flatMap((value) => (value == null ? [] : [DateTime.toEpochMillis(value)])),
  );
}

function familyMemberSettled(
  member: OrchestrationV2ThreadShell,
  owner: Pick<OrchestrationV2ThreadShell, "id" | "settledAt" | "settledOverride">,
) {
  if (member.latestRunCompletedAt == null) return false;
  if (member.settledOverride === "settled")
    return (
      member.settledAt !== null &&
      !DateTime.isLessThan(member.settledAt, member.latestRunCompletedAt)
    );
  // The owner can finish a passive child's completed work. An explicit keep-active choice survives.
  return (
    member.id !== owner.id &&
    owner.settledOverride === "settled" &&
    owner.settledAt !== null &&
    member.settledOverride === null &&
    member.autoSettleDisabledAt == null &&
    member.snoozedUntil == null &&
    member.laterAt == null &&
    member.archivedAt === null &&
    storageCleanupActivityAt(member) <= DateTime.toEpochMillis(owner.settledAt) &&
    !DateTime.isGreaterThan(member.updatedAt, owner.settledAt)
  );
}

/** Squash/rebase merges require the merged PR to name this exact head commit. */
export function storageCleanupPullRequestMerged(
  pullRequest: Pick<
    GitManager.GitBranchPullRequest,
    "state" | "headRef" | "baseRef" | "headSha"
  > | null,
  worktree: {
    readonly branch: string;
    readonly defaultBranch: string;
    readonly headSha: string;
    readonly integrated: boolean;
  },
): boolean {
  return (
    pullRequest?.state === "merged" &&
    (worktree.integrated ||
      (pullRequest.headRef === worktree.branch &&
        pullRequest.baseRef === worktree.defaultBranch &&
        pullRequest.headSha === worktree.headSha))
  );
}

export class StorageCleanup extends Context.Service<
  StorageCleanup,
  {
    readonly runNow: Effect.Effect<StorageCleanupReport, ServerSettingsError>;
    readonly latestReport: Effect.Effect<StorageCleanupReport | null>;
    readonly reports: Stream.Stream<StorageCleanupReport | null>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/storageCleanup") {}

const RESULT_CHECK_PAGE_SIZE = 128;
const decodeStoredTaskResult = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.String));

interface TaskResultCandidate {
  readonly id: string;
  readonly threadId: OrchestrationV2ThreadShell["id"];
  readonly spawningRun: string | null;
  readonly delivery: string | null;
  readonly completedAt: string | null;
  readonly canCheckWake: number | null;
  readonly hasRecordedRead: number;
}

// A cancel, Stop, archive, deleted thread, removed wake or answered launch failure disposes a
// delivery by decision, and a Stop or archive also ends a wake already delivered, so those results
// need no reader. Only a result whose spawning run is gone was dropped undecided; it stays held
// until a completed parent run reads it.
const taskRequiresResultCheck = (sql: SqlClient.SqlClient) => sql`
  NOT (
    t.status IN ('completed','failed','cancelled','interrupted')
    AND EXISTS (
      SELECT 1 FROM orchestration_v2_projection_runs spawner
      WHERE spawner.run_id = t.run_id AND spawner.thread_id = t.thread_id
        AND ((t.completion_delivery_state = 'disposed'
            AND json_extract(t.payload_json, '$.completionDelivery.state') IS 'disposed')
          OR json_extract(spawner.payload_json, '$.delegatedCompletion.disposition') IN ('stopped','disposed'))
    )
  )
`;

const taskResultCandidate = (sql: SqlClient.SqlClient) => sql`
  t.subagent_id AS id, t.thread_id AS threadId, t.run_id AS spawningRun,
  t.completion_delivery_state AS delivery, t.completed_at AS completedAt,
  (json_type(t.payload_json, '$.terminalResultObservation.resultFingerprint') IS 'text'
    OR json_type(t.payload_json, '$.completionDelivery.resultFingerprint') IS 'text') AS hasRecordedRead,
  (t.status IN ('completed','failed','cancelled','interrupted')
    AND t.completion_delivery_state IN ('acknowledged','delivered')
    AND json_type(t.payload_json, '$.result') = 'text') AS canCheckWake
`;

export const familyDelegateResultConsumed = Effect.fn(
  "StorageCleanup.familyDelegateResultConsumed",
)(function* (
  sql: SqlClient.SqlClient,
  child: OrchestrationV2ThreadShell,
  childRunId: ReleaseRequest["runId"],
) {
  const parentId = child.lineage.parentThreadId;
  const originalTaskId = child.forkedFrom?.type === "node" ? child.forkedFrom.nodeId : null;
  if (parentId === null) return false;
  const [task] = yield* sql<TaskResultCandidate & { needsReader: number }>`
      SELECT ${taskResultCandidate(sql)}, (${taskRequiresResultCheck(sql)}) AS needsReader
      FROM orchestration_v2_projection_runs child_run
      JOIN orchestration_v2_projection_subagents t
        ON t.subagent_id = coalesce(json_extract(child_run.payload_json, '$.delegatedTaskId'), ${originalTaskId})
      WHERE child_run.run_id = ${childRunId} AND child_run.thread_id = ${child.id} AND child_run.status = 'completed'
        AND t.thread_id = ${parentId} AND t.child_thread_id = child_run.thread_id
        AND t.origin = 'app_owned' AND t.status = 'completed' AND child_run.completed_at <= t.completed_at
        AND EXISTS (
          SELECT 1 FROM orchestration_v2_projection_context_transfers result
          WHERE result.source_thread_id = child_run.thread_id AND result.target_thread_id = t.thread_id
            AND result.type = 'subagent_result' AND result.status = 'consumed'
            AND result.target_run_id = t.run_id
            AND json_extract(result.payload_json, '$.sourcePoint.runId') = child_run.run_id
            AND (result.context_transfer_id = (${sql.literal(publicationTransferIdSql)})
              -- Without publication times, the original run and its sole transfer must be the only possible source.
              OR (json_type(result.payload_json,'$.createdAt') IS NULL AND json_type(result.payload_json,'$.consumedAt') IS NULL
                AND coalesce(json_extract(result.payload_json,'$.sourcePoint.threadId'), child_run.thread_id)=child_run.thread_id
                AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs sibling
                  WHERE sibling.thread_id=child_run.thread_id AND sibling.run_id!=child_run.run_id
                    AND (json_extract(sibling.payload_json,'$.delegatedTaskId') IS NULL
                      OR json_extract(sibling.payload_json,'$.delegatedTaskId')=t.subagent_id))
                AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_context_transfers other
                  WHERE other.target_run_id=t.run_id AND other.source_thread_id=child_run.thread_id
                    AND other.target_thread_id=t.thread_id AND other.type='subagent_result'
                    AND other.context_transfer_id!=result.context_transfer_id)))
        )
    `.pipe(NodeSqliteClient.readOnly);
  return (
    task !== undefined && (!task.needsReader || (yield* taskWakeConsumed(sql, task, childRunId)))
  );
});

const taskWakeConsumed = Effect.fn("StorageCleanup.taskWakeConsumed")(function* (
  sql: SqlClient.SqlClient,
  task: TaskResultCandidate,
  childRunId: ReleaseRequest["runId"] | null = null,
) {
  if (task.hasRecordedRead && (task.delivery === "acknowledged" || task.delivery === "disposed")) {
    const reads = yield* sql<{ result_json: string; fingerprint: string }>`
      ${sql.literal(recordedTaskReadsSql)} AND t.subagent_id = ${task.id} AND t.thread_id = ${task.threadId}
        AND t.completion_delivery_state = json_extract(t.payload_json,'$.completionDelivery.state')
        AND observer.status = 'completed'
        AND (${childRunId} IS NULL OR source_child_run_id IS NULL OR source_child_run_id = ${childRunId})
    `.pipe(NodeSqliteClient.readOnly);
    const first = reads[0];
    if (first) {
      const digest = resultFingerprint(yield* decodeStoredTaskResult(first.result_json));
      if (reads.some((read) => read.fingerprint === digest)) return true;
    }
  }
  if (task.delivery === "acknowledged" || task.delivery === "disposed") {
    const rows = yield* sql`SELECT 1 FROM orchestration_v2_projection_subagents t
      WHERE t.subagent_id = ${task.id} AND t.thread_id = ${task.threadId}
        AND t.completion_delivery_state = json_extract(t.payload_json,'$.completionDelivery.state')
        AND EXISTS (SELECT 1 FROM (${sql.literal(provenTaskResultReadsSql)})
          WHERE reader_status = 'completed'
            AND (${childRunId} IS NULL OR source_child_run_id IS NULL OR source_child_run_id = ${childRunId}))
      LIMIT 1`.pipe(NodeSqliteClient.readOnly);
    if (rows.length !== 0) return true;
  }
  if (!task.canCheckWake) return false;
  let after = "";
  let soleWake = false;
  for (;;) {
    const wakes = yield* sql<{
      messageId: string;
      text: string | null;
      taskIds: string;
      taskCount: number;
      status: string;
      primaryInput: number;
      afterPublication: number;
    }>`
        SELECT m.message_id AS messageId, json_extract(m.payload_json, '$.text') AS text,
          json_extract(m.payload_json, '$.delegatedCompletion.taskIds') AS taskIds,
          json_array_length(m.payload_json, '$.delegatedCompletion.taskIds') AS taskCount,
          consumer.status, (json_extract(consumer.payload_json, '$.userMessageId') = m.message_id) AS primaryInput,
          (${childRunId} IS NULL OR m.created_at >= ${task.completedAt}) AS afterPublication
        FROM orchestration_v2_projection_messages m
        JOIN orchestration_v2_projection_runs consumer ON consumer.run_id = m.run_id
        WHERE m.thread_id = ${task.threadId} AND m.role = 'user'
          AND m.message_id > ${after}
          AND consumer.thread_id = m.thread_id AND consumer.status != 'cancelled'
          AND json_extract(m.payload_json, '$.createdBy') = 'agent'
          AND json_extract(m.payload_json, '$.creationSource') = 'server'
          AND json_extract(m.payload_json, '$.delegatedCompletion.parentRunId') = ${task.spawningRun}
          AND EXISTS (SELECT 1 FROM json_each(m.payload_json, '$.delegatedCompletion.taskIds') WHERE value = ${task.id})
        ORDER BY m.message_id LIMIT ${RESULT_CHECK_PAGE_SIZE}
      `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
    if (after === "") soleWake = wakes.length === 1;
    for (const wake of wakes) {
      // A live steer is not the run's primary input. Only an accepted steer or a non-cancelled
      // wake run marks the task delivered, so a sole such message identifies its consumer.
      if (
        !wake.afterPublication ||
        wake.status !== "completed" ||
        (!wake.primaryInput && (task.delivery !== "delivered" || !soleWake))
      )
        continue;
      // A batched wake can contain the whole result for one task and only a read instruction for another.
      const members = yield* sql<{
        id: string;
        status: string;
        title: string | null;
        result: string | null;
        command: string | null;
      }>`
          SELECT t.subagent_id AS id, t.status, json_extract(t.payload_json, '$.title') AS title,
            json_extract(t.payload_json, '$.result') AS result, json_extract(t.payload_json, '$.command') AS command
          FROM json_each(${wake.taskIds}) member
          JOIN orchestration_v2_projection_subagents t ON t.subagent_id = member.value
          WHERE t.thread_id = ${task.threadId} AND t.run_id = ${task.spawningRun}
          ORDER BY member.key
        `.pipe(NodeSqliteClient.readOnly);
      if (members.length !== wake.taskCount) continue;
      const inline = new Set<string>();
      const text = Orchestrator.delegatedCompletionWakeDetail(
        members.map((member) => member.id),
        members,
        inline,
      );
      if (text === wake.text && inline.has(task.id)) return true;
      // Migration 091 compacted structured IDs but left the original notification text intact.
      const member = members[0];
      if (
        !wake.primaryInput ||
        task.delivery !== "delivered" ||
        !soleWake ||
        members.length !== 1 ||
        member?.id !== task.id
      )
        continue;
      if (wake.text === null) continue;
      const displayedId = /^(?:Delegated task|Command) (node:\S+) /.exec(wake.text)?.[1];
      if (!displayedId || displayedId === task.id || compactLegacyId(displayedId) !== task.id)
        continue;
      const originalText = Orchestrator.delegatedCompletionWakeDetail(
        [displayedId],
        [{ ...member, id: displayedId }],
        inline,
      );
      if (originalText === wake.text && inline.has(displayedId)) return true;
    }
    if (wakes.length < RESULT_CHECK_PAGE_SIZE) return false;
    after = wakes.at(-1)!.messageId;
  }
});

/** Every app-owned result belongs to its parent, including commands with no child thread. */
const ownerTaskResultsConsumed = Effect.fn("StorageCleanup.ownerTaskResultsConsumed")(function* (
  sql: SqlClient.SqlClient,
  parentId: OrchestrationV2ThreadShell["id"],
) {
  let after = "";
  for (;;) {
    const tasks = yield* sql<TaskResultCandidate>`
      SELECT ${taskResultCandidate(sql)}
      FROM orchestration_v2_projection_subagents t
      WHERE t.thread_id = ${parentId} AND t.subagent_id > ${after}
        AND t.origin = 'app_owned' AND ${taskRequiresResultCheck(sql)}
      ORDER BY t.subagent_id LIMIT ${RESULT_CHECK_PAGE_SIZE}
    `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
    for (const task of tasks) {
      if (!(yield* taskWakeConsumed(sql, task))) return false;
    }
    if (tasks.length < RESULT_CHECK_PAGE_SIZE) return true;
    after = tasks.at(-1)!.id;
  }
});

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;
  const gitManager = yield* GitManager.GitManager;
  const terminals = yield* TerminalManager.TerminalManager;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const liveTerminals = new Map<string, Map<string, TerminalSummary>>();
  const orphanSizes = new Map<string, number | null>();
  const noteTerminal = (terminal: TerminalSummary) => {
    const threadTerminals =
      liveTerminals.get(terminal.threadId) ?? new Map<string, TerminalSummary>();
    threadTerminals.set(terminal.terminalId, terminal);
    liveTerminals.set(terminal.threadId, threadTerminals);
  };

  const isWindows = yield* HostProcess.isWindows;
  const realWorkspacePath: (target: string) => Effect.Effect<string, PlatformError | UnknownError> =
    isWindows ? existingWorkspacePath : fs.realPath;
  const pathKey = (target: string) => {
    const resolved = path.resolve(target);
    return isWindows ? resolved.toLowerCase() : resolved;
  };
  const inside = (root: string, target: string) => {
    const relative = path.relative(pathKey(root), pathKey(target));
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const usesReleasePath = Effect.fn("StorageCleanup.usesReleasePath")(function* (
    root: string,
    candidate: string,
  ) {
    const cwd = path.resolve(candidate);
    if (pathKey(cwd) === pathKey(root) || inside(root, cwd)) return true;
    const real = yield* observedCheckoutPath(cwd);
    return real !== null && (pathKey(real) === pathKey(root) || inside(root, real));
  });
  // Git may store a symlinked ancestor. A symlink at the checkout itself is never an owner binding.
  const sameReleaseCheckout = (stored: string, canonical: string) => {
    if (!path.isAbsolute(stored) || path.resolve(stored) !== stored) return Effect.succeed(false);
    if (stored === canonical) return Effect.succeed(true);
    const leaf = path.basename(stored);
    if (leaf !== path.basename(canonical)) return Effect.succeed(false);
    return releaseReceiptPath(stored).pipe(
      Effect.map((checkout) => checkout === canonical),
      Effect.orElseSucceed(() => false),
    );
  };
  const hasTerminal = (worktreePath: string) =>
    [...liveTerminals.values()]
      .flatMap((entries) => [...entries.values()])
      .some((terminal) => {
        if (terminal.status !== "starting" && terminal.status !== "running") return false;
        const cwd = path.resolve(terminal.cwd);
        return (
          (terminal.worktreePath !== null &&
            pathKey(terminal.worktreePath) === pathKey(worktreePath)) ||
          pathKey(cwd) === pathKey(worktreePath) ||
          inside(worktreePath, cwd)
        );
      });

  // pnpm imports packages by clone or reflink when its store shares a device
  // with the worktree. Those files have one link but share blocks with the
  // store, so removing them frees almost nothing. A store on another device
  // forces real copies, which still count.
  const sharedPnpmVirtualStore = Effect.fnUntraced(
    function* (root: string) {
      const nodeModules = path.join(root, "node_modules");
      const text = yield* fs.readFileString(path.join(nodeModules, ".modules.yaml"));
      const manifest = yield* decodePnpmModulesManifest(yield* Effect.try(() => parseYaml(text)));
      // An agent can write this manifest, and statting a network path makes
      // Windows sign in to its host with the user's NTLM credentials.
      if (isNetworkPath(manifest.storeDir) || isNetworkPath(manifest.virtualStoreDir ?? "")) {
        return null;
      }
      const virtualStore = path.resolve(nodeModules, manifest.virtualStoreDir ?? ".pnpm");
      const [store, virtual] = yield* Effect.all([
        fs.stat(manifest.storeDir),
        fs.stat(virtualStore),
      ]);
      return store.dev === virtual.dev ? virtualStore : null;
    },
    Effect.orElseSucceed(() => null),
  );

  const measureWorktree = Effect.fn("storageCleanup.measureWorktree")(
    function* (worktreePath: string, inspectRepositories = false, measureBytes = true) {
      const root = yield* fs.realPath(worktreePath);
      const skipped = measureBytes ? yield* sharedPnpmVirtualStore(root) : null;
      const incomplete = { bytes: null, reason: "worktree could not be fully inspected" };
      const repositories = new Set([pathKey(root)]);
      const moduleStores: string[] = [];
      if (inspectRepositories && (yield* fs.exists(path.join(root, ".gitmodules")))) {
        const submodules = yield* git.execute({
          operation: "StorageCleanup.nestedRepositories",
          cwd: root,
          args: [
            "submodule",
            "foreach",
            "--recursive",
            "--quiet",
            'printf "%s\\0" "$toplevel/$sm_path"',
          ],
          maxOutputBytes: 64 * 1024,
        });
        if (submodules.stdoutTruncated || submodules.stderrTruncated) return incomplete;
        for (const submodule of submodules.stdout.split("\0").filter(Boolean)) {
          repositories.add(pathKey(path.resolve(submodule)));
          repositories.add(pathKey(path.resolve(submodule, ".git")));
          moduleStores.push(pathKey(path.resolve(submodule, ".git", "modules")));
        }
      }
      const pending = [root];
      let entries = 1;
      let bytes = 0;
      while (pending.length > 0) {
        const target = pending.pop()!;
        if (target === skipped && !inspectRepositories) continue;
        if ((yield* fs.realPath(target).pipe(Effect.timeout("30 seconds"))) !== target)
          return incomplete;
        const skipSizes =
          !measureBytes || (skipped !== null && (target === skipped || inside(skipped, target)));
        const dirents = skipSizes
          ? yield* Effect.tryPromise(() => NodeFSP.readdir(target, { withFileTypes: true })).pipe(
              Effect.timeout("30 seconds"),
            )
          : undefined;
        const names =
          dirents?.map((entry) => entry.name) ??
          (yield* fs.readDirectory(target).pipe(Effect.timeout("30 seconds")));
        const markers = inspectRepositories ? names.map((name) => name.toLowerCase()) : [];
        if (
          isWindows &&
          inspectRepositories &&
          !measureBytes &&
          pathKey(target) === pathKey(path.join(root, ".t3")) &&
          markers.includes(setupStageName)
        )
          return { bytes: null, reason: "worktree has a preserved setup stage" };
        if (
          inspectRepositories &&
          !repositories.has(pathKey(target)) &&
          !moduleStores.some((store) => pathKey(target) === store || inside(store, target)) &&
          (markers.includes(".git") ||
            (markers.includes("head") && markers.includes("objects") && markers.includes("refs")))
        )
          return { bytes: null, reason: "contains a nested Git repository" };
        entries += names.length;
        if (entries > 2_000_000) return incomplete;
        if (dirents) {
          for (const entry of dirents)
            if (entry.isDirectory()) pending.push(path.join(target, entry.name));
          continue;
        }
        // lstat reads allocation and type together and never follows a file symlink.
        for (let offset = 0; offset < names.length; offset += 64) {
          const batch = names.slice(offset, offset + 64).map((name) => path.join(target, name));
          const stats = yield* Effect.tryPromise(() =>
            Promise.all(batch.map((file) => NodeFSP.lstat(file))),
          ).pipe(Effect.timeout("30 seconds"));
          for (const [i, stat] of stats.entries()) {
            if (stat.isDirectory()) pending.push(batch[i]!);
            else if (stat.isFile() && stat.nlink === 1)
              bytes += isWindows && stat.blocks === 0 ? stat.size : stat.blocks * 512;
          }
        }
      }
      return { bytes: measureBytes ? bytes : null, reason: null };
    },
    // Bound the whole lease as well as each filesystem batch.
    Effect.timeout("10 minutes"),
    Effect.orElseSucceed(() => ({ bytes: null, reason: "worktree could not be fully inspected" })),
  );

  // Large snapshots take seconds; use the reader worker instead of blocking the event loop.
  const readThreads = Effect.fn("StorageCleanup.readThreads")(function* () {
    const snapshot = yield* projections
      .getShellSnapshot()
      .pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
    const projects = yield* projectStore.listShells();
    return { projects, threads: [...snapshot.threads, ...snapshot.archivedThreads] };
  });

  const containsProjectRoot = Effect.fn("StorageCleanup.containsProjectRoot")(function* (
    worktreePath: string,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
  ) {
    for (const project of projects) {
      const projectPath = path.resolve(project.workspaceRoot);
      if (pathKey(projectPath) === pathKey(worktreePath) || inside(worktreePath, projectPath))
        return true;
      const realPath = yield* realWorkspacePath(projectPath).pipe(
        Effect.orElseSucceed(() => projectPath),
      );
      if (pathKey(realPath) === pathKey(worktreePath) || inside(worktreePath, realPath))
        return true;
    }
    return false;
  });

  const reportOrphanWorktrees = Effect.fn("StorageCleanup.reportOrphanWorktrees")(function* (
    roots: ReadonlyArray<string>,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
    entries: StorageCleanupReportEntry[],
  ) {
    const rows = yield* sql<{ worktreePath: string }>`
      SELECT DISTINCT json_extract(payload_json, '$.worktreePath') AS "worktreePath"
      FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL
    `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
    const referenced = new Set<string>();
    for (const row of rows) {
      const resolved = path.resolve(row.worktreePath);
      referenced.add(pathKey(resolved));
      referenced.add(
        pathKey(yield* realWorkspacePath(resolved).pipe(Effect.orElseSucceed(() => resolved))),
      );
    }
    const referencedAncestors = new Set<string>();
    for (let ancestor of referenced) {
      while (roots.some((root) => inside(root, ancestor))) {
        ancestor = pathKey(path.dirname(ancestor));
        referencedAncestors.add(ancestor);
      }
    }
    const projectRoots = (yield* Effect.forEach(
      yield* Effect.filter(projects, (project) =>
        fs.exists(path.resolve(project.workspaceRoot)).pipe(Effect.orElseSucceed(() => true)),
      ),
      (project) => {
        const resolved = path.resolve(project.workspaceRoot);
        return realWorkspacePath(resolved).pipe(
          Effect.orElseSucceed(() => resolved),
          Effect.map((realPath) => [resolved, realPath]),
        );
      },
    )).flat();
    const inProject = (target: string, managedRoot: string) =>
      projectRoots.some(
        (root) =>
          !inside(root, managedRoot) && (pathKey(root) === pathKey(target) || inside(root, target)),
      );
    const directories = Effect.fnUntraced(function* (parent: string, managedRoot: string) {
      if (inProject(parent, managedRoot)) return [];
      const result: string[] = [];
      for (const name of yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed(() => []))) {
        const target = path.join(parent, name);
        if (!inside(parent, target) || inProject(target, managedRoot)) continue;
        const directory = yield* Effect.gen(function* () {
          if (pathKey(yield* realWorkspacePath(target)) !== pathKey(target)) return false;
          return (yield* fs.stat(target)).type === "Directory";
        }).pipe(Effect.orElseSucceed(() => false));
        if (directory) result.push(target);
      }
      return result;
    });
    // Let the first walk time out and cache unmeasurable folders; later walks share the remaining budget.
    const now = yield* Clock.currentTimeMillis;
    const measurementDeadline = now + 30_000;
    let firstMeasurement = true;
    const reported = new Set<string>();
    const report = Effect.fnUntraced(
      function* (worktreePath: string) {
        const key = pathKey(worktreePath);
        if (
          reported.has(key) ||
          referenced.has(key) ||
          referencedAncestors.has(key) ||
          projectRoots.some((root) => pathKey(root) === key || inside(worktreePath, root))
        )
          return;
        const modified = Option.getOrNull((yield* fs.stat(worktreePath)).mtime);
        if (modified !== null && modified.getTime() > now - ORPHAN_WORKTREE_GRACE_MS) return;
        const gitPath = path.join(worktreePath, ".git");
        const linked = (yield* fs.exists(gitPath)) && (yield* fs.stat(gitPath)).type === "File";
        reported.add(key);
        const remaining = measurementDeadline - (yield* Clock.currentTimeMillis);
        if (!orphanSizes.has(key) && (firstMeasurement || remaining > 0)) {
          const measured = yield* measureWorktree(worktreePath).pipe(
            firstMeasurement ? Effect.asSome : Effect.timeoutOption(remaining),
          );
          firstMeasurement = false;
          if (Option.isSome(measured)) orphanSizes.set(key, measured.value.bytes);
        }
        const bytes = orphanSizes.get(key) ?? null;
        entries.push({
          kind: "worktree",
          outcome: "kept",
          reason: linked
            ? "No thread uses this worktree"
            : "No thread uses this folder, and it isn't a git worktree",
          path: worktreePath,
          projectPath: null,
          threadId: null,
          threadTitle: null,
          bytes,
          files: null,
        });
      },
      Effect.orElseSucceed(() => undefined),
    );
    for (const root of roots) {
      // Worktrees can be <root>/<repository>/<branch> or explicitly <root>/<name>.
      for (const projectDirectory of yield* directories(root, root)) {
        yield* Effect.gen(function* () {
          if (referenced.has(pathKey(projectDirectory))) return;
          const gitPath = path.join(projectDirectory, ".git");
          if (yield* fs.exists(gitPath)) {
            if ((yield* fs.stat(gitPath)).type === "File") yield* report(projectDirectory);
            return;
          }
          for (const worktreePath of yield* directories(projectDirectory, root)) {
            yield* report(worktreePath);
          }
        }).pipe(Effect.orElseSucceed(() => undefined));
      }
    }
    for (const key of orphanSizes.keys()) {
      if (!reported.has(key)) orphanSizes.delete(key);
    }
  });

  // Use two small Git reads: statusDetailsLocal also diffs and counts for every worktree.
  const branchChanged = Effect.fn("StorageCleanup.branchChanged")(function* (
    cwd: string,
    branch: string | null,
  ) {
    const failure = (detail: string) =>
      new GitCommandError({
        operation: "StorageCleanup.branchChanged",
        command: "git",
        cwd,
        detail,
      });
    // Return null for missing/non-repository cwd; force untranslated git diagnostics for matching.
    const read = Effect.fnUntraced(function* (args: string[], allowedExitCode?: number) {
      const result = yield* git
        .execute({
          operation: "StorageCleanup.branchChanged",
          cwd,
          args,
          env: { LC_ALL: "C" },
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.flatMap(fs.exists(cwd), (exists) =>
              exists ? Effect.fail(error) : Effect.succeed(null),
            ),
          ),
        );
      if (result === null) return null;
      if (result.exitCode === 0 || result.exitCode === allowedExitCode) return result;
      if (isNonRepositoryGitStderr(result.stderr)) return null;
      return yield* failure(gitErrorLines(result.stderr) || "command failed");
    });
    const index = yield* read(["rev-parse", "--git-path", "index"]);
    if (index === null) return true;
    if (yield* fs.exists(`${path.resolve(cwd, gitOutputLine(index.stdout))}.lock`))
      return yield* failure(
        "Git index is locked. Status will resume when the index lock is removed.",
      );
    // Detached HEAD exits 1; full refs avoid shortening when a tag shares the branch name.
    const head = yield* read(["symbolic-ref", "--quiet", "HEAD"], 1);
    if (head === null) return true;
    const ref = head.exitCode === 0 ? gitOutputLine(head.stdout) : "";
    const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
    return (name?.startsWith("(") ? null : name) !== branch;
  });

  const localChangesReason = Effect.fn("StorageCleanup.localChangesReason")(function* (
    cwd: string,
    rules: WorktreeCleanupRules,
  ) {
    const status = yield* git.execute({
      operation: "StorageCleanup.localChanges",
      cwd,
      args: [
        "status",
        "--porcelain=v1",
        "-z",
        "--ignore-submodules=none",
        rules.worktreeKeepWhen === "tracked-changes"
          ? "--untracked-files=no"
          : "--untracked-files=all",
      ],
      maxOutputBytes: 64 * 1024,
      appendTruncationMarker: true,
    });
    if (status.stdoutTruncated) return "local changes exceed the inspection limit";
    const records = status.stdout.split("\0").filter(Boolean);
    let count = 0;
    for (let i = 0; i < records.length; i++) {
      count++;
      if (/^[RC]|^.[RC]/.test(records[i]!)) i++;
    }
    if (count > 0) return `has uncommitted changes (${count} ${count === 1 ? "file" : "files"})`;
    if (rules.worktreeKeepWhen !== "any-local-files") return null;
    const ignored = yield* git.execute({
      operation: "StorageCleanup.ignoredFiles",
      cwd,
      args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      maxOutputBytes: 64 * 1024,
      appendTruncationMarker: true,
    });
    if (ignored.stdoutTruncated) return "ignored files exceed the inspection limit";
    const file = ignored.stdout
      .split("\0")
      .find((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry));
    return file === undefined ? null : `has ignored files (${file})`;
  });

  const submoduleRemoval = Effect.fn("StorageCleanup.submoduleRemoval")(
    function* (cwd: string, rules: WorktreeCleanupRules) {
      const inspect = (args: string[], maxOutputBytes = 64 * 1024) =>
        git.execute({
          operation: "StorageCleanup.submodules",
          cwd,
          args,
          maxOutputBytes,
        });
      const admin = yield* inspect(["rev-parse", "--absolute-git-dir"]);
      if (admin.stdoutTruncated || admin.stderrTruncated)
        return { force: false, reason: "submodule inspection exceeded the limit" };
      const modules = path.join(admin.stdout.replace(/\n$/, ""), "modules");
      const stored = yield* fs.exists(modules);
      if (!stored && !(yield* fs.exists(path.join(cwd, ".gitmodules"))))
        return { force: false, reason: null, paths: [] };
      const populated = yield* inspect([
        "submodule",
        "foreach",
        "--recursive",
        "--quiet",
        'printf "%s\\0" "$toplevel/$sm_path"',
      ]);
      if (populated.stdoutTruncated || populated.stderrTruncated)
        return { force: false, reason: "submodule inspection exceeded the limit" };
      const paths = populated.stdout.split("\0").filter(Boolean);
      const pending = [modules];
      for (const submodule of paths) {
        const directory = yield* inspect(["-C", submodule, "rev-parse", "--absolute-git-dir"]);
        if (directory.stdoutTruncated || directory.stderrTruncated)
          return { force: false, reason: "submodule inspection exceeded the limit" };
        pending.push(directory.stdout.replace(/\n$/, ""));
      }
      const visited = new Set<string>();
      while (pending.length > 0) {
        const directory = pending.pop()!;
        if (!(yield* fs.exists(directory))) continue;
        const canonical = yield* fs.realPath(directory);
        if (visited.has(canonical)) continue;
        visited.add(canonical);
        if (visited.size > 10_000)
          return { force: false, reason: "submodule inspection exceeded the limit" };
        if ((yield* fs.stat(directory)).type !== "Directory")
          return { force: false, reason: "submodule repository could not be inspected" };
        if (yield* fs.exists(path.join(directory, "HEAD"))) {
          const unpushed = yield* inspect([
            "--git-dir",
            directory,
            "--work-tree",
            cwd,
            "rev-list",
            "--max-count=1",
            "HEAD",
            "--all",
            "--reflog",
            "--not",
            "--remotes",
          ]);
          if (unpushed.stdoutTruncated || unpushed.stderrTruncated)
            return { force: false, reason: "submodule inspection exceeded the limit" };
          if (unpushed.stdout.trim() !== "")
            return { force: false, reason: "submodule has commits not on a remote-tracking ref" };
          pending.push(path.join(directory, "modules"));
        } else {
          for (const name of yield* fs.readDirectory(directory))
            pending.push(path.join(directory, name));
        }
      }
      // Check files after walking stored history to shorten the gap before forced removal.
      for (const submodule of paths) {
        const changes = yield* localChangesReason(submodule, rules);
        if (changes !== null) return { force: false, reason: `submodule ${changes}` };
      }
      const force = stored || paths.length > 0;
      if (force && rules.worktreeKeepWhen !== "tracked-changes") {
        const root = yield* fs.realPath(cwd);
        // Git status and foreach omit files inside deinitialized gitlink directories.
        const populatedPaths = new Set(paths.map(pathKey));
        const unchecked: string[] = [];
        for (const repository of [root, ...paths]) {
          const index = yield* inspect(
            ["-C", repository, "ls-files", "--stage", "-z"],
            16 * 1024 * 1024,
          );
          if (index.stdoutTruncated || index.stderrTruncated)
            return { force: false, reason: "submodule inspection exceeded the limit" };
          for (const entry of index.stdout.split("\0")) {
            if (!entry.startsWith("160000 ")) continue;
            const submodule = path.resolve(repository, entry.slice(entry.indexOf("\t") + 1));
            if (!inside(root, submodule))
              return { force: false, reason: "submodules could not be inspected" };
            if (!populatedPaths.has(pathKey(submodule)) && (yield* fs.exists(submodule)))
              unchecked.push(submodule);
          }
        }
        let inspected = unchecked.length;
        while (unchecked.length > 0) {
          if (inspected > 10_000)
            return { force: false, reason: "submodule inspection exceeded the limit" };
          const target = unchecked.pop()!;
          if (
            (yield* fs.realPath(target)) !== path.resolve(target) ||
            (yield* fs.stat(target)).type !== "Directory"
          )
            return { force: false, reason: "submodule has local files" };
          if (path.basename(target) === "node_modules") continue;
          const names = yield* fs.readDirectory(target);
          inspected += names.length;
          for (const name of names) unchecked.push(path.join(target, name));
        }
      }
      return { force, reason: null, paths };
    },
    Effect.orElseSucceed(() => ({ force: false, reason: "submodules could not be inspected" })),
  );

  const cleanupGit = Effect.fn("StorageCleanup.cleanupGit")(function* (
    cwd: string,
    args: string[],
    command: string,
  ) {
    const result = yield* git.execute({
      operation: "StorageCleanup.cleanupGit",
      cwd,
      args,
      allowNonZeroExit: true,
      timeoutMs: 300_000,
    });
    if (result.exitCode !== 0)
      return yield* new GitCommandError({
        operation: "StorageCleanup.cleanupGit",
        command,
        cwd,
        detail: gitErrorLines(result.stderr) || "command failed",
      });
  });

  const releaseDirectory = path.join(config.stateDir, ServerConfig.WORKTREE_RELEASE_DIRECTORY);
  const withdrawn = "owner withdrew or replaced the release request";
  const allowMissingRequest = <A>(effect: Effect.Effect<A, PlatformError>) =>
    effect.pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
    );
  const pendingRequestFiles = Effect.gen(function* () {
    if (!(yield* fs.exists(releaseDirectory))) return [];
    return (yield* fs.readDirectory(releaseDirectory)).filter((name) =>
      /^[a-f0-9]{64}\.json(?:\.releasing)?$/.test(name),
    );
  });

  const deliveryHold = Effect.fn("StorageCleanup.deliveryHold")(function* (
    shell: OrchestrationV2ThreadShell,
    request: ReleaseRequest,
  ) {
    if (
      shell.latestRunId !== request.runId ||
      shell.status !== "completed" ||
      shell.latestRunCompletedAt == null ||
      shell.activityRunStatus != null ||
      shell.queueHeld ||
      shell.blockedOnThreadWait ||
      shell.hasActionableProposedPlan ||
      shell.goal?.status === "active" ||
      shell.pinnedAt != null ||
      (shell.pendingGuestMessageCount ?? 0) > 0 ||
      shell.pullRequests?.some((link) => link.watch !== undefined) ||
      (shell.latestUserMessageAt !== null &&
        DateTime.isGreaterThan(shell.latestUserMessageAt, shell.latestRunCompletedAt))
    )
      return "requested run has unfinished work or was superseded";
    if (request.family) {
      const changed = yield* sql`
        SELECT 1 WHERE NOT EXISTS (
          SELECT 1 FROM (SELECT run_id, status FROM orchestration_v2_projection_runs
            WHERE thread_id = ${shell.id} ORDER BY ordinal DESC LIMIT 1)
          WHERE run_id = ${request.runId} AND status = 'completed'
        )
      `.pipe(NodeSqliteClient.readOnly);
      if (changed.length) return "latest family run changed or did not complete";
    }
    if (shell.delegatedFrom) return "remote delegate ownership requires its peer";
    if (yield* engine.delegatedTaskResultPending(shell.id))
      return "run result or restart continuation is pending";
    const pending = yield* sql`
      SELECT 1 WHERE EXISTS (
        SELECT 1 FROM orchestration_v2_effect_outbox WHERE thread_id = ${shell.id}
          AND status NOT IN ('succeeded','cancelled')
      ) OR EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id = ${shell.id}
          AND status IN ('preparing','queued','starting','running','waiting')
      ) OR EXISTS (
        SELECT 1 FROM orchestration_v2_projection_subagents
        WHERE (thread_id = ${shell.id} OR child_thread_id = ${shell.id})
          AND (status NOT IN ('completed','failed','cancelled','interrupted')
            OR (origin != 'provider_native' AND coalesce(completion_delivery_state,'') NOT IN ('acknowledged','delivered','disposed')))
      )
    `.pipe(NodeSqliteClient.readOnly);
    if (pending.length) return "run, task delivery or durable effect is pending";
    if (
      shell.lineage.relationshipToParent === "subagent" &&
      !(yield* familyDelegateResultConsumed(sql, shell, request.runId))
    )
      return "parent has not received this delegate's result";
    if (!(yield* ownerTaskResultsConsumed(sql, shell.id)))
      return "a task result has no verified consumer in a completed run";
    return null;
  });

  const workspaceActivityHold = Effect.fn("StorageCleanup.workspaceActivityHold")(function* (
    checkout: string,
    memberIds: ReadonlySet<string>,
    activityFloor: string | null,
  ) {
    const overlapsByCwd = new Map<string, boolean>();
    const overlaps = Effect.fn("StorageCleanup.commandOverlapsCheckout")(function* (cwd: string) {
      const prior = overlapsByCwd.get(cwd);
      if (prior !== undefined) return prior;
      const matches = yield* usesReleasePath(checkout, cwd);
      overlapsByCwd.set(cwd, matches);
      return matches;
    });
    let after = "";
    for (;;) {
      const commands = yield* sql<{
        id: string;
        cwd: string;
        threadId: string;
        pending: number;
      }>`
        SELECT c.task_id AS id, c.cwd, c.thread_id AS threadId,
          (c.status IN ('queued','running') OR c.delivered_at IS NULL) AS pending
        FROM command_runs c
        WHERE c.task_id > ${after} AND (
          c.status IN ('queued','running') OR c.delivered_at IS NULL OR NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_subagents t
            WHERE t.subagent_id = c.task_id AND t.thread_id = c.thread_id AND t.run_id = c.run_id
              AND t.origin = 'app_owned' AND json_type(t.payload_json, '$.command') = 'object'
              AND json_extract(t.payload_json, '$.command.cwd') = c.cwd
          )
        )
        ORDER BY c.task_id LIMIT ${RESULT_CHECK_PAGE_SIZE}
      `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
      for (const command of commands) {
        if (memberIds.has(command.threadId) || (yield* overlaps(command.cwd)))
          return command.pending
            ? "command or command delivery is pending"
            : "command result is missing its matching task record";
      }
      if (commands.length < RESULT_CHECK_PAGE_SIZE) break;
      after = commands.at(-1)!.id;
    }

    // CommandRunner prunes command_runs while task results remain in the durable projection. A task
    // that finished before this checkout existed worked in an earlier one at the same path, so only
    // tasks changed since then are read; an unreadable timestamp is read too. SQLite tests these
    // terms in written order, so the column tests come first and skip the older payloads unparsed.
    const memberIdsJson = encodeMemberIds([...memberIds]);
    after = "";
    for (;;) {
      const candidates = yield* sql<TaskResultCandidate & { cwd: string }>`
        SELECT ${taskResultCandidate(sql)}, json_extract(t.payload_json, '$.command.cwd') AS cwd
        FROM orchestration_v2_projection_subagents t
        WHERE t.subagent_id > ${after} AND t.origin = 'app_owned'
          AND (t.status NOT IN ('completed','failed','cancelled','interrupted')
            OR coalesce(julianday(t.updated_at) >= julianday(${activityFloor}), 1))
          AND t.thread_id NOT IN (SELECT value FROM json_each(${memberIdsJson}))
          AND json_type(t.payload_json, '$.command') = 'object'
          AND json_type(t.payload_json, '$.command.cwd') = 'text'
          AND ${taskRequiresResultCheck(sql)}
        ORDER BY t.subagent_id LIMIT ${RESULT_CHECK_PAGE_SIZE}
      `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
      for (const task of candidates) {
        if ((yield* overlaps(task.cwd)) && !(yield* taskWakeConsumed(sql, task)))
          return "a workspace command result has no verified consumer in a completed run";
      }
      if (candidates.length < RESULT_CHECK_PAGE_SIZE) break;
      after = candidates.at(-1)!.id;
    }
    for (const cwd of yield* providerSessions.occupiedWorkspaces) {
      if (yield* usesReleasePath(checkout, cwd))
        return "provider workspace is still open or closing";
    }
    for (const entries of liveTerminals.values()) {
      for (const terminal of entries.values()) {
        if (
          (terminal.status === "starting" || terminal.status === "running") &&
          (memberIds.has(terminal.threadId) ||
            (yield* usesReleasePath(checkout, terminal.cwd)) ||
            (terminal.worktreePath !== null &&
              (yield* usesReleasePath(checkout, terminal.worktreePath))))
        )
          return "open terminal";
      }
    }
    return null;
  });

  const cleanWorktrees = Effect.fn("StorageCleanup.cleanWorktrees")(function* (
    serverSettings: ServerSettings,
    now: number,
    entries: StorageCleanupReportEntry[],
    requestsOnly: boolean,
  ) {
    const releases = new Map<string, { file: string; contents: string; request: ReleaseRequest }>();
    const invalidRequests = new Set<string>();
    // Read claimed requests first so a newer request for the same path wins.
    for (const name of (yield* pendingRequestFiles).toSorted().reverse()) {
      const key = name.replace(/\.releasing$/, "");
      const file = path.join(releaseDirectory, name);
      const loaded = yield* Effect.gen(function* () {
        const stat = yield* Effect.tryPromise(() => NodeFSP.lstat(file).catch(missingSetupPath));
        if (!stat) return undefined;
        if (!stat.isFile() || stat.size > 1024 * 1024) return null;
        const contents = yield* allowMissingRequest(fs.readFileString(file));
        if (contents === null) return undefined;
        const request = yield* decodeReleaseRequest(contents);
        return worktreeReleaseName(request.worktreePath) === key
          ? { file, contents, request }
          : null;
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => null),
      );
      if (loaded === undefined) continue;
      if (loaded === null) invalidRequests.add(key);
      else releases.set(key, loaded);
    }
    const hasRequests = releases.size > 0 || invalidRequests.size > 0;
    if (
      !hasRequests &&
      (requestsOnly || !anyWorktreePolicy(serverSettings, worktreeCleanupEnabled))
    )
      return { waiting: false, kept: [] };
    let waiting = false;
    const kept: string[] = [];
    const roots: Array<string> = [];
    for (const directory of managedWorktreesDirectories(
      serverSettings,
      config.worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
    )) {
      const root = yield* fs.exists(directory).pipe(
        Effect.flatMap((exists) => (exists ? realWorkspacePath(directory) : Effect.succeed(null))),
        Effect.orElseSucceed(() => null),
      );
      if (root !== null && !isFilesystemRoot(root, path)) roots.push(root);
    }
    const deletedRows = yield* sql<{ payload_json: string; workspaceRoot: string }>`
          SELECT t.payload_json, p.workspace_root AS "workspaceRoot"
          FROM orchestration_v2_projection_threads t
          JOIN projection_projects p ON p.project_id = t.project_id
          WHERE t.deleted_at IS NOT NULL
        `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
    const deletedThreads = (yield* Effect.forEach(deletedRows, (row) =>
      decodeCleanupThread(row.payload_json).pipe(
        Effect.map((thread) => ({ ...thread, workspaceRoot: row.workspaceRoot })),
      ),
    )).filter((thread) => thread.worktreePath !== null && thread.branch !== null);
    const snapshot = yield* readThreads();
    const refreshedDefaultRefs = new Map<string, Set<string>>();
    const defaultBranches = new Map<string, string | null>();
    const requestedByOwner = new Map<string, string>();
    for (const { request } of releases.values()) {
      requestedByOwner.set(request.threadId, request.worktreePath);
      for (const member of request.family ?? [])
        requestedByOwner.set(member.threadId, request.worktreePath);
    }
    const releaseAliases = new Map<string, string>();
    for (const thread of snapshot.threads) {
      const requested = requestedByOwner.get(thread.id);
      const stored = thread.worktreePath;
      if (
        requested !== undefined &&
        stored !== null &&
        stored !== requested &&
        !releaseAliases.has(stored) &&
        (yield* sameReleaseCheckout(stored, requested))
      )
        releaseAliases.set(stored, requested);
    }
    const groupPath = (stored: string) => releaseAliases.get(stored) ?? path.resolve(stored);
    const groups = Map.groupBy(
      snapshot.threads.filter((thread) => thread.worktreePath !== null),
      (thread) => groupPath(thread.worktreePath!),
    );
    const deletedByPath = Map.groupBy(deletedThreads, (thread) =>
      pathKey(groupPath(thread.worktreePath!)),
    );
    const candidates = [
      ...[...groups].map(
        ([worktreePath, group]) =>
          // A deleted thread still owns the worktree its remaining subagents share,
          // but only deletion cleanup acts on it; otherwise the live rules apply.
          deletedByPath
            .get(pathKey(worktreePath))
            ?.find(
              (deleted) =>
                resolveWorktreeCleanup(serverSettings, deleted.projectId).worktreeOnDelete &&
                worktreeOwner([deleted, ...group]) === deleted,
            ) ??
          worktreeOwner(group) ??
          group[0]!,
      ),
      ...deletedThreads.filter((thread) => !groups.has(groupPath(thread.worktreePath!))),
    ];
    for (const thread of candidates) {
      const settings = resolveWorktreeCleanup(serverSettings, thread.projectId);
      const storedPath = path.resolve(thread.worktreePath!);
      const worktreePath = groupPath(thread.worktreePath!);
      if (!hasRequests && (requestsOnly || !worktreeCleanupEnabled(settings))) continue;
      const canonical = hasRequests
        ? yield* (
            requestedByOwner.has(thread.id)
              ? releasePath(worktreePath)
              : observedCheckoutPath(worktreePath).pipe(Effect.map((real) => real ?? worktreePath))
          ).pipe(Effect.orElseSucceed(() => null))
        : worktreePath;
      const key = hasRequests && canonical !== null ? worktreeReleaseName(canonical) : "";
      const namedKey =
        hasRequests && canonical !== storedPath ? worktreeReleaseName(storedPath) : key;
      const group = groups.get(worktreePath) ?? [];
      const invalid =
        canonical === null ||
        invalidRequests.has(key) ||
        invalidRequests.has(namedKey) ||
        (invalidRequests.size > 0 &&
          group.some((member) =>
            invalidRequests.has(worktreeReleaseName(path.resolve(member.worktreePath!))),
          ));
      const release = releases.get(key) ?? releases.get(namedKey);
      if (!invalid && !release && (requestsOnly || !worktreeCleanupEnabled(settings))) continue;
      const activityAt = Math.max(...group.map(storageCleanupActivityAt));
      const deleted = "workspaceRoot" in thread;
      const members = deleted ? [thread, ...group] : group;
      const project = deleted
        ? { workspaceRoot: thread.workspaceRoot }
        : snapshot.projects.find((entry) => entry.id === thread.projectId);
      const entry: StorageCleanupReportEntry = {
        kind: "worktree",
        outcome: "kept",
        reason: "",
        path: storedPath,
        projectPath: project?.workspaceRoot ?? null,
        threadId: thread.id,
        threadTitle: thread.title,
        bytes: null,
        files: null,
      };
      const keep = (reason: string) => {
        if (deleted && settings.worktreeOnDelete) kept.push(worktreePath);
        entries.push({ ...entry, reason: sentence(reason) });
      };
      if (invalid) {
        keep(
          canonical === null
            ? "cannot resolve checkout for release request"
            : "invalid worktree release request",
        );
        continue;
      }
      // Reasons a provider session stop or finished deletion work can clear.
      const waitForStop = (reason: string) => {
        if (deleted && settings.worktreeOnDelete) waiting = true;
        return reason;
      };
      yield* Effect.gen(function* () {
        let exists = yield* fs.exists(worktreePath).pipe(
          Effect.catchIf(
            (error) => !release && hasNonDirectoryParent(error),
            () => Effect.succeed(false),
          ),
        );
        if (!exists && release?.file.endsWith(".releasing") && project) {
          if ((yield* allowMissingRequest(fs.readFileString(release.file))) !== release.contents)
            return keep(withdrawn);
          exists = yield* restoreStagedWindowsCheckout(project.workspaceRoot, release.request);
        }
        if (!exists) {
          if (release?.file.endsWith(".releasing")) {
            if (!project) return keep("project is unavailable");
            const hold = yield* finishInterruptedRemoval(project.workspaceRoot, release.request);
            if ((yield* allowMissingRequest(fs.readFileString(release.file))) !== release.contents)
              return keep(withdrawn);
            if (hold) return keep(hold);
            if (
              (yield* allowMissingRequest(
                fs.rename(release.file, release.file.replace(/\.releasing$/, ".released")),
              )) === null
            )
              return keep(withdrawn);
          } else if (release) yield* allowMissingRequest(fs.remove(release.file));
          return;
        }
        if (
          release &&
          (deleted ||
            (release.request.family
              ? group.length < 2 ||
                thread.lineage.parentThreadId !== null ||
                thread.lineage.rootThreadId !== thread.id
              : group.length !== 1) ||
            release.request.threadId !== thread.id ||
            release.request.branch !== thread.branch)
        )
          return keep(
            release.request.family
              ? "checkout does not have the requested family owner"
              : "checkout does not have the requested sole owner",
          );
        if (deleted && !settings.worktreeOnDelete) return keep("no rules apply");
        if (members.length > 1 && worktreeOwner(members) === undefined)
          return keep(`shared by ${members.length} threads`);
        if (project === undefined) return keep("project is unavailable");
        if (
          thread.branch === null ||
          !group.every((member) => storageCleanupThreadIdle(member, now, serverSettings))
        )
          return keep(waitForStop("thread is running or has pending work"));
        if (group.some((member) => member.branch !== thread.branch))
          return keep("a subagent thread's branch differs from this worktree's branch");
        if (hasTerminal(worktreePath)) return keep(waitForStop("open terminal"));
        // Compare canonical roots while allowing symlinked parents, never symlinked worktree directories.
        const realPath = yield* realWorkspacePath(worktreePath);
        const realParent = yield* realWorkspacePath(path.dirname(worktreePath));
        if (realPath !== path.join(realParent, path.basename(worktreePath)))
          return keep("worktree is a symbolic link");
        if (release && !(yield* isManagedWorktreePath(worktreePath)))
          return keep("checkout is outside the managed layout for resuming this thread");
        if (!roots.some((root) => inside(root, realPath)))
          return keep("outside the managed worktree folder");
        if (yield* containsProjectRoot(realPath, [project, ...snapshot.projects]))
          return keep("contains a project checkout");
        if ((yield* fs.stat(path.join(worktreePath, ".git"))).type !== "File")
          return keep("not a linked worktree");
        if (yield* branchChanged(worktreePath, thread.branch))
          return keep("repository or branch changed");
        const changes = release ? null : yield* localChangesReason(worktreePath, settings);
        if (changes !== null) return keep(changes);
        if (
          group.some(
            (member) =>
              member.settledAt !== null &&
              now - Math.max(DateTime.toEpochMillis(member.updatedAt), activityAt) <
                SETTLE_SCRIPT_GRACE_MS,
          )
        )
          return keep(waitForStop("settled moments ago"));
        const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
        const old =
          !deleted &&
          settings.worktreeAfterDays !== null &&
          activityAt < now - settings.worktreeAfterDays * DAY_MS;
        const settledFor =
          deleted || thread.settledAt === null
            ? null
            : now - Math.max(DateTime.toEpochMillis(thread.settledAt), activityAt);
        const settledDays = settledFor === null ? null : Math.floor(settledFor / DAY_MS);
        const settled =
          settledFor !== null &&
          settings.worktreeSettledAfterDays !== null &&
          settledFor >= settings.worktreeSettledAfterDays * DAY_MS;
        if (
          release &&
          (head.commitSha !== release.request.head || realPath !== release.request.worktreePath)
        )
          return keep("requested checkout or commit changed");
        let eligible = release !== undefined || deleted || old || settled;
        let removalReason = release
          ? "owner released the completed run"
          : deleted
            ? "thread was deleted"
            : old
              ? `inactive for ${Math.floor((now - activityAt) / DAY_MS)} days`
              : `settled for ${settledDays} days`;
        if (!eligible && (settings.worktreeUnchanged || settings.worktreeOnMerge)) {
          const repositoryCwd = path.resolve(project.workspaceRoot);
          const remotes = yield* git.execute({
            operation: "StorageCleanup.listRemotes",
            cwd: repositoryCwd,
            args: ["remote"],
          });
          const remote =
            remotes.stdout.trim() === ""
              ? null
              : yield* git.resolvePrimaryRemoteName(repositoryCwd);
          let branch: string | null | undefined;
          let defaultRef: string;
          if (remote === null) {
            if (!settings.worktreeUnchanged)
              return keep("no remote is configured for merged-worktree cleanup");
            const projectHead = yield* git.execute({
              operation: "StorageCleanup.resolveProjectBranch",
              cwd: repositoryCwd,
              args: ["symbolic-ref", "--quiet", "HEAD"],
              allowNonZeroExit: true,
            });
            if (projectHead.exitCode !== 0) return keep("project branch is unavailable");
            defaultRef = projectHead.stdout.trim();
            branch = defaultRef.slice("refs/heads/".length);
          } else {
            const defaultBranchKey = `${repositoryCwd}\0${remote}`;
            branch = defaultBranches.get(defaultBranchKey);
            if (branch === undefined) {
              branch = yield* git.resolveDefaultBranchName(repositoryCwd, remote);
              // Without a local HEAD ref, only the remote can identify its default;
              // a conventional name may be a feature branch.
              if (branch === null) {
                branch = yield* git
                  .executeRemote({
                    operation: "StorageCleanup.resolveDefaultBranch",
                    cwd: repositoryCwd,
                    args: ["ls-remote", "--symref", "--", remote, "HEAD"],
                    timeoutMs: 20_000,
                    fallbackErrorDetail: "Git could not read the remote's default branch.",
                  })
                  .pipe(
                    Effect.map(
                      (result) =>
                        /^ref: refs\/heads\/(.+)\tHEAD\r?$/m.exec(result.stdout)?.[1] ?? null,
                    ),
                    Effect.orElseSucceed(() => null),
                  );
              }
              defaultBranches.set(defaultBranchKey, branch);
            }
            if (branch === null) return keep("default branch is unavailable");
            defaultRef = `refs/remotes/${remote}/${branch}`;
            const refreshed = refreshedDefaultRefs.get(repositoryCwd) ?? new Set<string>();
            if (!refreshed.has(defaultRef)) {
              yield* git.fetchRemoteTrackingBranch({
                cwd: repositoryCwd,
                remoteName: remote,
                remoteBranch: branch,
              });
              refreshed.add(defaultRef);
              refreshedDefaultRefs.set(repositoryCwd, refreshed);
            }
          }
          const base = yield* git.resolveCommit({
            cwd: worktreePath,
            revision: defaultRef,
          });
          const ancestor = yield* git.execute({
            operation: "StorageCleanup.integratedBranch",
            cwd: worktreePath,
            args: ["merge-base", "--is-ancestor", head.commitSha, base.commitSha],
            allowNonZeroExit: true,
          });
          // Work that reached the default branch under other SHAs (cherry-pick, a rebase shipped
          // from another worktree) counts as integrated too.
          const integrated =
            ancestor.exitCode === 0 ||
            (yield* git.countUnmergedCommits({ cwd: worktreePath, baseRef: base.commitSha })) === 0;
          eligible = integrated && settings.worktreeUnchanged;
          if (eligible)
            removalReason =
              remote === null
                ? "no commits beyond the project branch"
                : "its changes are on the default branch";
          if (!eligible && remote !== null && settings.worktreeOnMerge && thread.branch !== null) {
            const pullRequest = yield* gitManager.branchPullRequest(
              { cwd: worktreePath, branch: thread.branch },
              { refresh: true },
            );
            eligible = storageCleanupPullRequestMerged(pullRequest, {
              branch: thread.branch,
              defaultBranch: branch,
              headSha: head.commitSha,
              integrated,
            });
            if (eligible) removalReason = "pull request was merged";
          }
          if (!eligible && remote === null) return keep("has commits beyond the project branch");
        }
        if (!eligible)
          return keep(
            !deleted && settings.worktreeAfterDays !== null
              ? `inactive for ${Math.floor((now - activityAt) / DAY_MS)} of ${settings.worktreeAfterDays} days`
              : settings.worktreeSettledAfterDays !== null
                ? settledFor === null
                  ? "not settled"
                  : `settled for ${settledDays} of ${settings.worktreeSettledAfterDays} days`
                : settings.worktreeOnMerge
                  ? "not merged"
                  : "has commits beyond the default branch",
          );
        // Re-read this path's threads and sessions so new activity cancels removal; full per-worktree snapshots take seconds.
        // Runs under the workspace lease a turn start waits for, so it reads on interactive readers.
        const blockedSinceCheck = Effect.fnUntraced(function* () {
          const latestProjects = yield* projectStore.listShells();
          if (yield* containsProjectRoot(worktreePath, [project, ...latestProjects]))
            return "contains a project checkout";
          const paths = yield* projections.getThreadWorktreePaths({ includeArchived: true });
          const latest = [];
          const bindingChecks = new Map<string, boolean>();
          const boundToCheckout = Effect.fnUntraced(function* (stored: string) {
            const known = bindingChecks.get(stored);
            if (known !== undefined) return known;
            const bound = yield* sameReleaseCheckout(stored, realPath);
            bindingChecks.set(stored, bound);
            return bound;
          });
          for (const other of paths) {
            if (!release) {
              if (path.resolve(other.worktreePath) === worktreePath) latest.push(other);
              continue;
            }
            const approved =
              other.threadId === thread.id ||
              release.request.family?.some((member) => member.threadId === other.threadId);
            if (approved) {
              if (!(yield* boundToCheckout(other.worktreePath)))
                return "approved checkout binding changed";
              latest.push(other);
              continue;
            }
            const canonical = yield* observedCheckoutPath(path.resolve(other.worktreePath));
            if (canonical === null) continue;
            if (
              pathKey(canonical) === pathKey(realPath) ||
              inside(realPath, canonical) ||
              inside(canonical, realPath)
            )
              return "checkout is shared by another thread";
          }
          if (hasTerminal(worktreePath)) return waitForStop("open terminal");
          if (deleted) {
            if (
              !resolveWorktreeCleanup(yield* settingsService.getSettings, thread.projectId)
                .worktreeOnDelete
            )
              return "thread or cleanup settings changed since check";
            // Durable deletion cleanup must succeed or be explicitly cancelled before removing its checkout.
            const pendingCleanup = yield* sql<{ status: string }>`
              SELECT status FROM orchestration_v2_effect_outbox
              WHERE thread_id = ${thread.id} AND status NOT IN ('succeeded', 'cancelled')
            `.pipe(NodeSqliteClient.readOnly);
            // Failed effects never retry, so only running work can finish and free the path.
            if (pendingCleanup.some((row) => row.status !== "failed"))
              return waitForStop("thread deletion is still pending");
            if (pendingCleanup.length > 0) return "thread deletion is still pending";
          }
          const latestShells = yield* Effect.forEach(latest, (entry) =>
            projections.getThreadShell(entry.threadId),
          );
          const latestGroup = latestShells.filter((shell) => shell !== null);
          if (release) {
            for (const shell of latestGroup)
              if (shell.worktreePath === null || !(yield* boundToCheckout(shell.worktreePath)))
                return "approved checkout binding changed";
          }
          const latestOwner = worktreeOwner(deleted ? [thread, ...latestGroup] : latestGroup);
          if (
            latestGroup.length !== group.length ||
            latestOwner?.id !== thread.id ||
            latestOwner?.branch !== thread.branch ||
            latestGroup.some((shell) => {
              const previous = group.find((member) => member.id === shell.id);
              return (
                previous === undefined ||
                shell.branch !== thread.branch ||
                !Equal.equals(shell.settledAt, previous.settledAt) ||
                (shell.settledAt !== null && !Equal.equals(shell.updatedAt, previous.updatedAt)) ||
                !storageCleanupThreadIdle(shell, now, serverSettings) ||
                (!release && path.resolve(shell.worktreePath!) !== worktreePath) ||
                storageCleanupActivityAt(shell) !== storageCleanupActivityAt(previous)
              );
            })
          )
            return waitForStop("thread activity or shared worktree changed since check");
          if (release) {
            // A closed, unused side chat keeps its worktree binding. Recheck its provenance and
            // deletion effects on the same lease as the live owners, including the final recheck.
            const leafSuffix = path.sep + path.basename(worktreePath);
            const tombstones = yield* sql<{ deletedWorktree: string; unused: string | null }>`
              SELECT json_extract(t.payload_json, '$.worktreePath') AS "deletedWorktree",
                CASE WHEN NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id)
                  AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_messages m WHERE m.thread_id = t.thread_id)
                  AND NOT EXISTS (SELECT 1 FROM command_runs c WHERE c.thread_id = t.thread_id)
                  AND NOT EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox e
                    WHERE e.thread_id = t.thread_id AND e.status != 'succeeded')
                  AND EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox e WHERE e.thread_id = t.thread_id
                    AND e.status = 'succeeded' AND e.effect_type IN ('scheduled-tasks.cleanup','terminal.cleanup','preview.cleanup')
                    GROUP BY e.command_id HAVING count(DISTINCT e.effect_type) = 3)
                  THEN t.payload_json END AS unused
              FROM orchestration_v2_projection_threads t WHERE t.deleted_at IS NOT NULL
                AND substr(json_extract(t.payload_json, '$.worktreePath'), -length(${leafSuffix})) = ${leafSuffix} COLLATE NOCASE
            `.pipe(NodeSqliteClient.readOnly);
            const closedSideChats = [];
            for (const row of tombstones) {
              if (!(yield* boundToCheckout(row.deletedWorktree))) {
                if (yield* usesReleasePath(realPath, row.deletedWorktree))
                  return "a deleted thread has an overlapping checkout";
                continue;
              }
              const side = row.unused === null ? null : yield* decodeCleanupThread(row.unused);
              if (
                !side ||
                side.deletedAt === null ||
                side.projectId !== thread.projectId ||
                side.branch !== thread.branch ||
                side.lineage.sideChat !== true ||
                side.lineage.relationshipToParent !== "fork" ||
                side.lineage.rootThreadId !== thread.id
              )
                return "checkout still has a deleted owner";
              closedSideChats.push(side);
            }
            if (
              closedSideChats.length &&
              worktreeOwner([...latestGroup, ...closedSideChats])?.id !== thread.id
            )
              return "deleted side chat does not belong to the checkout family";
            const { family } = release.request;
            if (family && family.length !== latestGroup.length)
              return "approved worktree family changed";
            for (const current of latestGroup) {
              const approved = family?.find((member) => member.threadId === current.id);
              if (
                family &&
                (!approved ||
                  approved.projectId !== thread.projectId ||
                  current.projectId !== thread.projectId ||
                  !familyMemberSettled(current, thread) ||
                  !Equal.equals(current.lineage, approved.lineage) ||
                  (current.id === thread.id && approved.runId !== release.request.runId))
              )
                return "approved worktree family changed or is unsettled";
              const hold = yield* deliveryHold(current, {
                ...release.request,
                runId: approved?.runId ?? release.request.runId,
              });
              if (hold !== null) return hold;
            }
            const activity = yield* workspaceActivityHold(
              release.request.worktreePath,
              new Set(latestGroup.map((member) => member.id)),
              checkoutActivityFloor(release.request.identity),
            );
            if (activity !== null) return activity;
            if ((yield* allowMissingRequest(fs.readFileString(release.file))) !== release.contents)
              return withdrawn;
          }
          // Sessions can outlive their run and can be shared across app threads.
          const sessionRows = yield* sql<{ payload_json: string }>`
            SELECT payload_json FROM orchestration_v2_projection_provider_sessions
            WHERE status != 'stopped'
          `.pipe(NodeSqliteClient.readOnly);
          const sessions = yield* Effect.forEach(sessionRows, (row) =>
            decodeCleanupSession(row.payload_json),
          );
          // Ready persisted sessions may have released their runtime; only live sessions protect the path.
          for (const session of sessions) {
            const cwd = path.resolve(session.cwd);
            if (
              (release
                ? yield* usesReleasePath(worktreePath, cwd)
                : pathKey(cwd) === pathKey(worktreePath) || inside(worktreePath, cwd)) &&
              (yield* providerSessions.isLive(session.id))
            )
              return waitForStop("provider session is still open");
          }
          return null;
        });
        const beginRemoval = release
          ? yield* observeWorkspaceStarts(realPath)
          : Effect.succeed(null);
        const blocked = yield* blockedSinceCheck();
        if (blocked !== null) return keep(blocked);
        const inspection = yield* measureWorktree(worktreePath, true, release === undefined);
        if (inspection.reason !== null) return keep(inspection.reason);
        const bytes = inspection.bytes;
        const blockedWhileMeasuring = yield* blockedSinceCheck();
        if (blockedWhileMeasuring !== null) return keep(blockedWhileMeasuring);
        if (yield* branchChanged(worktreePath, thread.branch))
          return keep("repository or branch changed since check");
        if (
          (yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" })).commitSha !==
          head.commitSha
        )
          return keep("commit changed since check");
        if (!release) {
          const changes = yield* localChangesReason(worktreePath, settings);
          if (changes !== null) return keep(changes);
        }
        const currentSettings = yield* settingsService.getSettings;
        const current = resolveWorktreeCleanup(currentSettings, thread.projectId);
        if (
          currentSettings.autoResumeLimitedThreads !== serverSettings.autoResumeLimitedThreads ||
          currentSettings.snoozeLimitedThreads !== serverSettings.snoozeLimitedThreads ||
          Object.keys(settings).some(
            (key) =>
              current[key as keyof typeof settings] !== settings[key as keyof typeof settings],
          )
        )
          return keep("settings changed since check");
        const submodules = release
          ? { force: false, reason: null, paths: [] }
          : yield* submoduleRemoval(worktreePath, settings);
        if (submodules.reason !== null) return keep(submodules.reason);
        if (submodules.force) {
          const changes = yield* localChangesReason(worktreePath, settings);
          if (changes !== null) return keep(changes);
        }
        if (!release) {
          // Git status ignores metadata. Inspect every populated checkout after the history
          // walk and final status checks, before either clean or forced removal can delete data.
          for (const cwd of [...submodules.paths, worktreePath]) {
            const hold = yield* trackedPosixMetadataHold(cwd);
            if (hold !== null) return keep(cwd === worktreePath ? hold : `submodule ${hold}`);
          }
          if (!submodules.force && settings.worktreeKeepWhen === "tracked-changes") {
            yield* cleanupGit(worktreePath, ["clean", "-ffdx"], "git clean");
            const hold = yield* trackedPosixMetadataHold(worktreePath);
            if (hold !== null) return keep(hold);
          }
        }
        const prepareRemoval = prepareLinkedWorktreeRemoval({
          operation: "StorageCleanup.cleanupGit",
          ...(release ? { release: release.request } : {}),
          cwd: project.workspaceRoot,
          worktreePath: release?.request.worktreePath ?? worktreePath,
          // Git requires force for submodules; recursive checks above cannot make removal atomic.
          force: submodules.force,
          execute: git.execute,
          run: (args) => cleanupGit(project.workspaceRoot, [...args], "git worktree remove"),
        });
        if (release) {
          const removeApproved = Effect.gen(function* () {
            const prepared = yield* Effect.result(prepareRemoval);
            const lastHold = yield* blockedSinceCheck();
            if (lastHold !== null) return lastHold;
            // The Windows preflight can walk the index and wait for Git status. Verify the
            // receipt's checkout and local data after that wait, while the family locks are held.
            const changed = yield* releaseHold(release.request, project.workspaceRoot);
            if (changed !== null) return changed;
            // Report a receipt hold before a lower-level removal refusal (for example, dirty files).
            if (Result.isFailure(prepared)) return yield* prepared.failure;
            const admissionHold = yield* beginRemoval;
            if (admissionHold !== null) return admissionHold;
            const base = release.file.replace(/\.releasing$/, "");
            const claimed = base + ".releasing";
            const won =
              release.file === claimed ||
              (yield* allowMissingRequest(fs.rename(release.file, claimed))) !== null;
            if (
              !won ||
              (yield* allowMissingRequest(fs.readFileString(claimed))) !== release.contents
            )
              return withdrawn;
            yield* prepared.success;
            yield* fs.rename(claimed, base + ".released");
            return null;
          });
          // Parent-before-child matches the dispatch lock order for forks, deletes and follow-ups.
          const byParent = Map.groupBy(group, (member) => member.lineage.parentThreadId);
          const ordered = [thread.id];
          if (release.request.family) {
            for (const id of ordered) {
              for (const child of byParent.get(id) ?? []) ordered.push(child.id);
            }
          }
          const removed = yield* ordered.reduceRight(
            (locked, id) => threadCommands.withLock(id, locked),
            removeApproved,
          );
          if (removed !== null) return keep(removed);
        } else yield* Effect.flatten(prepareRemoval);
        entries.push({ ...entry, outcome: "removed", reason: sentence(removalReason), bytes });
        yield* gitManager.invalidateStatus(project.workspaceRoot);
        // Preserve branch/path so ProviderTurnStartService can recreate the checkout on resume.
        yield* Effect.logInfo("storage cleanup removed worktree", { threadId: thread.id });
      }).pipe(
        (effect) => withWorkspaceLease(worktreePath, Effect.scoped(effect)),
        Effect.catchIf(
          (error) =>
            !release && error instanceof WorkspaceLeasePathError && hasNonDirectoryParent(error),
          () => Effect.void,
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            entries.push({
              ...entry,
              outcome: "failed",
              reason: cleanupFailureReason(error),
            });
            if (deleted && settings.worktreeOnDelete) kept.push(worktreePath);
            yield* Effect.logWarning("storage cleanup failed for worktree", {
              threadId: thread.id,
              error,
            });
          }),
        ),
      );
    }
    if (!requestsOnly)
      yield* reportOrphanWorktrees(
        roots,
        yield* projectStore.list({ includeDeleted: true }),
        entries,
      );
    return { waiting, kept };
  });

  const cleanFiles = Effect.fn("StorageCleanup.cleanFiles")(function* (
    root: string,
    days: number | null,
    now: number,
    rotatedLogs: boolean,
    removed: { files: number; bytes: number },
  ) {
    if (days === null || !(yield* fs.exists(root))) return removed;
    // A symlinked parent (a linked T3 home) is fine; a symlinked folder is not.
    const realRoot = yield* fs.realPath(root);
    const realParent = yield* fs.realPath(path.dirname(root));
    if (realRoot !== path.join(realParent, path.basename(root))) return removed;
    const visit = Effect.fn("StorageCleanup.visitFiles")(function* (
      directory: string,
    ): Effect.fn.Return<void, PlatformError | ServerSettingsError> {
      for (const name of yield* fs.readDirectory(directory)) {
        const target = path.join(directory, name);
        if ((yield* fs.realPath(target)) !== target || !inside(realRoot, target)) continue;
        const stat = yield* fs.stat(target);
        if (stat.type === "Directory" && rotatedLogs) {
          yield* visit(target);
        } else if (stat.type === "File" && (!rotatedLogs || /\.(?:log|ndjson)\.\d+$/.test(name))) {
          const modified = Option.getOrNull(stat.mtime);
          if (modified !== null && modified.getTime() < now - days * DAY_MS) {
            const current = (yield* settingsService.getSettings).storageCleanup;
            if ((rotatedLogs ? current.logsAfterDays : current.browserArtifactsAfterDays) !== days)
              return;
            yield* fs.remove(target);
            removed.files++;
            removed.bytes += Number(stat.size);
          }
        }
      }
    });
    yield* visit(realRoot);
    return removed;
  });

  const reportRef = yield* SubscriptionRef.make<StorageCleanupReport | null>(null);
  // Only deleted threads' worktrees wait on session stops: any stop while one waits, or a stop inside one kept for another reason.
  // A deletion stays pending until a sweep that started after it finishes.
  let deletedWorktreeWaits = true;
  let keptDeletedWorktrees: ReadonlyArray<string> = [];
  let deletions = 0;
  let sweptDeletions = 0;
  const sweep = Effect.fn("StorageCleanup.sweep")(function* (
    trigger: StorageCleanupReport["trigger"],
    requestsOnly = false,
  ) {
    const deletionsAtStart = deletions;
    const now = yield* Clock.currentTimeMillis;
    const serverSettings = yield* settingsService.getSettings;
    const settings = serverSettings.storageCleanup;
    const entries: StorageCleanupReportEntry[] = [];
    const deletedWorktrees = yield* cleanWorktrees(serverSettings, now, entries, requestsOnly).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          entries.push({
            kind: "worktree",
            outcome: "failed",
            reason: cleanupFailureReason(error),
            path: null,
            projectPath: null,
            threadId: null,
            threadTitle: null,
            bytes: null,
            files: null,
          });
          yield* Effect.logWarning("worktree cleanup failed", { error });
          return { waiting: true, kept: [] };
        }),
      ),
    );
    if (!requestsOnly) {
      deletedWorktreeWaits = deletedWorktrees.waiting;
      keptDeletedWorktrees = deletedWorktrees.kept;
      sweptDeletions = deletionsAtStart;
    }
    for (const category of [
      {
        kind: "browser-artifacts" as const,
        root: config.browserArtifactsDir,
        days: settings.browserArtifactsAfterDays,
        label: "browser artifacts",
      },
      {
        kind: "logs" as const,
        root: config.logsDir,
        days: settings.logsAfterDays,
        label: "rotated logs",
      },
    ]) {
      if (requestsOnly || category.days === null) continue;
      const removed = { files: 0, bytes: 0 };
      yield* cleanFiles(category.root, category.days, now, category.kind === "logs", removed).pipe(
        Effect.map(({ files, bytes }) =>
          entries.push({
            kind: category.kind,
            outcome: files > 0 ? "removed" : "kept",
            reason: files === 0 ? "No expired files" : `Removed ${files} ${category.label}`,
            path: null,
            projectPath: null,
            threadId: null,
            threadTitle: null,
            bytes: files > 0 ? bytes : null,
            files: files > 0 ? files : null,
          }),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            entries.push({
              kind: category.kind,
              outcome: "failed",
              reason: cleanupFailureReason(error),
              path: null,
              projectPath: null,
              threadId: null,
              threadTitle: null,
              bytes: removed.files > 0 ? removed.bytes : null,
              files: removed.files > 0 ? removed.files : null,
            });
            yield* Effect.logWarning("storage file cleanup failed", { kind: category.kind, error });
          }),
        ),
      );
    }
    const counts = { removed: 0, kept: 0, failed: 0 };
    let bytesFreed = 0;
    for (const entry of entries) {
      counts[entry.outcome]++;
      if (entry.outcome !== "kept") bytesFreed += entry.bytes ?? 0;
    }
    const priority = (entry: StorageCleanupReportEntry) =>
      entry.outcome === "failed"
        ? 0
        : entry.outcome === "removed"
          ? 1
          : entry.kind === "worktree" && entry.threadId === null
            ? 2
            : 3;
    const latestReport: StorageCleanupReport = {
      trigger,
      startedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      finishedAt: DateTime.formatIso(yield* DateTime.now),
      entries: entries.sort((a, b) => priority(a) - priority(b)).slice(0, REPORT_ENTRY_LIMIT),
      counts,
      bytesFreed,
      omittedCount: Math.max(0, entries.length - REPORT_ENTRY_LIMIT),
    };
    yield* SubscriptionRef.set(reportRef, latestReport);
    return latestReport;
  });
  const automaticSweepQueued = yield* Ref.make(false);
  const worker = yield* makeDrainableWorker(
    (
      completion:
        | Deferred.Deferred<StorageCleanupReport, ServerSettingsError>
        | "release"
        | undefined,
    ) =>
      (completion === undefined ? Ref.set(automaticSweepQueued, false) : Effect.void).pipe(
        Effect.andThen(
          sweep(
            completion === undefined || completion === "release" ? "automatic" : "manual",
            completion === "release",
          ),
        ),
        Effect.exit,
        Effect.flatMap((exit) =>
          completion === undefined || completion === "release"
            ? exit.pipe(
                Effect.asVoid,
                Effect.catchCause((cause) =>
                  Effect.logWarning("storage cleanup failed", { cause }),
                ),
              )
            : Deferred.done(completion, exit).pipe(Effect.asVoid),
        ),
      ),
  );
  const requestSweep = Ref.getAndSet(automaticSweepQueued, true).pipe(
    Effect.flatMap((queued) => (queued ? Effect.void : worker.enqueue(undefined))),
  );
  const runNow = Effect.gen(function* () {
    const completion = yield* Deferred.make<StorageCleanupReport, ServerSettingsError>();
    yield* worker.enqueue(completion);
    return yield* Deferred.await(completion);
  });

  const start = Effect.fn("StorageCleanup.start")(function* () {
    const unsubscribe = yield* terminals.subscribeMetadata((event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") {
          liveTerminals.clear();
          for (const terminal of event.terminals) noteTerminal(terminal);
        } else if (event.type === "upsert") {
          noteTerminal(event.terminal);
        } else {
          const threadTerminals = liveTerminals.get(event.threadId);
          threadTerminals?.delete(event.terminalId);
          if (threadTerminals?.size === 0) liveTerminals.delete(event.threadId);
        }
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    const changes = yield* settingsService.subscribeChanges;
    const events = engine.streamDomainEvents;
    let lastSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    yield* forkParked(
      requestSweep.pipe(
        Effect.andThen(worker.drain),
        Effect.repeat(Schedule.spaced("1 hour")),
        Effect.asVoid,
      ),
    );
    // A request can arrive after its final event or while the server is stopped.
    yield* forkParked(
      pendingRequestFiles.pipe(
        Effect.flatMap((files) =>
          files.length ? worker.enqueue("release").pipe(Effect.andThen(worker.drain)) : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("worktree release queue inspection failed", { cause }),
        ),
        Effect.repeat(Schedule.spaced("1 minute")),
      ),
    );
    yield* forkParked(
      Stream.runForEach(changes, (settings) => {
        if (
          Equal.equals(settings.storageCleanup, lastSettings.storageCleanup) &&
          Equal.equals(settings.worktreeCleanup, lastSettings.worktreeCleanup) &&
          sameProjectWorktreePolicies(settings, lastSettings)
        )
          return Effect.void;
        lastSettings = settings;
        return requestSweep;
      }),
    );
    yield* forkParked(
      Stream.runForEach(events, (event) => {
        if (event.type === "thread.deleted") deletions++;
        else if (
          event.type !== "provider-session.updated" ||
          (event.payload.status !== "stopped" && event.payload.status !== "error")
        )
          return Effect.void;
        else if (!deletedWorktreeWaits && deletions === sweptDeletions) {
          const cwd = pathKey(event.payload.cwd);
          if (
            !keptDeletedWorktrees.some(
              (worktreePath) => pathKey(worktreePath) === cwd || inside(worktreePath, cwd),
            )
          )
            return Effect.void;
        }
        return anyWorktreePolicy(lastSettings, (rules) => rules.worktreeOnDelete)
          ? requestSweep
          : Effect.void;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Storage cleanup event stream failed", { cause }),
        ),
      ),
    );
  });
  yield* start();
  return StorageCleanup.of({
    runNow,
    latestReport: SubscriptionRef.get(reportRef),
    reports: SubscriptionRef.changes(reportRef),
    drain: worker.drain,
  });
});

export const layer = Layer.effect(StorageCleanup, make).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
);
