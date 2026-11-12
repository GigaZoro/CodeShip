// @effect-diagnostics globalTimers:off - The rewind wait runs in client callbacks, outside an Effect runtime.
import {
  type CommandId,
  type MessageId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ProviderTurn,
  orchestrationV2RunTurnEnded,
  type RunAttemptId,
  type RunId,
} from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";
import * as Option from "effect/Option";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { ThreadStructure, ThreadStructureVisibleTurnItem } from "./models.ts";
import type { ThreadCheckpointSummary } from "./threadCheckpoints.ts";
import type { EnvironmentThreadState } from "./threadState.ts";

export function findRevertCheckpoint(
  checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>,
  turnCount: number,
): OrchestrationV2Checkpoint | undefined {
  return checkpoints.findLast(
    (checkpoint) =>
      checkpoint.status === "ready" &&
      (turnCount === 0
        ? checkpoint.ordinalWithinScope === 0 && checkpoint.appRunOrdinal === null
        : checkpoint.appRunOrdinal === turnCount),
  );
}

/** Whether any turn that a rewind to `turnCount` would undo changed files. */
export function turnsAfterChangedFiles(
  checkpoints: ReadonlyArray<
    Pick<OrchestrationV2Checkpoint, "appRunOrdinal" | "files" | "filesTotal">
  >,
  turnCount: number,
): boolean {
  return checkpoints.some(
    (checkpoint) =>
      checkpoint.appRunOrdinal !== null &&
      checkpoint.appRunOrdinal > turnCount &&
      (checkpoint.files.length > 0 || (checkpoint.filesTotal?.count ?? 0) > 0),
  );
}

/**
 * Run ordinals the conversation can be reverted to: those whose provider turn belongs to the
 * active provider thread, plus 0 for the thread start. Empty without a live provider session
 * on the thread's selected instance.
 */
export function deriveAvailableRevertTurnCounts(
  projection: ThreadStructure | null,
): ReadonlySet<number> {
  const available = new Set<number>();
  const providerThread = projection?.providerThreads.find(
    (candidate) => candidate.id === projection.thread.activeProviderThreadId,
  );
  if (
    !providerThread?.providerSessionId ||
    providerThread.providerInstanceId !== projection?.thread.modelSelection.instanceId
  )
    return available;
  available.add(0);
  const attemptsById = new Map(projection.attempts.map((attempt) => [attempt.id, attempt]));
  const providerTurnsById = new Map<
    OrchestrationV2ProviderTurn["id"],
    OrchestrationV2ProviderTurn
  >();
  const latestTurnByAttempt = new Map<RunAttemptId, OrchestrationV2ProviderTurn>();
  for (const turn of projection.providerTurns) {
    providerTurnsById.set(turn.id, turn);
    if (turn.runAttemptId === null) continue;
    const latest = latestTurnByAttempt.get(turn.runAttemptId);
    if (latest === undefined || turn.ordinal > latest.ordinal) {
      latestTurnByAttempt.set(turn.runAttemptId, turn);
    }
  }
  for (const run of projection.runs) {
    if (run.activeAttemptId === null) continue;
    const attempt = attemptsById.get(run.activeAttemptId);
    const providerTurn =
      latestTurnByAttempt.get(run.activeAttemptId) ??
      (attempt?.providerTurnId == null ? undefined : providerTurnsById.get(attempt.providerTurnId));
    // A ready file checkpoint alone cannot restore the provider conversation.
    if (providerTurn?.providerThreadId === providerThread.id) available.add(run.ordinal);
  }
  return available;
}

/**
 * One local timeline item that belongs to a run, in timeline order. `userMessageId` is set when
 * the item is a user message that started or queued its run, which is what a rewind can edit.
 */
export interface RevertRunMarker {
  readonly runId: RunId;
  readonly userMessageId: MessageId | null;
}

/** The run markers for a thread's visible turn items; inherited history is not ours to rewind. */
export function* revertRunMarkersFromVisibleTurnItems(
  rows: Iterable<Pick<ThreadStructureVisibleTurnItem, "item" | "visibility">>,
): Generator<RevertRunMarker> {
  for (const { item, visibility } of rows) {
    if (visibility === "inherited" || item.runId === null) continue;
    if (item.type === "user_message") {
      if (item.inputIntent === "queued_turn" && item.status === "pending") continue;
      yield {
        runId: item.runId,
        userMessageId:
          item.inputIntent === "turn_start" || item.inputIntent === "queued_turn"
            ? item.messageId
            : null,
      };
    } else if (item.type === "assistant_message" || item.type === "notification") {
      yield { runId: item.runId, userMessageId: null };
    }
  }
}

/**
 * The turn count each user message's rewind restores: the checkpoint of the run before it.
 * Run ordinals keep increasing after a rewind; only visible local runs define predecessors.
 */
