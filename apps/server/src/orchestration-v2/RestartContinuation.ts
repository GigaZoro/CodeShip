import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  IDLE_COMPACTION_TEXT,
  isCompactionCommandMessage,
  isOrchestrationV2WorkActive,
  isProviderNativeSubagentThread,
  latestProviderTurnForAttempt,
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";

import * as ServerSettings from "../serverSettings.ts";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  awaitingProviderThreadId,
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  continuationFailedBeforePrompt,
  isAwaitedWork,
  isRestartContinuationSource,
  isRestartNoteSource,
  neverStarted,
  promptNeverDelivered,
  restartCancelledBackgroundWorkNote,
  restartContinuationNote,
  restartRetryNotices,
  supersededRun,
} from "./RestartBackgroundNote.ts";

export const CONTINUE_PROMPT =
  "Continue where you left off. Your last turn was cut short, so a command or other action it started may have finished or may still be running. Before you repeat one that changes state, confirm it did not take effect and is not still running; if you cannot tell, say so instead of repeating it.";

const MAX_CONTINUATION_CHAIN = 3;
// Automatic resumes this close together point at a run that crashes the server.
const RESTART_LOOP_WINDOW_MS = 5 * 60 * 1_000;

/** True while a person asked this restart to resume running threads, overriding the setting. */
export class RestartResumeRequest extends Context.Reference<Effect.Effect<boolean>>(
  "t3/orchestration-v2/RestartResumeRequest",
  { defaultValue: () => Effect.succeed(false) },
) {}

