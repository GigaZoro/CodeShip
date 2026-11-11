import {
  CheckpointId,
  CheckpointScopeId,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2RestartCancelledBackgroundWork,
  type OrchestrationV2Run,
  ProviderThreadId,
  type RunId,
  ThreadId,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import type * as ServerConfig from "../config.ts";
import type * as ServerSettings from "../serverSettings.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import {
  isCheckpointRestoreIsolated,
  SHARED_WORKSPACE_RESTORE_MESSAGE,
} from "./CheckpointRestoreSafety.ts";
import { CheckpointRestoreError, CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { GIT_INDEX_LOCKED_DETAIL } from "../vcs/VcsProcess.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import {
  type BackgroundWorkStop,
  cancelledRosterTaskWork,
  latestStartedRun,
  lostBackgroundWorkRecord,
  workStartedBy,
} from "./RestartBackgroundNote.ts";
import { RuntimePolicyAboveCeilingError, RuntimePolicyV2 } from "./RuntimePolicy.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

export const ROLLBACK_FAILED_MESSAGE =
  "The provider could not roll back this conversation. Try again; if it keeps failing, check the provider and server logs.";

export class CheckpointRollbackExecutionError extends Schema.TaggedError<CheckpointRollbackExecutionError>()(
  "CheckpointRollbackExecutionError",
  {
    reason: Schema.Literals([
      "rollback-target-invalid",
      "active-provider-changed",
      "provider-turn-unavailable",
      "unexpected-failure",
      "shared-workspace",
    ]),
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    checkpointId: CheckpointId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "rollback-target-invalid":
        return `Rollback target ${this.checkpointId} for provider thread ${this.providerThreadId} on thread ${this.threadId} is incomplete or invalid.`;
      case "active-provider-changed":
        return `Active provider changed before rollback target ${this.checkpointId} could execute on thread ${this.threadId}.`;
      case "provider-turn-unavailable":
        return `Provider turn for rollback target ${this.checkpointId} is unavailable on provider thread ${this.providerThreadId}.`;
      case "shared-workspace":
        return SHARED_WORKSPACE_RESTORE_MESSAGE;
      case "unexpected-failure":
        return ROLLBACK_FAILED_MESSAGE;
    }
  }
}

const isCheckpointRollbackExecutionError = Schema.is(CheckpointRollbackExecutionError);
const isVcsProcessExitError = Schema.is(VcsProcessExitError);
const isCheckpointRestoreError = Schema.is(CheckpointRestoreError);
const isRuntimePolicyAboveCeilingError = Schema.is(RuntimePolicyAboveCeilingError);

/**
 * The message clients see when a rollback fails. Only a held Git index lock
 * gets its own explanation; other reasons carry internal ids or raw Git
 * output, so they fall back to the generic message.
 */
export function rollbackFailureClientMessage(error: CheckpointRollbackExecutionError): string {
  if (isRuntimePolicyAboveCeilingError(error.cause)) return error.cause.message;
  const restoreCause = isCheckpointRestoreError(error.cause) ? error.cause.cause : undefined;
  return isVcsProcessExitError(restoreCause) && restoreCause.detail === GIT_INDEX_LOCKED_DETAIL
    ? GIT_INDEX_LOCKED_DETAIL
    : ROLLBACK_FAILED_MESSAGE;
}

export interface CheckpointRollbackServiceV2Shape {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly checkpointId: CheckpointId;
    readonly scopeId: CheckpointScopeId;
    readonly restoreFiles?: boolean;
  }) => Effect.Effect<void, CheckpointRollbackExecutionError>;
}

export class CheckpointRollbackServiceV2 extends Context.Service<
  CheckpointRollbackServiceV2,
  CheckpointRollbackServiceV2Shape
>()("t3/orchestration-v2/CheckpointRollbackService/CheckpointRollbackServiceV2") {}

export const layer: Layer.Layer<
  CheckpointRollbackServiceV2,
  never,
  | CheckpointServiceV2
  | GitWorkflowService.GitWorkflowService
  | EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProjectionStoreV2
  | ProviderSessionManagerV2
  | RuntimePolicyV2
  | FileSystem.FileSystem
  | Path.Path
  | ProjectStore.ProjectStoreV2
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
  | ThreadCommandExecutor.ThreadCommandExecutor