export function deriveRevertTurnCountByUserMessageId(input: {
  readonly runMarkers: Iterable<RevertRunMarker>;
  readonly checkpoints: ReadonlyArray<
    Pick<ThreadCheckpointSummary, "runId" | "status" | "checkpointTurnCount">
  >;
  readonly threadStartCheckpointReady: boolean;
  readonly availableRevertTurnCounts?: ReadonlySet<number> | undefined;
  readonly unsettledRunId?: RunId | null;
}): Map<MessageId, number> {
  const readyTurnCountByRunId = new Map<RunId, number>();
  for (const checkpoint of input.checkpoints) {
    if (checkpoint.status === "ready") {
      readyTurnCountByRunId.set(checkpoint.runId, checkpoint.checkpointTurnCount);
    }
  }
  const targetByRunId = new Map<RunId, number | undefined>();
  const byUserMessageId = new Map<MessageId, number>();
  let previousRunId: RunId | null = null;
  for (const { runId, userMessageId } of input.runMarkers) {
    if (!targetByRunId.has(runId)) {
      targetByRunId.set(
        runId,
        previousRunId === null
          ? input.threadStartCheckpointReady
            ? 0
            : undefined
          : readyTurnCountByRunId.get(previousRunId),
      );
      previousRunId = runId;
    }
    if (userMessageId === null || runId === input.unsettledRunId) continue;
    const target = targetByRunId.get(runId);
    if (
      target !== undefined &&
      (input.availableRevertTurnCounts === undefined || input.availableRevertTurnCounts.has(target))
    )
      byUserMessageId.set(userMessageId, target);
  }
  return byUserMessageId;
}

export interface RetryTarget {
  readonly assistantMessageId: MessageId;
  readonly userMessageId: MessageId;
  readonly turnCount: number;
}

/**
 * The newest reply, and the message it answers, when nothing was said after that reply and the
 * message can be rewound. Retry shows only there. Returns `previous` while it names the same
 * exchange: clients hand the target to every row, and a new object would re-render them all.
 */
export function deriveRetryTarget(
  messages: ReadonlyArray<{
    readonly id: MessageId;
    readonly role: string;
    readonly streaming: boolean;
  }>,
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>,
  previous: RetryTarget | null = null,
): RetryTarget | null {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== "assistant" || lastMessage.streaming) return null;
  const lastUser = messages.findLast((message) => message.role === "user");
  const turnCount =
    lastUser === undefined ? undefined : revertTurnCountByUserMessageId.get(lastUser.id);
  if (lastUser === undefined || turnCount === undefined) return null;
  if (
    previous?.assistantMessageId === lastMessage.id &&
    previous.userMessageId === lastUser.id &&
    previous.turnCount === turnCount
  ) {
    return previous;
  }
  return { assistantMessageId: lastMessage.id, userMessageId: lastUser.id, turnCount };
}

/**
 * Runs `revert` and resolves once the thread shows the rewind to `turnCount` committed for the
 * active provider conversation, or rejects with the server's rollback failure.
 */
export function waitForRevertedMessage(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly threadAtom: Atom.Atom<EnvironmentThreadState>;
  readonly turnCount: number;
  readonly requestId: CommandId;
  readonly revert: () => Promise<void>;
  readonly timeoutMs?: number;
}): Promise<void> {
  const { registry, threadAtom, turnCount, requestId } = input;
  const readProjection = () => Option.getOrNull(registry.get(threadAtom).data);
  const initial = readProjection();
  const providerThreadId = initial?.thread.activeProviderThreadId;
  const initialProviderThread = initial?.providerThreads.find(
    (providerThread) => providerThread.id === providerThreadId,
  );
  const initialProviderThreadIds = new Set(initial?.providerThreads.map((thread) => thread.id));
  // Paging can omit the source run. Rollback commits the entire ended suffix atomically.
  const witness = initial?.runs.reduce<(typeof initial.runs)[number] | undefined>((latest, run) => {
    if (run.ordinal <= turnCount || !orchestrationV2RunTurnEnded(run.status)) return latest;
    return latest === undefined || run.ordinal > latest.ordinal ? run : latest;
  }, undefined);
  if (witness === undefined) {
    return Promise.reject(
      new Error(t("The thread has changed. Select a message to rewind again.")),
    );
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let accepted = false;
    let unsubscribe = () => {};
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      unsubscribe();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const inspect = () => {
      const thread = readProjection();
      if (!thread) return;
      const failure = thread.thread.rollbackFailure;
      if (failure?.requestId === requestId) {
        finish(new Error(failure.message));
        return;
      }
      if (
        accepted &&
        thread.providerThreads.some(
          (providerThread) =>
            (providerThread.id === providerThreadId ||
              // Claude resets to a fresh root session when rewinding to thread start.
              (turnCount === 0 &&
                providerThread.ownerNodeId === null &&
                providerThread.appThreadId === initial?.thread.id &&
                providerThread.providerInstanceId === initialProviderThread?.providerInstanceId &&
                !initialProviderThreadIds.has(providerThread.id))) &&
            providerThread.lastRunOrdinal === (turnCount === 0 ? null : turnCount),
        ) &&
        thread.runs.some((run) => run.id === witness.id && run.status === "rolled_back")
      )
        finish();
    };
    unsubscribe = registry.subscribe(threadAtom, inspect);
    timeout = globalThis.setTimeout(() => {
      finish(new Error(t("Timed out waiting for the thread to rewind.")));
    }, input.timeoutMs ?? 120_000);
    Promise.resolve()
      .then(input.revert)
      .then(() => {
        accepted = true;
        inspect();
      }, finish);
  });
}