/** Prepares the workspace of a run started again after a restart; the server wires ThreadLaunchService here. */
export class RestartRunPreparation extends Context.Reference<
  (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void>
>("t3/orchestration-v2/RestartRunPreparation", {
  defaultValue: () => (input) =>
    Effect.logError("orchestration-v2.restart-retry.preparation-unavailable", input),
}) {}

/** `settings` is null when unreadable; a requested resume needs none. */
export function continuesAfterRestart(
  resumeRequested: boolean,
  settings: Parameters<typeof resolveProjectSettings>[0] | null,
  projectId: Parameters<typeof resolveProjectSettings>[1],
): boolean {
  return (
    resumeRequested ||
    (settings !== null &&
      resolveProjectSettings(settings, projectId).settings.continueThreadsAfterServerUpdate)
  );
}

/**
 * A question the restart keeps answerable: recovery turns it into one the person answers by
 * message, and that answer continues the thread. Other requests expire, and the resumed agent
 * asks again.
 */
export function answerableAfterRestart(
  request: OrchestrationV2RuntimeRequest,
  thread: Parameters<typeof isProviderNativeSubagentThread>[0],
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): boolean {
  return (
    request.status === "pending" &&
    request.kind === "user_input" &&
    request.responseCapability.type === "live" &&
    !isProviderNativeSubagentThread(thread) &&
    turnItems.some(
      (item) =>
        item.type === "user_input_request" &&
        item.requestId === request.id &&
        item.nodeId === request.nodeId &&
        item.questions.length > 0 &&
        item.questions.every((question) => question.question.trim().length > 0),
    )
  );
}

function restartContinuationBlocked(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    "thread" | "runtimeRequests" | "providerTurns" | "turnItems"
  >,
  source: OrchestrationV2Run,
  now: DateTime.Utc,
  settled: boolean,
): boolean {
  const { thread } = projection;
  if (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
    (thread.snoozedUntil != null && DateTime.isGreaterThan(thread.snoozedUntil, now))
  )
    return true;
  const turn = latestProviderTurnForAttempt(projection.providerTurns, source.activeAttemptId);
  if (
    !settled &&
    turn !== undefined &&
    (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted")
  )
    return true;
  return projection.runtimeRequests.some((request) =>
    answerableAfterRestart(request, thread, projection.turnItems),
  );
}

/** App-owned delegations continue in their own threads and report back. */
function hasOpenAwaitedWork(
  projection: Pick<ProjectionRuntimeRecoveryState, "runs" | "turnItems">,
  providerThread: ProjectionRuntimeRecoveryState["providerThreads"][number],
): boolean {
  const openItem = projection.turnItems.some((item) => {
    if (item.status !== "pending" && item.status !== "running" && item.status !== "waiting")
      return false;
    if (item.type === "subagent" && item.origin === "app_owned" && item.childThreadId !== null)
      return false;
    const work = cancelledTurnItemWork(item);
    return (
      work !== undefined &&
      isAwaitedWork(work) &&
      awaitingProviderThreadId(item, projection.runs) === providerThread.id
    );
  });
  return (
    openItem ||
    (providerThread.ownerNodeId === null &&
      (providerThread.pendingBackgroundTasks ?? []).some((task) =>
        isAwaitedWork(cancelledRosterTaskWork(task)),
      ))
  );
}

type ResumeProjection = Pick<
  ProjectionRuntimeRecoveryState,
  | "thread"
  | "runs"
  | "providerThreads"
  | "providerSessions"
  | "providerTurns"
  | "runtimeRequests"
  | "turnItems"
>;

/**
 * A run a restart cuts before its provider accepted the prompt: still preparing its workspace,
 * starting its session, or running before its first provider turn. It starts again with its own
 * message, so the provider's session and native thread do not matter. Restart continuations keep
 * their own path.
 */
export function restartRetryRun(
  projection: ResumeProjection,
  now: DateTime.Utc,
): OrchestrationV2Run | undefined {
  const run = projection.runs.reduce<OrchestrationV2Run | undefined>(
    (latest, candidate) =>
      (candidate.status === "preparing" ||
        candidate.status === "starting" ||
        candidate.status === "running") &&
      candidate.restartContinuationOfRunId === undefined &&
      (!latest || runRanAfter(candidate, latest))
        ? candidate
        : latest,
    undefined,
  );
  if (
    run === undefined ||
    !promptNeverDelivered(run, projection.providerTurns) ||
    restartContinuationBlocked(projection, run, now, false) ||
    projection.thread.providerInstanceId !== run.providerInstanceId
  )
    return;
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === run.providerThreadId,
  );
  if (
    providerThread === undefined ||
    providerThread.appThreadId !== projection.thread.id ||
    providerThread.ownerNodeId !== null
  )
    return;
  return run;
}

/** The run to resume after a restart: started again, or continued where its turn was cut. */
export function restartResumeRun(
  projection: ResumeProjection,
  now: DateTime.Utc,
): OrchestrationV2Run | undefined {
  return restartRetryRun(projection, now) ?? restartContinuationRun(projection, now);
}

/** Settled runs require a live session so stale crash records cannot wake them. */
export function restartContinuationRun(
  projection: ResumeProjection,
  now: DateTime.Utc,
): OrchestrationV2Run | undefined {
  const run = projection.runs.reduce<OrchestrationV2Run | undefined>(
    (latest, candidate) =>
      candidate.status !== "queued" &&
      !neverStarted(candidate) &&
      (!latest || runRanAfter(candidate, latest))
        ? candidate
        : latest,
    undefined,
  );
  if (!run) return;
  const preparedContinuation =
    run.status === "starting" && run.restartContinuationOfRunId !== undefined;
  const settled = run.status === "completed" || run.status === "waiting";
  if (run.status !== "running" && !preparedContinuation && !settled) return;
  if (restartContinuationBlocked(projection, run, now, settled)) return;
  const liveTurnRequired = !preparedContinuation && !settled;
  if (projection.thread.providerInstanceId !== run.providerInstanceId) return;
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === run.providerThreadId,
  );
  if (
    !providerThread ||
    providerThread.appThreadId !== projection.thread.id ||
    providerThread.ownerNodeId !== null ||
    providerThread.providerInstanceId !== run.providerInstanceId ||
    providerThread.nativeThreadRef?.nativeId == null ||
    providerThread.nativeThreadRef.strength !== "strong" ||
    providerThread.nativeThreadRef.driver !== providerThread.driver ||
    (liveTurnRequired && providerThread.status !== "active") ||
    providerThread.status === "closed" ||
    providerThread.status === "archived"
  )
    return;
  const session = projection.providerSessions.find(
    (candidate) => candidate.id === providerThread.providerSessionId,
  );
  // Adapters remain ready during turns; only stopped or failed sessions rule out liveness.
  if (
    session === undefined ||
    session.providerInstanceId !== run.providerInstanceId ||
    session.driver !== providerThread.driver ||
    (!preparedContinuation && (session.status === "stopped" || session.status === "error"))
  )
    return;
  // Work its provider process lost is already on the run, and nothing later continued it.
  if (settled)
    return hasOpenAwaitedWork(projection, providerThread) ||
      (run.restartCancelledBackgroundWork ?? []).some(isAwaitedWork)
      ? run
      : undefined;
  if (
    liveTurnRequired &&
    !projection.providerTurns.some(
      (turn) =>
        turn.providerThreadId === providerThread.id &&
        turn.runAttemptId === run.activeAttemptId &&
        turn.status === "running",
    )
  )
    return;
  return run;
}