> = Layer.effect(
  CheckpointRollbackServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const projections = yield* ProjectionStoreV2;
    const sessions = yield* ProviderSessionManagerV2;
    const runtimePolicy = yield* RuntimePolicyV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const path = yield* Path.Path;
    const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

    /** The events that record `work` on `run` as lost with the process a rollback closed. */
    const lostWorkEvents = Effect.fnUntraced(function* (input: {
      readonly run: OrchestrationV2Run;
      readonly cause: BackgroundWorkStop;
      readonly work: ReadonlyArray<OrchestrationV2RestartCancelledBackgroundWork>;
      readonly now: DateTime.Utc;
    }) {
      const { run, now } = input;
      if (input.work.length === 0) return [];
      const record = lostBackgroundWorkRecord(input);
      const base = {
        threadId: run.threadId,
        runId: run.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
      };
      const eventId = ids.allocate.event({ threadId: run.threadId });
      const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
        {
          ...base,
          id: yield* eventId,
          type: "run.background-work-cancelled",
          payload: {
            runId: run.id,
            restartCancelledBackgroundWork: record.restartCancelledBackgroundWork,
          },
        },
        ...(record.notice === undefined
          ? []
          : [
              {
                ...base,
                id: yield* eventId,
                type: "turn-item.updated" as const,
                ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
                payload: record.notice,
              },
            ]),
      ];
      return events;
    });

    /**
     * A rollback that fails after the provider closed its process rewound nothing, so the latest
     * run takes the work that process ran and no run holds yet, in the write that empties the
     * roster. One whose own write committed before the failure recorded the loss already.
     */
    const recordWorkLostToFailedRollback = Effect.fn(
      "orchestrationV2.checkpointRollback.recordWorkLostToFailedRollback",
    )(function* (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly keptRunId: RunId | null;
      readonly rolledBackRunIds: ReadonlyArray<RunId>;
      readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
    }) {
      yield* threadCommands.withLock(
        input.threadId,
        Effect.gen(function* () {
          const { threadId, providerThreadId, tasks } = input;
          const now = yield* DateTime.now;
          const { runs, providerThreads } = yield* projections.getThreadRecords(
            threadId,
            ["runs", "providerThreads"],
            {
              runIds: [
                ...(input.keptRunId === null ? [] : [input.keptRunId]),
                ...input.rolledBackRunIds,
              ],
            },
          );
          if (
            runs.some(
              (run) => run.status === "rolled_back" && input.rolledBackRunIds.includes(run.id),
            )
          )
            return;
          const recorded = new Set(
            runs.flatMap((run) =>
              (run.restartCancelledBackgroundWork ?? []).map((work) => work.id),
            ),
          );
          const stored = providerThreads.find((candidate) => candidate.id === providerThreadId);
          const listed = stored?.pendingBackgroundTasks ?? [];
          const lostIds = new Set(tasks.map((task) => task.taskId));
          const remaining = listed.filter((task) => !lostIds.has(task.taskId));
          const run = latestStartedRun(runs, providerThreadId);
          const events: Array<OrchestrationV2DomainEvent> = [];
          if (stored !== undefined && remaining.length !== listed.length) {
            events.push({
              id: yield* ids.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              driver: stored.driver,
              providerInstanceId: stored.providerInstanceId,
              occurredAt: now,
              payload: { ...stored, pendingBackgroundTasks: remaining, updatedAt: now },
            });
          }
          if (run !== undefined) {
            events.push(
              ...(yield* lostWorkEvents({
                run,
                cause: "process-ended",
                work: tasks.map(cancelledRosterTaskWork).filter((work) => !recorded.has(work.id)),
                now,
              })),
            );
          }
          if (events.length > 0) yield* eventSink.write({ events });
        }),
      );
    });

    const execute = Effect.fn("orchestrationV2.checkpointRollback.execute")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly checkpointId: CheckpointId;
      readonly scopeId: CheckpointScopeId;
      readonly restoreFiles?: boolean;
    }) {
      const context = yield* projections.getCheckpointRollbackContext(input.threadId, input);
      const { providerThread, checkpoint, scope, targetAttempt, runsToRollback, staleCheckpoints } =
        context;
      if (
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        checkpoint === undefined ||
        scope === undefined ||
        checkpoint.scopeId !== scope.id ||
        checkpoint.status !== "ready"
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "rollback-target-invalid",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }
      if (
        providerThread.id !== context.thread.activeProviderThreadId ||
        providerThread.providerInstanceId !== context.thread.modelSelection.instanceId
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "active-provider-changed",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      const targetOrdinal = checkpoint.appRunOrdinal ?? 0;
      const rollbackTarget: ProviderAdapter.ProviderAdapterV2RollbackTarget =
        targetOrdinal === 0
          ? {
              type: "thread_start",
              checkpointId: checkpoint.id,
              appRunOrdinal: 0,
            }
          : yield* Effect.gen(function* () {
              const targetTurn =
                latestProviderTurnForAttempt(context.providerTurns, targetAttempt?.id) ??
                context.providerTurns.find((turn) => turn.id === targetAttempt?.providerTurnId);
              if (
                targetAttempt === undefined ||
                targetTurn === undefined ||
                targetTurn.providerThreadId !== providerThread.id
              ) {
                return yield* new CheckpointRollbackExecutionError({
                  reason: "provider-turn-unavailable",
                  threadId: input.threadId,
                  providerThreadId: input.providerThreadId,
                  checkpointId: input.checkpointId,
                });
              }
              const { attempt } = yield* projections.getProviderControlContext(input.threadId, {
                providerThreadId: providerThread.id,
                providerTurnId: targetTurn.id,
                attemptId: targetAttempt.id,
              });
              const message =
                attempt === undefined
                  ? undefined
                  : yield* projections.getRunMessage(input.threadId, attempt.runId);
              return {
                type: "provider_turn" as const,
                checkpointId: checkpoint.id,
                appRunOrdinal: targetOrdinal,
                providerTurn: targetTurn,
                ...(message === undefined ? {} : { message }),
              };
            });

      const { worktreePath, branch } = context.thread;
      // Recreated only where the server would have made it, as turn start does.
      if (
        worktreePath != null &&
        branch != null &&
        !(yield* fileSystem.exists(worktreePath)) &&
        (yield* isManagedWorktreePath(worktreePath))
      ) {
        const project = yield* projects.get(context.thread.projectId);
        if (Option.isSome(project)) {
          yield* gitWorkflow.pruneWorktrees({ cwd: project.value.workspaceRoot });
          yield* gitWorkflow.createWorktree({
            cwd: project.value.workspaceRoot,
            refName: branch,
            path: worktreePath,
          });
        }
      }

      if (
        input.restoreFiles !== false &&
        !(yield* isCheckpointRestoreIsolated(context.thread, scope, {
          fileSystem,
          projections,
          projects,
          path,
        }))
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "shared-workspace",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      const modelSelection = context.thread.modelSelection;
      const resolvedRuntimePolicy = yield* runtimePolicy.resolve({
        thread: context.thread,
        modelSelection,
      });
      const existingSession = context.providerSession;
      const session = yield* sessions.open({
        threadId: input.threadId,
        providerSessionId: providerThread.providerSessionId,
        modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
        ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
        ...(providerThread.nativeThreadRef?.nativeId == null
          ? {}
          : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
        ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
          ? {}
          : {
              initialProviderItemIdentityVersion: providerThread.nativeMetadata.itemIdentityVersion,
            }),
      });

      // Rolled-back turns remain in audit history but no longer exist in the provider conversation.
      const rolledBackAttemptIds = new Set(context.rolledBackAttemptIds);
      const providerThreadTurns = context.providerTurns.filter(
        (turn) =>
          turn.providerThreadId === providerThread.id &&
          (turn.runAttemptId === null || !rolledBackAttemptIds.has(turn.runAttemptId)),
      );

      const snapshot: Pick<
        ProviderAdapter.ProviderAdapterV2ThreadSnapshot,
        "providerThread" | "lostBackgroundTasks"
      > =
        runsToRollback.length === 0
          ? { providerThread }
          : yield* session.rollbackThread({
              providerThread,
              target: rollbackTarget,
              providerThreadTurns,
            });
      const lostTasks = snapshot.lostBackgroundTasks ?? [];
      const rolledBackRunIds = runsToRollback.map((run) => run.id);

      // Lock against full-row thread writes that could restore the old native session after rollback.
      const writeRollback = threadCommands.withLock(
        input.threadId,
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const lostWork = lostTasks.map(cancelledRosterTaskWork);
          // The rewound conversation no longer knows the work rolled-back turns started, now or
          // in an earlier rollback, and a note about it would have the agent start it again.
          // Records of removed runs still count as notes, so theirs are pruned too.
          const prunedRunIds = (yield* projections.getRunsWithLostBackgroundWork(input.threadId))
            .filter((run) => run.status === "rolled_back" || rolledBackRunIds.includes(run.id))
            .map((run) => run.id);
          const reconciles = lostWork.length > 0 || prunedRunIds.length > 0;
          const storedRuns = reconciles
            ? (yield* projections.getThreadRecords(input.threadId, ["runs"], {
                runIds: [...(checkpoint.runId === null ? [] : [checkpoint.runId]), ...prunedRunIds],
              })).runs
            : [];
          const discarded = reconciles
            ? workStartedBy(
                yield* projections.getRunTurnItemIdentities(input.threadId, [
                  ...new Set([...rolledBackRunIds, ...prunedRunIds]),
                ]),
              )
            : () => false;
          const makeEvent = <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
            Effect.map(
              ids.allocate.event({ threadId: event.threadId }),
              (id) =>
                ({
                  ...event,
                  id,
                }) as Event,
            );
          const events: Array<OrchestrationV2DomainEvent> = [];
          events.push(
            yield* makeEvent({
              type: "provider-thread.updated",
              threadId: input.threadId,
              driver: providerThread.driver,
              providerInstanceId: providerThread.providerInstanceId,
              occurredAt: now,
              payload: {
                ...snapshot.providerThread,
                lastRunOrdinal: targetOrdinal === 0 ? null : targetOrdinal,
                updatedAt: now,
              },
            }),
          );
          for (const staleCheckpoint of staleCheckpoints) {
            events.push(
              yield* makeEvent({
                type: "checkpoint.captured",
                threadId: input.threadId,
                ...(staleCheckpoint.runId === null ? {} : { runId: staleCheckpoint.runId }),
                nodeId: staleCheckpoint.nodeId,
                providerInstanceId: providerThread.providerInstanceId,
                occurredAt: now,
                payload: { ...staleCheckpoint, status: "stale" },
              }),
            );
          }
          for (const run of runsToRollback) {
            const rootNode = context.rootNodes.find((candidate) => candidate.id === run.rootNodeId);
            // Left out, the stored record stays; the pruning below is the only change to it.
            const { restartCancelledBackgroundWork: _recorded, ...rolledBack } = run;
            events.push(
              yield* makeEvent({
                type: "run.updated",
                threadId: input.threadId,
                runId: run.id,
                ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: { ...rolledBack, status: "rolled_back", completedAt: now },
              }),
            );
            if (rootNode !== undefined) {
              events.push(
                yield* makeEvent({
                  type: "node.updated",
                  threadId: input.threadId,
                  runId: run.id,
                  nodeId: rootNode.id,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: now,
                  payload: { ...rootNode, status: "rolled_back", completedAt: now },
                }),
              );
            }
          }
          for (const run of storedRuns) {
            const recorded = run.restartCancelledBackgroundWork ?? [];
            const remaining = recorded.filter((work) => !discarded(work));
            if (!prunedRunIds.includes(run.id) || remaining.length === recorded.length) continue;
            events.push(
              yield* makeEvent({
                type: "run.background-work-cancelled",
                threadId: input.threadId,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: { runId: run.id, restartCancelledBackgroundWork: remaining },
              }),
            );
          }
          // The latest run that stays takes what the rollback's own process close stopped.
          const kept = latestStartedRun(
            storedRuns.filter((run) => !rolledBackRunIds.includes(run.id)),
            providerThread.id,
          );
          if (kept !== undefined) {
            events.push(
              ...(yield* lostWorkEvents({
                run: kept,
                cause: "rolled-back",
                work: lostWork.filter((work) => !discarded(work)),
                now,
              })),
            );
          }
          yield* eventSink.write({ events });
        }),
      );

      yield* Effect.gen(function* () {
        if (input.restoreFiles !== false) yield* checkpoints.restore({ scope, checkpoint });
        if (staleCheckpoints.length > 0) {
          yield* checkpoints.deleteStaleRefs({ scope, checkpoints: staleCheckpoints });
        }
        yield* writeRollback;
      }).pipe(
        Effect.onError(() =>
          lostTasks.length === 0
            ? Effect.void
            : recordWorkLostToFailedRollback({
                threadId: input.threadId,
                providerThreadId: providerThread.id,
                keptRunId: checkpoint.runId,
                rolledBackRunIds,
                tasks: lostTasks,
              }).pipe(Effect.ignoreCause({ log: true })),
        ),
      );
    });

    return CheckpointRollbackServiceV2.of({
      // The inner execute owns the rollback span; this wrapper selects the workspace lease.
      execute: Effect.fnUntraced(
        function* (input) {
          // Storage cleanup removes worktrees under the same lease.
          const thread = yield* projections.getThread(input.threadId);
          yield* thread.worktreePath === null
            ? execute(input)
            : withWorkspaceLease(path.resolve(thread.worktreePath), execute(input));
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isCheckpointRollbackExecutionError(cause)
                ? cause
                : new CheckpointRollbackExecutionError({
                    reason: "unexpected-failure",
                    threadId: input.threadId,
                    providerThreadId: input.providerThreadId,
                    checkpointId: input.checkpointId,
                    cause,
                  }),
            ),
          ),
      ),
    });
  }),
);
