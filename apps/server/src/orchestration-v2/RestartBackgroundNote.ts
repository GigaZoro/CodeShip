import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RestartCancelledBackgroundWork,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2TurnItem,
  RunId,
} from "@t3tools/contracts";
import { waitsOnAnotherThread } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { latestRootProviderFailure, runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";

type Work = OrchestrationV2RestartCancelledBackgroundWork;
type Attempt = Pick<OrchestrationV2RunAttempt, "id" | "runId">;

const MAX_LABEL_LENGTH = 160;

function compactLabel(value: unknown, maxLength = MAX_LABEL_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replaceAll(/\s+/g, " ").trim();
  if (text.length === 0) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** A bounded label that keeps its id suffix whole whenever it fits. */
function labelWithId(name: unknown, fallback: string, suffix: string): string {
  const budget = MAX_LABEL_LENGTH - suffix.length;
  if (budget < 2) return compactLabel(`${fallback}${suffix}`) ?? fallback;
  return `${compactLabel(name, budget) ?? compactLabel(fallback, budget)}${suffix}`;
}

/**
 * resumeId overrides the item id for native resume, such as Codex's child provider-thread id.
 * A wait on another thread loses nothing in a restart: that thread resumes on its own, as does a
 * turn cut while waiting.
 */
export function cancelledTurnItemWork(
  item: OrchestrationV2TurnItem,
  resumeId?: string,
): Work | undefined {
  if (waitsOnAnotherThread(item)) return undefined;
  switch (item.type) {
    case "subagent": {
      const nativeId =
        item.origin === "provider_native" ? (resumeId ?? item.nativeItemRef?.nativeId) : undefined;
      return {
        kind: "subagent",
        label: labelWithId(
          compactLabel(item.title) === undefined ? item.prompt : item.title,
          "subagent",
          nativeId === undefined ? "" : ` (id ${nativeId})`,
        ),
        id: item.id,
      };
    }
    case "command_execution":
      return {
        kind: item.monitor === true ? "monitor" : "shell",
        label: compactLabel(item.input) ?? compactLabel(item.title) ?? "background command",
        id: item.id,
      };
    case "dynamic_tool": {
      const monitor =
        item.input !== null &&
        typeof item.input === "object" &&
        Reflect.get(item.input, "persistent") === true;
      return {
        kind: monitor ? "monitor" : "task",
        label: compactLabel(item.title) ?? compactLabel(item.toolName) ?? "background tool",
        id: item.id,
      };
    }
    default:
      return undefined;
  }
}

/** Returns the awaiting provider thread; native subagents can run on children while their launching turn awaits them. */
export function awaitingProviderThreadId(
  item: OrchestrationV2TurnItem,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "providerThreadId">>,
): OrchestrationV2Run["providerThreadId"] | undefined {
  const runProviderThreadId = runs.find((run) => run.id === item.runId)?.providerThreadId;
  return item.type === "subagent" && item.origin === "provider_native"
    ? (runProviderThreadId ?? item.providerThreadId)
    : (item.providerThreadId ?? runProviderThreadId);
}

function restartWorkKind(task: OrchestrationV2PendingBackgroundTask): Work["kind"] {
  switch (task.kind) {
    case "command":
      return "shell";
    case "subagent":
      return "subagent";
    case "monitor":
      return "monitor";
    case "background_task":
      return "task";
    default:
      task satisfies never;
      return "task";
  }
}

export function cancelledRosterTaskWork(task: OrchestrationV2PendingBackgroundTask): Work {
  if (task.parentTaskId !== undefined) {
    return {
      kind: "subagent",
      label: labelWithId(task.description, "background task", ` (subagent ${task.parentTaskId})`),
      id: task.parentTaskId,
    };
  }
  const kind = restartWorkKind(task);
  const description = compactLabel(task.description);
  return {
    kind,
    label:
      compactLabel(
        description === undefined ? task.taskId : `${description} (id ${task.taskId})`,
      ) ?? "background task",
    id: task.taskId,
    ...(task.nativeItemId === undefined ? {} : { nativeItemId: task.nativeItemId }),
    ...(task.awaited === true ? { awaited: true as const } : {}),
  };
}

/**
 * Tells the work a set of runs started, by the turn items of those runs: the item itself, the
 * tool call behind a background task, or the subagent that owns one. A rollback of those runs
 * leaves the conversation without that work, so it must not be told about it.
 */
export function workStartedBy(
  turnItems: ReadonlyArray<{ readonly id: string; readonly nativeId: string | null }>,
): (work: Pick<Work, "id" | "nativeItemId">) => boolean {
  const started = new Set<string>();
  for (const item of turnItems) {
    started.add(item.id);
    if (item.nativeId !== null) started.add(item.nativeId);
  }
  return (work) =>
    (work.id !== undefined && started.has(work.id)) ||
    (work.nativeItemId !== undefined && started.has(work.nativeItemId));
}

const MAX_NOTE_ENTRIES = 10;

function workList(work: ReadonlyArray<Work>): ReadonlyArray<string> {
  const omitted = work.length - MAX_NOTE_ENTRIES;
  return [
    ...work.slice(0, MAX_NOTE_ENTRIES).map((entry) => `- ${entry.kind}: ${entry.label}`),
    ...(omitted > 0 ? [`- and ${omitted} more`] : []),
  ];
}

/** Bounds entries and labels to protect the context budget. */
export function restartCancelledBackgroundWorkNote(work: ReadonlyArray<Work>): string {
  return [
    "Note: this background work was cancelled before it finished, because the T3 server restarted or the agent process running it ended. It will not report back on its own, so resume or restart what you still need and wait for its result:",
    ...workList(work),
  ].join("\n");
}

/**
 * What ended background work without a report: its server, its agent process, that process's
 * session, or a Stop or a rollback that closed the process.
 */
export type BackgroundWorkStop =
  | "server-restarted"
  | "server-shut-down"
  | "process-ended"
  | "session-idle"
  | "session-failed"
  | "session-closed"
  | "stopped"
  | "rolled-back";

const BACKGROUND_WORK_STOP_TEXT: Record<
  BackgroundWorkStop,
  { readonly title: string; readonly lead: string }
> = {
  "server-restarted": { title: "Server restarted", lead: "The server restarted" },
  "server-shut-down": { title: "Server shut down", lead: "The server shut down" },
  "process-ended": { title: "Agent process ended", lead: "The agent process ended" },
  "session-idle": {
    title: "Agent session closed",
    lead: "The agent's session was closed after too long without activity",
  },
  "session-failed": { title: "Agent session failed", lead: "The agent's session failed" },
  "session-closed": { title: "Agent session closed", lead: "The agent's session was closed" },
  stopped: { title: "Chat stopped", lead: "Stopping the chat ended the agent process" },
  "rolled-back": {
    title: "Conversation rewound",
    lead: "Rewinding the conversation ended the agent process",
  },
};

/** A run whose turn ended and that only background work, if anything, still holds. */
export const isSettledRun = (run: Pick<OrchestrationV2Run, "status">): boolean =>
  run.status === "completed" || run.status === "waiting";

export function backgroundWorkStoppedNoticeId(runId: RunId) {
  return derive.runSignalTurnItem({ runId, signal: "background-work-stopped" });
}

/**
 * The thread's own record of background work a settled run lost, since the server log rotates.
 * Its start is when the work stopped, which scheduled recovery reads as when the run stopped.
 */
export function backgroundWorkStoppedNotice(input: {
  readonly run: Pick<OrchestrationV2Run, "id" | "threadId" | "rootNodeId" | "providerThreadId">;
  readonly cause: BackgroundWorkStop;
  readonly work: ReadonlyArray<Work>;
  readonly stoppedAt: DateTime.Utc;
  readonly now: DateTime.Utc;
  readonly ordinal: number;
}): Extract<OrchestrationV2TurnItem, { readonly type: "system_notice" }> {
  const { title, lead } = BACKGROUND_WORK_STOP_TEXT[input.cause];
  return {
    id: backgroundWorkStoppedNoticeId(input.run.id),
    threadId: input.run.threadId,
    runId: input.run.id,
    nodeId: input.run.rootNodeId,
    providerThreadId: input.run.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed",
    title,
    startedAt: input.stoppedAt,
    completedAt: input.now,
    updatedAt: input.now,
    type: "system_notice",
    message: [
      `${lead} and stopped background work before it finished:`,
      ...workList(input.work),
      ...(input.work.some(isAwaitedWork) ? ["This chat was waiting on it."] : []),
    ].join("\n"),
  };
}

/**
 * What a run's process lost while the server kept running: the run's merged record of it, and the
 * thread notice that explains it. EventSink places the notice after the run's existing items.
 */
export function lostBackgroundWorkRecord(input: {
  readonly run: Pick<
    OrchestrationV2Run,
    "id" | "threadId" | "rootNodeId" | "providerThreadId" | "restartCancelledBackgroundWork"
  >;
  readonly cause: BackgroundWorkStop;
  readonly work: ReadonlyArray<Work>;
  readonly now: DateTime.Utc;
}) {
  return {
    restartCancelledBackgroundWork: mergeRestartCancelledBackgroundWork(
      input.run.restartCancelledBackgroundWork ?? [],
      input.work,
    ),
    notice: backgroundWorkStoppedNotice({
      run: input.run,
      cause: input.cause,
      work: input.work,
      stoppedAt: input.now,
      now: input.now,
      ordinal: 0,
    }),
  };
}

/** The latest run that started on a provider thread, whose record the work that thread lost joins. */
export function latestStartedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
  providerThreadId: NonNullable<OrchestrationV2Run["providerThreadId"]>,
): OrchestrationV2Run | undefined {
  return runs.reduce<OrchestrationV2Run | undefined>(
    (latest, run) =>
      run.providerThreadId === providerThreadId &&
      run.status !== "queued" &&
      run.status !== "rolled_back" &&
      !neverStarted(run) &&
      (latest === undefined || runRanAfter(run, latest))
        ? run
        : latest,
    undefined,
  );
}

type ProviderTurnState = Pick<
  OrchestrationV2ProviderTurn,
  "runAttemptId" | "providerThreadId" | "status"
>;

export function isRestartNoteSource(
  source: Pick<OrchestrationV2Run, "status" | "activeAttemptId" | "restartCancelledBackgroundWork">,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId" | "status">>,
): boolean {
  return (
    // Failed and interrupted turns never continue; recovery-cancelled waiting runs still qualify.
    (source.status === "completed" ||
      source.status === "waiting" ||
      source.status === "cancelled") &&
    (source.restartCancelledBackgroundWork?.length ?? 0) > 0 &&
    !providerTurns.some(
      (turn) => turn.runAttemptId === source.activeAttemptId && turn.status === "cancelled",
    )
  );
}

/**
 * Matches the Working-section hold: a shell or monitor wakes it only when the agent said it
 * waits on it. Most are dev servers and their watchdogs, so their note waits for the next
 * user message.
 */
export function isAwaitedWork(work: Pick<Work, "kind" | "awaited">): boolean {
  return work.awaited === true || (work.kind !== "shell" && work.kind !== "monitor");
}

export function runOutcome(
  run: Pick<OrchestrationV2Run, "status" | "restartCancelledBackgroundWork">,
): OrchestrationV2Run["status"] {
  return (run.status === "completed" || run.status === "cancelled") &&
    (run.restartCancelledBackgroundWork ?? []).some(isAwaitedWork)
    ? "interrupted"
    : run.status;
}

/** Unstarted runs have no lost work to continue, except prepared continuations carrying a source run. */
export function neverStarted(
  run: Pick<OrchestrationV2Run, "startedAt" | "restartContinuationOfRunId">,
): boolean {
  return run.startedAt === null && run.restartContinuationOfRunId === undefined;
}

/** Restart-cancelled unstarted runs supersede nothing; user-stopped unstarted runs do. */
function cancelledBeforeStart(
  run: Pick<OrchestrationV2Run, "status" | "startedAt" | "restartContinuationOfRunId">,
): boolean {
  return run.status === "cancelled" && neverStarted(run);
}

/**
 * How sure a restart is that the provider never got a run's prompt. The prompt is only sent once
 * the run is persisted as running, so a run cut before that never sent it; one cut while running,
 * before its provider turn was recorded, may have. That doubt stays until a provider turn records
 * delivery, across later restarts of the same run.
 */
export type RestartRetryDelivery = "unsent" | "unconfirmed";

export function restartRetryDelivery(
  run: Pick<OrchestrationV2Run, "startedAt">,
  notices: ReadonlyArray<{ readonly delivery: RestartRetryDelivery }>,
): RestartRetryDelivery {
  return run.startedAt === null && notices.every((notice) => notice.delivery === "unsent")
    ? "unsent"
    : "unconfirmed";
}

/** The notice each start of a run cut before its prompt was recorded leaves in the thread. */
export function restartRetryNoticeId(
  runId: RunId,
  ordinal: number,
  delivery: RestartRetryDelivery,
) {
  return derive.runSignalTurnItem({
    runId,
    signal: delivery === "unsent" ? `restart-retry-${ordinal}` : `restart-resend-${ordinal}`,
  });
}

/** Told to the agent with a message it may already have received before a restart. */
export const RESTART_RESEND_NOTE =
  "Note: the T3 server restarted while sending you the message below, so you may already have received it and started on it. If you did, continue from where you were instead of starting over, and confirm that an action which changes state did not take effect before you repeat it.";

/** The notices of a run's starts after restarts, oldest first. */
export function restartRetryNotices(
  runId: RunId,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<{ readonly delivery: RestartRetryDelivery; readonly at: DateTime.Utc }> {
  const notices = new Map(turnItems.map((item) => [item.id, item]));
  const found: Array<{ readonly delivery: RestartRetryDelivery; readonly at: DateTime.Utc }> = [];
  for (;;) {
    const ordinal = found.length + 1;
    const unsent = notices.get(restartRetryNoticeId(runId, ordinal, "unsent"));
    const notice = unsent ?? notices.get(restartRetryNoticeId(runId, ordinal, "unconfirmed"));
    if (notice === undefined) return found;
    found.push({ delivery: unsent === undefined ? "unconfirmed" : "unsent", at: notice.updatedAt });
  }
}

/** A provider turn records that the provider accepted the prompt; without one it never saw it. */
export function promptNeverDelivered(
  run: Pick<OrchestrationV2Run, "activeAttemptId">,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId">>,
): boolean {
  return !providerTurns.some((turn) => turn.runAttemptId === run.activeAttemptId);
}

/** A later run took the thread past `run`, so resuming `run` now would reorder the work. */
export function supersededRun(
  run: Pick<OrchestrationV2Run, "id" | "ordinal" | "completedAt">,
  runs: ReadonlyArray<OrchestrationV2Run>,
): boolean {
  return runs.some(
    (other) =>
      other.id !== run.id &&
      other.status !== "queued" &&
      !cancelledBeforeStart(other) &&
      runRanAfter(other, run),
  );
}

/** The provider never accepted this continuation's prompt, so starting it again repeats nothing. */
export function continuationFailedBeforePrompt(
  run: Pick<OrchestrationV2Run, "status" | "activeAttemptId" | "restartContinuationOfRunId">,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId">>,
): boolean {
  return (
    run.status === "failed" &&
    run.restartContinuationOfRunId !== undefined &&
    promptNeverDelivered(run, providerTurns)
  );
}

const CONTINUATION_START_RETRY_DELAYS_MS = [60_000, 180_000];

/** Backoff before restarting a continuation that failed to start, or undefined to let it fail. */
export function continuationStartRetryDelayMs(
  run: OrchestrationV2Run,
  projection: {
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId">>;
    readonly turnItems: Parameters<typeof latestRootProviderFailure>[1];
  },
): number | undefined {
  if (!continuationFailedBeforePrompt(run, projection.providerTurns)) return;
  // These fail the same way however often they start.
  const failureClass = latestRootProviderFailure(run, projection.turnItems)?.class;
  if (
    failureClass === "usage_limit" ||
    failureClass === "permission_error" ||
    failureClass === "validation_error"
  )
    return;
  let failedStarts = 0;
  for (
    let current: OrchestrationV2Run | undefined = run;
    current !== undefined && continuationFailedBeforePrompt(current, projection.providerTurns);
    current = projection.runs.find(
      (candidate) => candidate.id === current?.restartContinuationOfRunId,
    )
  )
    failedStarts += 1;
  return CONTINUATION_START_RETRY_DELAYS_MS[failedStarts - 1];
}

export function isRestartContinuationSource(
  source: Pick<OrchestrationV2Run, "status" | "activeAttemptId" | "restartCancelledBackgroundWork">,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId" | "status">>,
): boolean {
  return isRestartNoteSource(source, providerTurns)
    ? (source.restartCancelledBackgroundWork ?? []).some(isAwaitedWork)
    : source.status === "cancelled";
}

/** Running does not prove prompt acceptance; carry continuation notes until a completed turn proves delivery. */
export function restartContinuationNote(
  source: OrchestrationV2Run,
  runs: ReadonlyArray<OrchestrationV2Run>,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId" | "status">>,
  attempts: ReadonlyArray<Attempt>,
): { readonly work: ReadonlyArray<Work>; readonly settled: boolean } {
  const completedAttempts = new Set(
    providerTurns.filter((turn) => turn.status === "completed").map((turn) => turn.runAttemptId),
  );
  const completedRuns = new Set(
    attempts.filter((attempt) => completedAttempts.has(attempt.id)).map((attempt) => attempt.runId),
  );
  let current = source;
  let work = current.restartCancelledBackgroundWork ?? [];
  const visited = new Set([current.id]);
  while (
    current.restartContinuationOfRunId !== undefined &&
    !completedRuns.has(current.id) &&
    !(current.activeAttemptId !== null && completedAttempts.has(current.activeAttemptId))
  ) {
    const previous = runs.find((candidate) => candidate.id === current.restartContinuationOfRunId);
    if (previous === undefined || visited.has(previous.id)) break;
    visited.add(previous.id);
    current = previous;
    work = mergeRestartCancelledBackgroundWork(current.restartCancelledBackgroundWork ?? [], work);
  }
  return { work, settled: isRestartNoteSource(current, providerTurns) };
}

export function isRestartNoteContinuation(
  run: Pick<OrchestrationV2Run, "restartContinuationOfRunId">,
  runs: ReadonlyArray<OrchestrationV2Run>,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId" | "status">>,
  attempts: ReadonlyArray<Attempt>,
): boolean {
  const source =
    run.restartContinuationOfRunId === undefined
      ? undefined
      : runs.find((candidate) => candidate.id === run.restartContinuationOfRunId);
  return (
    source !== undefined &&
    restartContinuationNote(source, runs, providerTurns, attempts).work.length > 0
  );
}

/**
 * The provider threads that carry one native conversation. A move to another account resumes it
 * under that account's own row, and the agent that lost the work answers there.
 */
export function conversationProviderThreadIds(
  providerThread: Pick<OrchestrationV2ProviderThread, "id" | "driver" | "nativeThreadRef">,
  providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "id" | "driver" | "nativeThreadRef">
  >,
): ReadonlySet<OrchestrationV2ProviderThread["id"]> {
  const nativeId = providerThread.nativeThreadRef?.nativeId;
  return new Set([
    providerThread.id,
    ...(nativeId == null
      ? []
      : providerThreads
          .filter(
            (candidate) =>
              candidate.driver === providerThread.driver &&
              candidate.nativeThreadRef?.nativeId === nativeId,
          )
          .map((candidate) => candidate.id)),
  ]);
}

/** Derive delivery from later completed turns of the same native conversation, excluding compactions, resumes, and rolled-back runs. */
export function pendingRestartCancelledBackgroundWork(input: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly providerTurns: ReadonlyArray<ProviderTurnState>;
  readonly compactionMessageIds: ReadonlySet<string>;
  /** From conversationProviderThreadIds; the run's own provider thread when omitted. */
  readonly conversation?: ReadonlySet<OrchestrationV2ProviderThread["id"]>;
  readonly run: Pick<
    OrchestrationV2Run,
    | "id"
    | "ordinal"
    | "completedAt"
    | "userMessageId"
    | "providerThreadId"
    | "restartContinuationOfRunId"
    | "activeAttemptId"
  >;

  readonly attempts: ReadonlyArray<Attempt>;
}): ReadonlyArray<Work> {
  const isCompaction = (run: typeof input.run) => input.compactionMessageIds.has(run.userMessageId);
  if (
    input.run.providerThreadId === null ||
    input.run.restartContinuationOfRunId !== undefined ||
    isCompaction(input.run)
  )
    return [];
  const conversation = input.conversation ?? new Set([input.run.providerThreadId]);
  const deliveredAttemptIds = new Set(
    input.providerTurns
      .filter((turn) => conversation.has(turn.providerThreadId) && turn.status === "completed")
      .map((turn) => turn.runAttemptId),
  );
  const sameThread = input.runs.filter(
    (run) => run.providerThreadId !== null && conversation.has(run.providerThreadId),
  );
  const prompted = sameThread.filter(
    (candidate) =>
      candidate.id !== input.run.id &&
      candidate.activeAttemptId !== null &&
      candidate.status !== "rolled_back" &&
      (deliveredAttemptIds.has(candidate.activeAttemptId) ||
        input.attempts.some(
          (attempt) => attempt.runId === candidate.id && deliveredAttemptIds.has(attempt.id),
        )) &&
      !isCompaction(candidate) &&
      (candidate.restartContinuationOfRunId === undefined ||
        isRestartNoteContinuation(candidate, input.runs, input.providerTurns, input.attempts)),
  );
  // Earlier attempts may already have delivered the note; a steer's replacement attempt must not repeat it.
  const alreadyDelivered = input.attempts.some(
    (attempt) =>
      attempt.runId === input.run.id &&
      attempt.id !== input.run.activeAttemptId &&
      deliveredAttemptIds.has(attempt.id),
  );
  if (alreadyDelivered) return [];
  return sameThread
    .filter(
      (source) =>
        runRanAfter(input.run, source) &&
        (source.restartCancelledBackgroundWork?.length ?? 0) > 0 &&
        !prompted.some((later) => runRanAfter(later, source)),
    )
    .reduce<ReadonlyArray<Work>>(
      (work, source) =>
        mergeRestartCancelledBackgroundWork(work, source.restartCancelledBackgroundWork ?? []),
      [],
    );
}

export function mergeRestartCancelledBackgroundWork(
  current: ReadonlyArray<Work>,
  added: ReadonlyArray<Work>,
): ReadonlyArray<Work> {
  const identity = (entry: Work) => entry.id ?? `${entry.kind}\u0000${entry.label}`;
  const seen = new Set(current.map(identity));
  const merged = [...current];
  for (const entry of added) {
    const key = identity(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}