export const continueRestartedRun = Effect.fn("RestartContinuation.continueRestartedRun")(
  function* (input: { readonly threadId: ThreadId; readonly sourceRunId: RunId }) {
    const settings = yield* ServerSettings.ServerSettingsService;
    const enabled = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const resumeRequested = yield* yield* RestartResumeRequest;
    if (!enabled && !resumeRequested) return;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const messageId = MessageId.make(`message:restart-continuation:${input.sourceRunId}`);
    const projection = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "runs", "providerTurns", "attempts", "runtimeRequests", "turnItems"],
      { messageIds: [messageId], turnItemTypes: ["user_input_request"] },
    );
    if (!continuesAfterRestart(resumeRequested, enabled, projection.thread.projectId)) return;
    if (projection.messages.some((message) => message.id === messageId)) return;
    const source = projection.runs.find((run) => run.id === input.sourceRunId);
    if (
      !source ||
      !(
        isRestartContinuationSource(source, projection.providerTurns) ||
        continuationFailedBeforePrompt(source, projection.providerTurns)
      ) ||
      restartContinuationBlocked(
        projection,
        source,
        yield* DateTime.now,
        isRestartNoteSource(source, projection.providerTurns),
      )
    )
      return;
    if (supersededRun(source, projection.runs)) return;
    if (projection.thread.providerInstanceId !== source.providerInstanceId) return;
    // The provider never saw this run's message, so the run starts again instead of continuing.
    const retry =
      source.status === "cancelled" &&
      source.restartContinuationOfRunId === undefined &&
      promptNeverDelivered(source, projection.providerTurns);
    // A turn that keeps crashing the server would otherwise restart it forever.
    let chainLength = 0;
    const loopWindowStart =
      DateTime.toEpochMillis(source.completedAt ?? source.requestedAt) - RESTART_LOOP_WINDOW_MS;
    for (
      let run: OrchestrationV2Run | undefined = retry ? undefined : source;
      run?.restartContinuationOfRunId !== undefined && chainLength < MAX_CONTINUATION_CHAIN;
      run = projection.runs.find((candidate) => candidate.id === run?.restartContinuationOfRunId)
    ) {
      if (DateTime.toEpochMillis(run.requestedAt) < loopWindowStart) break;
      chainLength += 1;
    }
    if (chainLength >= MAX_CONTINUATION_CHAIN) {
      yield* Effect.logWarning("Not continuing a run restarted too many times in a row", {
        threadId: input.threadId,
        sourceRunId: input.sourceRunId,
      });
      return;
    }
    const sourceRecords = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "turnItems"],
      {
        messageIds: [source.userMessageId],
        turnItemRunIds: [source.id],
        turnItemTypes: ["run_interrupt_request", "system_notice"],
      },
    );
    if (
      sourceRecords.turnItems.some(
        (item) => item.runId === source.id && item.type === "run_interrupt_request",
      )
    )
      return;
    // A parent's Stop reaches its open delegated tasks through an effect a restart can cut short.
    const { lineage, forkedFrom } = projection.thread;
    const taskId =
      source.delegatedTaskId ?? (forkedFrom?.type === "node" ? forkedFrom.nodeId : undefined);
    if (
      lineage.relationshipToParent === "subagent" &&
      lineage.parentThreadId !== null &&
      taskId !== undefined
    ) {
      const task = (yield* threads.getThreadRecords(lineage.parentThreadId, ["subagents"], {
        subagentIds: [taskId],
      })).subagents.find((candidate) => candidate.id === taskId);
      // A settled task no longer owns later work in its thread.
      const parentRunId =
        task !== undefined && task.result === null && isOrchestrationV2WorkActive(task.status)
          ? task.runId
          : null;
      if (
        parentRunId !== null &&
        (yield* threads.getThreadRecords(lineage.parentThreadId, ["turnItems"], {
          turnItemTypes: ["run_interrupt_request"],
          turnItemRunIds: [parentRunId],
        })).turnItems.length > 0
      )
        return;
    }
    if (retry) {
      const retries = restartRetryNotices(source.id, sourceRecords.turnItems);
      if (
        retries.filter(({ at }) => DateTime.toEpochMillis(at) >= loopWindowStart).length >=
        MAX_CONTINUATION_CHAIN
      ) {
        yield* Effect.logWarning("Not starting again a run restarted too many times in a row", {
          threadId: input.threadId,
          sourceRunId: input.sourceRunId,
        });
        return;
      }
      const target = {
        commandId: CommandId.make(`command:restart-retry:${source.id}:${retries.length + 1}`),
        threadId: input.threadId,
        runId: source.id,
      };
      // A retry that puts the run back to preparing its workspace also queues that preparation.
      yield* threads.dispatch({ type: "prepared-run.retry", automatic: true, ...target }).pipe(
        Effect.catchTags({
          ThreadManagementProviderInstanceDisabledError: (error) =>
            Effect.logInfo("orchestration-v2.restart-retry.instance-disabled", {
              threadId: input.threadId,
              sourceRunId: input.sourceRunId,
              projectId: error.projectId,
              instanceId: error.instanceId,
            }),
          // The thread moved on before this ran: the run is no longer the one the restart cut.
          OrchestratorDispatchError: (error) =>
            Effect.logInfo("orchestration-v2.restart-retry.refused", {
              threadId: input.threadId,
              sourceRunId: input.sourceRunId,
              cause: error.cause,
            }),
          OrchestratorRuntimeModeAboveCeilingError: () =>
            Effect.logInfo("orchestration-v2.restart-retry.above-ceiling", {
              threadId: input.threadId,
              sourceRunId: input.sourceRunId,
            }),
          OrchestratorCommandPreviouslyRejectedError: () => Effect.void,
        }),
      );
      return;
    }
    const sourceMessage = sourceRecords.messages.find(
      (message) => message.id === source.userMessageId,
    );
    const note = restartContinuationNote(
      source,
      projection.runs,
      projection.providerTurns,
      projection.attempts,
    );
    // A cut compaction resumes by compacting again; only a person signs a provider out.
    const recompact =
      sourceMessage !== undefined && !note.settled && isCompactionCommandMessage(sourceMessage);
    if (sourceMessage !== undefined && isNativeMaintenanceCommand(sourceMessage) && !recompact)
      return;
    const noteText =
      note.work.length === 0 ? undefined : restartCancelledBackgroundWorkNote(note.work);
    const text = recompact
      ? IDLE_COMPACTION_TEXT
      : noteText === undefined
        ? CONTINUE_PROMPT
        : note.settled
          ? noteText
          : `${noteText}\n\n${CONTINUE_PROMPT}`;
    yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:restart-continuation:${input.sourceRunId}`),
        threadId: input.threadId,
        messageId,
        text,
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          summary: note.settled
            ? "Background work stopped before it finished"
            : "T3.CodeShip restarted and resumed this turn",
          detail: text,
        },
        attachments: [],
        modelSelection: source.modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        restartContinuationOfRunId: input.sourceRunId,
      })
      .pipe(
        // Disabled instances, and threads above a policy ceiling, cannot resume; still run success
        // cleanup so delegated children recover without futile retries.
        Effect.catchTags({
          ThreadManagementProviderInstanceDisabledError: (error) =>
            Effect.logInfo("orchestration-v2.restart-continuation.instance-disabled", {
              threadId: input.threadId,
              sourceRunId: input.sourceRunId,
              projectId: error.projectId,
              instanceId: error.instanceId,
            }),
          OrchestratorRuntimeModeAboveCeilingError: () =>
            Effect.logInfo("orchestration-v2.restart-continuation.above-ceiling", {
              threadId: input.threadId,
              sourceRunId: input.sourceRunId,
            }),
        }),
      );
  },
  // Declined child continuations still owe parent results; existing continuation runs settle them instead.
  (effect, input) =>
    effect.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          yield* threads.recoverDelegatedTask(input.threadId, input.sourceRunId);
        }),
      ),
    ),
);
