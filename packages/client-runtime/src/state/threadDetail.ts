import {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2TurnItem,
  type MessageId,
  type OrchestrationV2ThreadProjection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  deriveThreadQueueWorkflowState,
  getUserQueuedThreadRuns,
  type ThreadQueueWorkflowState,
} from "./threadWorkflows.ts";
import { deriveThreadTurnSubagents, type ThreadTurnSubagents } from "./threadSubagents.ts";
import {
  deriveUsageLimitNoticeRows,
  presentRunStop,
  withoutUsageLimitNoticeRows,
  type RunStopPresentation,
  type UsageLimitNoticeRows,
} from "./threadExecution.ts";
import {
  deriveThreadCheckpointSummaries,
  type ThreadCheckpointSummary,
} from "./threadCheckpoints.ts";
import type {
  EnvironmentThread,
  EnvironmentThreadStructure,
  ThreadStructure,
  ThreadStructureTurnItem,
  ThreadStructureVisibleTurnItem,
} from "./models.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE, type EnvironmentThreadState } from "./threadState.ts";
import {
  createQuestionHistoryProjector,
  derivePendingThreadRequests,
  type PendingThreadRequests,
} from "./threadRequests.ts";
import { arrayElementsEqual, parseThreadKey, threadKey } from "./entities.ts";
import { getProjectionArrayReplacementIndex } from "./orchestrationV2Projection.ts";

export const messageStarCommand = { type: "thread.message.star" } as const;

const EMPTY_VISIBLE_TURN_ITEMS: OrchestrationV2ThreadProjection["visibleTurnItems"] = Object.freeze(
  [],
);
const EMPTY_THREAD_STRUCTURE_TURN_ITEMS: ReadonlyArray<ThreadStructureVisibleTurnItem> =
  Object.freeze([]);
const EMPTY_STARRED_MESSAGE_IDS: ReadonlyArray<MessageId> = Object.freeze([]);
const EMPTY_STARRED_MESSAGE_IDS_ATOM = Atom.make(EMPTY_STARRED_MESSAGE_IDS);
const EMPTY_STARRED_MESSAGE_PREVIEWS: ReadonlyArray<{
  readonly id: MessageId;
  readonly preview: string | null;
}> = Object.freeze([]);
const NOT_STARRED_ATOM = Atom.make(false);
const EMPTY_CHECKPOINT_SUMMARIES: ReadonlyArray<ThreadCheckpointSummary> = Object.freeze([]);

/**
 * Changes when the agent may have changed the workspace, so file views and host images refresh.
 * File tools are explicit; commands, MCP or dynamic tools and subagents are included because
 * they can mutate the workspace without reporting the paths they touched.
 */
export function deriveWorkspaceMutationId(
  visibleTurnItems: ReadonlyArray<ThreadStructureVisibleTurnItem>,
  latestCheckpointCompletedAt: string | null,
) {
  let itemId: string | null = null;
  for (let index = visibleTurnItems.length - 1; index >= 0; index -= 1) {
    const item = visibleTurnItems[index]?.item;
    if (!item) continue;
    if (
      item.type !== "command_execution" &&
      item.type !== "file_change" &&
      item.type !== "dynamic_tool" &&
      item.type !== "subagent"
    ) {
      continue;
    }
    if (item.status === "pending" || item.status === "running" || item.status === "waiting") {
      continue;
    }
    itemId = item.id;
    break;
  }
  return itemId === null && latestCheckpointCompletedAt === null
    ? null
    : JSON.stringify([itemId, latestCheckpointCompletedAt]);
}

type TurnItem = OrchestrationV2ThreadProjection["turnItems"][number];
type VisibleTurnItem = OrchestrationV2ThreadProjection["visibleTurnItems"][number];

// Items are stripped once each: unchanged items keep their identity across
// structure changes, which the incremental timeline relies on.
const structureTurnItems = new WeakMap<TurnItem, ThreadStructureTurnItem>();
const structureVisibleTurnItems = new WeakMap<VisibleTurnItem, ThreadStructureVisibleTurnItem>();

type QueueWorkflowScalarField = Exclude<keyof ThreadQueueWorkflowState, "queuedRuns">;
// `satisfies` fails the build when the state gains a field this list does not compare.
const QUEUE_WORKFLOW_SCALAR_FIELDS = Object.keys({
  activeRun: true,
  isHeld: true,
  canSendNow: true,
  canPromoteToSteer: true,
  canStopAndSend: true,
  promoteSkipsCompaction: true,
} satisfies Record<QueueWorkflowScalarField, true>) as ReadonlyArray<QueueWorkflowScalarField>;

// Queued text, attachments and attribution all come from the message, so its identity covers them.
function queueWorkflowStatesEqual(
  left: ThreadQueueWorkflowState,
  right: ThreadQueueWorkflowState,
): boolean {
  return (
    QUEUE_WORKFLOW_SCALAR_FIELDS.every((field) => left[field] === right[field]) &&
    left.queuedRuns.length === right.queuedRuns.length &&
    left.queuedRuns.every(
      (queued, index) =>
        queued.run === right.queuedRuns[index]!.run &&
        queued.message === right.queuedRuns[index]!.message,
    )
  );
}

function toThreadStructureTurnItem(item: TurnItem): ThreadStructureTurnItem {
  if (item.type !== "assistant_message" && item.type !== "reasoning") return item;
  let structure = structureTurnItems.get(item);
  if (structure === undefined) {
    const { text: _text, updatedAt: _updatedAt, ...rest } = item;
    structure = rest;
    structureTurnItems.set(item, structure);
  }
  return structure;
}

function toThreadStructureVisibleTurnItem(
  visibleItem: VisibleTurnItem,
): ThreadStructureVisibleTurnItem {
  const item = toThreadStructureTurnItem(visibleItem.item);
  if (item === visibleItem.item) return visibleItem;
  let structure = structureVisibleTurnItems.get(visibleItem);
  if (structure === undefined) {
    structure = { ...visibleItem, item };
    structureVisibleTurnItems.set(visibleItem, structure);
  }
  return structure;
}

/** Whether the structure kept every field of this row: true for all but streamed items. */
export function isCompleteTurnItemRow(row: ThreadStructureVisibleTurnItem): row is VisibleTurnItem {
  return row.item.type !== "assistant_message" && row.item.type !== "reasoning";
}

// The open thread is marked visited several times while a reply streams. Visit
// state is read from the shell, or from lastVisitedAtAtom while the thread is
// not in the shell index yet, so a mark is not structure.
function toThreadStructureThread<
  T extends {
    readonly updatedAt: unknown;
    readonly lastVisitedAt?: unknown;
    readonly starredMessageIds?: unknown;
  },
>(thread: T) {
  const {
    updatedAt: _updatedAt,
    lastVisitedAt: _lastVisitedAt,
    starredMessageIds: _starredMessageIds,
    ...structure
  } = thread;
  return structure;
}

function toThreadStructure(projection: OrchestrationV2ThreadProjection): ThreadStructure {
  const { updatedAt: _updatedAt, ...structure } = projection;
  return {
    ...structure,
    thread: toThreadStructureThread(projection.thread),
    turnItems: projection.turnItems.map(toThreadStructureTurnItem),
    visibleTurnItems: projection.visibleTurnItems.map(toThreadStructureVisibleTurnItem),
  };
}

const sameTurnItem = Schema.toEquivalence(OrchestrationV2TurnItem);
const sameAppThreadStructure = Schema.toEquivalence(
  OrchestrationV2AppThread.mapFields(toThreadStructureThread),
);
const sameMessage = Schema.toEquivalence(OrchestrationV2ConversationMessage);

// Overlays previous's structure on next, so the fields the strip functions
// remove are exactly the ones ignored here.
function sameApartFromStripped<T extends object>(
  same: (left: T, right: T) => boolean,
  previous: T,
  previousStructure: object,
  next: T,
): boolean {
  return (
    Object.keys(previous).length === Object.keys(next).length &&
    same(Object.assign({}, next, previousStructure), next)
  );
}

function sameTurnItemStructure(previous: TurnItem, next: TurnItem): boolean {
  if (previous === next) return true;
  const structure = toThreadStructureTurnItem(previous);
  if (previous.id !== next.id || previous.type !== next.type || structure === previous) {
    return false;
  }
  return sameApartFromStripped(sameTurnItem, previous, structure, next);
}

// A streaming reply's text also lands on its message; readers of that text read the live thread.
function sameMessageStructure(
  previous: OrchestrationV2ConversationMessage,
  next: OrchestrationV2ConversationMessage,
): boolean {
  if (previous === next) return true;
  if (!previous.streaming || !next.streaming || previous.id !== next.id) return false;
  const { text: _text, updatedAt: _updatedAt, ...structure } = previous;
  return sameApartFromStripped(sameMessage, previous, structure, next);
}

function sameProjectionArray<T>(
  previous: ReadonlyArray<T>,
  next: ReadonlyArray<T>,
  same: (previous: T, next: T) => boolean,
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  const replacedIndex = getProjectionArrayReplacementIndex(previous, next);
  if (replacedIndex !== undefined) return same(previous[replacedIndex]!, next[replacedIndex]!);
  return previous.every((item, index) => same(item, next[index]!));
}

function sameVisibleTurnItemStructure(before: VisibleTurnItem, after: VisibleTurnItem): boolean {
  return (
    before === after ||
    (before.position === after.position &&
      before.visibility === after.visibility &&
      before.sourceThreadId === after.sourceThreadId &&
      before.sourceItemId === after.sourceItemId &&
      sameTurnItemStructure(before.item, after.item))
  );
}

function isStreamingAssistantMessage(visibleItem: VisibleTurnItem): boolean {
  return visibleItem.item.type === "assistant_message" && visibleItem.item.streaming;
}

/** Whether `next` only streams more text into assistant messages that were already streaming. */
function sameApartFromStreamedAssistantText(
  previous: OrchestrationV2ThreadProjection["visibleTurnItems"],
  next: OrchestrationV2ThreadProjection["visibleTurnItems"],
): boolean {
  return sameProjectionArray(
    previous,
    next,
    (before, after) =>
      before === after ||
      (isStreamingAssistantMessage(before) &&
        isStreamingAssistantMessage(after) &&
        sameVisibleTurnItemStructure(before, after)),
  );
}

/**
 * Whether `previous` and `next` have the same ThreadStructure: they differ
 * only by text streamed into existing assistant and reasoning items or by a
 * visit or bookmark change. The same items exist, with the same status.
 */
export function sameThreadStructure(
  previous: OrchestrationV2ThreadProjection,
  next: OrchestrationV2ThreadProjection,
): boolean {
  if (previous === next) return true;
  for (const key of Object.keys(next) as Array<keyof OrchestrationV2ThreadProjection>) {
    if (
      key === "thread" ||
      key === "messages" ||
      key === "turnItems" ||
      key === "visibleTurnItems" ||
      key === "updatedAt"
    ) {
      continue;
    }
    if (previous[key] !== next[key]) return false;
  }
  if (previous.thread !== next.thread && !sameAppThreadStructure(previous.thread, next.thread)) {
    return false;
  }
  return (
    sameProjectionArray(previous.messages, next.messages, sameMessageStructure) &&
    sameProjectionArray(previous.turnItems, next.turnItems, sameTurnItemStructure) &&
    sameProjectionArray(
      previous.visibleTurnItems,
      next.visibleTurnItems,
      sameVisibleTurnItemStructure,
    )
  );
}

export function createEnvironmentThreadDetailAtoms<E>(
  threadStateAtom: (
    environmentId: ScopedThreadRef["environmentId"],
    threadId: ScopedThreadRef["threadId"],
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, E>>,
) {
  const threadStateValueAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get) =>
      AsyncResult.getOrElse(
        get(threadStateAtom(ref.environmentId, ref.threadId)),
        () => EMPTY_ENVIRONMENT_THREAD_STATE,
      ),
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-state-value:${key}`));
  });

  const threadAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let previousProjection: OrchestrationV2ThreadProjection | null = null;
    let previousValue: EnvironmentThread | null = null;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === previousProjection) return previousValue;
      previousProjection = projection;
      previousValue = projection === null ? null : { environmentId: ref.environmentId, projection };
      return previousValue;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread:${key}`));
  });

  // Streamed assistant and reasoning text replaces an item several times a
  // second. Readers of the thread's structure (runs, requests, which items
  // exist and their status) keep the previous value through those updates.
  const quietThreadAtomFamily = Atom.family((key: string) => {
    let previousProjection: OrchestrationV2ThreadProjection | null = null;
    let previous: EnvironmentThreadStructure | null = null;
    return Atom.make((get) => {
      const next = get(threadAtomFamily(key));
      if (next === null) {
        previousProjection = null;
        previous = null;
      } else if (
        previousProjection === null ||
        !sameThreadStructure(previousProjection, next.projection)
      ) {
        previous = {
          environmentId: next.environmentId,
          projection: toThreadStructure(next.projection),
        };
      }
      // Comparing the latest projection lets consecutive replacements bypass history scans.
      previousProjection = next?.projection ?? null;
      return previous;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-quiet-thread:${key}`));
  });

  // Read from the structure so streamed text does not rescan runs and turn items.
  const usageLimitNoticeRowsAtomFamily = Atom.family((key: string) => {
    let previous: EnvironmentThreadStructure | null = null;
    let value: UsageLimitNoticeRows | null = null;
    return Atom.make((get) => {
      const thread = get(quietThreadAtomFamily(key));
      if (thread !== previous) {
        previous = thread;
        value = thread === null ? null : deriveUsageLimitNoticeRows(thread.projection);
      }
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-usage-limit-notice:${key}`));
  });

  // Presentation only: the projection keeps every row for other readers.
  const visibleTurnItemsAtomFamily = Atom.family((key: string) => {
    const projectQuestionHistory = createQuestionHistoryProjector();
    let previousRows: OrchestrationV2ThreadProjection["visibleTurnItems"] | null = null;
    let previousNotice: UsageLimitNoticeRows | null = null;
    let previous = EMPTY_VISIBLE_TURN_ITEMS;
    return Atom.make((get): OrchestrationV2ThreadProjection["visibleTurnItems"] => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) return EMPTY_VISIBLE_TURN_ITEMS;
      const rows = projectQuestionHistory(projection);
      const notice = get(usageLimitNoticeRowsAtomFamily(key));
      if (rows !== previousRows || notice !== previousNotice) {
        previousRows = rows;
        previousNotice = notice;
        previous = withoutUsageLimitNoticeRows(rows, notice);
      }
      return previous;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-visible-turn-items:${key}`));
  });

  const starredMessageIdsAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get) =>
        Option.getOrNull(get(threadStateValueAtomFamily(key)).data)?.thread.starredMessageIds ??
        EMPTY_STARRED_MESSAGE_IDS,
    ).pipe(Atom.setIdleTTL(0)),
  );
  const isMessageStarredAtomFamily = Atom.family((key: string) => {
    const separator = key.lastIndexOf("\u0000");
    const thread = key.slice(0, separator);
    const messageId = key.slice(separator + 1) as MessageId;
    return Atom.make((get) => get(starredMessageIdsAtomFamily(thread)).includes(messageId)).pipe(
      Atom.setIdleTTL(0),
    );
  });
  const quietVisibleTurnItemsAtomFamily = Atom.family((key: string) => {
    const projectQuestionHistory = createQuestionHistoryProjector<ThreadStructureVisibleTurnItem>();
    return Atom.make((get) => {
      const thread = get(quietThreadAtomFamily(key));
      return thread === null
        ? EMPTY_THREAD_STRUCTURE_TURN_ITEMS
        : projectQuestionHistory(thread.projection);
    }).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-quiet-thread-visible-turn-items:${key}`),
    );
  });

  // Holds while only streamed assistant text moves, so the timeline re-renders on structure;
  // each streaming message reads its text through assistantMessageTextAtom.
  const timelineVisibleTurnItemsAtomFamily = Atom.family((key: string) => {
    let previous = EMPTY_VISIBLE_TURN_ITEMS;
    return Atom.make((get) => {
      const next = get(visibleTurnItemsAtomFamily(key));
      if (!sameApartFromStreamedAssistantText(previous, next)) previous = next;
      return previous;
    }).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-thread-timeline-visible-turn-items:${key}`),
    );
  });

  // The timeline's structure moves with every tool call of a turn; the Starred list follows
  // only its own previews.
  const starredMessagePreviewsAtomFamily = Atom.family((key: string) => {
    let previous = EMPTY_STARRED_MESSAGE_PREVIEWS;
    return Atom.make((get) => {
      const ids = get(starredMessageIdsAtomFamily(key));
      if (ids.length === 0) {
        previous = EMPTY_STARRED_MESSAGE_PREVIEWS;
        return previous;
      }
      const wanted = new Set(ids);
      const previews = new Map<MessageId, string>();
      for (const { item } of get(timelineVisibleTurnItemsAtomFamily(key))) {
        if (
          (item.type === "user_message" || item.type === "assistant_message") &&
          wanted.has(item.messageId)
        ) {
          const preview = item.text.slice(0, 640).replace(/\s+/g, " ").trim().slice(0, 160);
          previews.set(item.messageId, preview);
        }
      }
      const unchanged =
        previous.length === ids.length &&
        previous.every(
          (entry, index) =>
            entry.id === ids[index] && entry.preview === (previews.get(entry.id) ?? null),
        );
      if (!unchanged) previous = ids.map((id) => ({ id, preview: previews.get(id) ?? null }));
      return previous;
    }).pipe(Atom.setIdleTTL(0));
  });

  const assistantMessageTextAtomFamily = Atom.family((key: string) => {
    const separator = key.lastIndexOf("\u0000");
    const thread = key.slice(0, separator);
    const itemId = key.slice(separator + 1);
    return Atom.make((get) => {
      const item = get(visibleTurnItemsAtomFamily(thread)).find(
        (visibleItem) => visibleItem.item.id === itemId,
      )?.item;
      return item?.type === "assistant_message" ? item.text : null;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-assistant-message-text:${key}`));
  });

  const queueWorkflowAtomFamily = Atom.family((key: string) => {
    let previous: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "runs" | "messages" | "providerThreads" | "providerSessions" | "providerTurns"
    > | null = null;
    let value: ThreadQueueWorkflowState | null = null;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previous = null;
        value = null;
      } else if (
        previous === null ||
        projection.thread !== previous.thread ||
        projection.runs !== previous.runs ||
        projection.messages !== previous.messages ||
        projection.providerThreads !== previous.providerThreads ||
        projection.providerSessions !== previous.providerSessions ||
        projection.providerTurns !== previous.providerTurns
      ) {
        const next = deriveThreadQueueWorkflowState(projection);
        if (value === null || !queueWorkflowStatesEqual(value, next)) value = next;
        const { thread, runs, messages, providerThreads, providerSessions, providerTurns } =
          projection;
        previous = { thread, runs, messages, providerThreads, providerSessions, providerTurns };
      }
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-queue:${key}`));
  });
  const runStopAtomFamily = Atom.family((key: string) => {
    let previous: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems"> | null = null;
    let stop: RunStopPresentation | null = null;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previous = null;
        stop = null;
      } else if (
        projection.runs !== previous?.runs ||
        projection.turnItems !== previous?.turnItems
      ) {
        const { runs, turnItems } = projection;
        previous = { runs, turnItems };
        const next = presentRunStop(previous);
        if (
          next?.state !== stop?.state ||
          next?.runId !== stop?.runId ||
          next?.requestedAt !== stop?.requestedAt ||
          next?.background !== stop?.background
        )
          stop = next;
      }
      return stop;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-run-stop:${key}`));
  });
  const queuedCountAtomFamily = Atom.family((key: string) => {
    let previous: Pick<OrchestrationV2ThreadProjection, "runs" | "messages"> | null = null;
    let count = 0;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previous = null;
        count = 0;
      } else if (projection.runs !== previous?.runs || projection.messages !== previous?.messages) {
        const { runs, messages } = projection;
        previous = { runs, messages };
        count = getUserQueuedThreadRuns(previous).length;
      }
      return count;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-queue-count:${key}`));
  });

  const turnSubagentsAtomFamily = Atom.family((key: string) => {
    let previous: Pick<OrchestrationV2ThreadProjection, "runs" | "subagents"> | null = null;
    let value: ThreadTurnSubagents | null = null;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previous = null;
        value = null;
      } else if (
        projection.runs !== previous?.runs ||
        projection.subagents !== previous?.subagents
      ) {
        const { runs, subagents } = projection;
        previous = { runs, subagents };
        value = deriveThreadTurnSubagents(previous);
      }
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-turn-subagents:${key}`));
  });

  const checkpointSummariesAtomFamily = Atom.family((key: string) => {
    let previous: Pick<OrchestrationV2ThreadProjection, "checkpoints" | "messages"> | null = null;
    let value = EMPTY_CHECKPOINT_SUMMARIES;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previous = null;
        value = EMPTY_CHECKPOINT_SUMMARIES;
      } else if (
        projection.checkpoints !== previous?.checkpoints ||
        projection.messages !== previous?.messages
      ) {
        const { checkpoints, messages } = projection;
        const next = deriveThreadCheckpointSummaries({ checkpoints, messages });
        // The same checkpoints give the same summaries; messages only pick each assistant message.
        if (
          checkpoints !== previous?.checkpoints ||
          next.some(
            (summary, index) => summary.assistantMessageId !== value[index]?.assistantMessageId,
          )
        )
          value = next;
        previous = { checkpoints, messages };
      }
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-checkpoint-summaries:${key}`));
  });

  const lastVisitedAtAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get) =>
        Option.getOrNull(get(threadStateValueAtomFamily(key)).data)?.thread.lastVisitedAt ?? null,
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-last-visited:${key}`)),
  );
  const updatedAtAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get) => Option.getOrNull(get(threadStateValueAtomFamily(key)).data)?.updatedAt ?? null,
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-updated-at:${key}`)),
  );
  const worktreePathAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get) =>
        Option.getOrNull(get(threadStateValueAtomFamily(key)).data)?.thread.worktreePath ?? null,
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-worktree:${key}`)),
  );
  const pendingRequestsAtomFamily = Atom.family((key: string) => {
    // Selected arrays omit streamed rows, so only the raw arrays can validate an exact replacement.
    let previousRaw: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems"> | null =
      null;
    let previous: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems"> | null =
      null;
    let value: PendingThreadRequests | null = null;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previousRaw = null;
        previous = null;
        value = null;
        return value;
      }
      const raw = { runtimeRequests: projection.runtimeRequests, turnItems: projection.turnItems };
      if (previousRaw !== null && previousRaw.runtimeRequests === raw.runtimeRequests) {
        if (previousRaw.turnItems === raw.turnItems) {
          previousRaw = raw;
          return value;
        }
        const replacedIndex = getProjectionArrayReplacementIndex(
          previousRaw.turnItems,
          raw.turnItems,
        );
        if (replacedIndex !== undefined) {
          const before = previousRaw.turnItems[replacedIndex]!;
          const after = raw.turnItems[replacedIndex]!;
          if (
            before.type !== "approval_request" &&
            before.type !== "user_input_request" &&
            after.type !== "approval_request" &&
            after.type !== "user_input_request"
          ) {
            previousRaw = raw;
            return value;
          }
        }
      }
      previousRaw = raw;
      const runtimeRequests = projection.runtimeRequests.filter(
        (request) => request.status === "pending",
      );
      const ids = new Set(runtimeRequests.map((request) => request.id));
      const turnItems =
        ids.size === 0
          ? []
          : projection.turnItems.filter(
              (item) =>
                (item.type === "approval_request" || item.type === "user_input_request") &&
                ids.has(item.requestId),
            );
      if (
        previous === null ||
        !arrayElementsEqual(previous.runtimeRequests, runtimeRequests) ||
        !arrayElementsEqual(previous.turnItems, turnItems)
      ) {
        previous = { runtimeRequests, turnItems };
        value = derivePendingThreadRequests(previous);
      }
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-pending-requests:${key}`));
  });

  const statusAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => get(threadStateValueAtomFamily(key)).status).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-thread-status:${key}`),
    ),
  );
  const sequenceAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => get(threadStateValueAtomFamily(key)).sequence).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-thread-sequence:${key}`),
    ),
  );
  const errorAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => Option.getOrNull(get(threadStateValueAtomFamily(key)).error)).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-thread-error:${key}`),
    ),
  );
  const historyAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => get(threadStateValueAtomFamily(key)).history).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-thread-history:${key}`),
    ),
  );

  const workspaceMutationIdAtomFamily = Atom.family((key: string) =>
    Atom.make((get) =>
      deriveWorkspaceMutationId(
        get(quietVisibleTurnItemsAtomFamily(key)),
        get(checkpointSummariesAtomFamily(key)).at(-1)?.completedAt ?? null,
      ),
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-workspace-mutation-id:${key}`)),
  );

  return {
    worktreePathAtom: (ref: ScopedThreadRef) => worktreePathAtomFamily(threadKey(ref)),
    workspaceMutationIdAtom: (ref: ScopedThreadRef) =>
      workspaceMutationIdAtomFamily(threadKey(ref)),
    updatedAtAtom: (ref: ScopedThreadRef) => updatedAtAtomFamily(threadKey(ref)),
    lastVisitedAtAtom: (ref: ScopedThreadRef) => lastVisitedAtAtomFamily(threadKey(ref)),
    pendingRequestsAtom: (ref: ScopedThreadRef) => pendingRequestsAtomFamily(threadKey(ref)),
    queueWorkflowAtom: (ref: ScopedThreadRef) => queueWorkflowAtomFamily(threadKey(ref)),
    queuedCountAtom: (ref: ScopedThreadRef) => queuedCountAtomFamily(threadKey(ref)),
    runStopAtom: (ref: ScopedThreadRef) => runStopAtomFamily(threadKey(ref)),
    turnSubagentsAtom: (ref: ScopedThreadRef) => turnSubagentsAtomFamily(threadKey(ref)),
    checkpointSummariesAtom: (ref: ScopedThreadRef) =>
      checkpointSummariesAtomFamily(threadKey(ref)),
    stateAtom: (ref: ScopedThreadRef) => threadStateValueAtomFamily(threadKey(ref)),
    threadAtom: (ref: ScopedThreadRef) => threadAtomFamily(threadKey(ref)),
    quietThreadAtom: (ref: ScopedThreadRef) => quietThreadAtomFamily(threadKey(ref)),
    visibleTurnItemsAtom: (ref: ScopedThreadRef) => visibleTurnItemsAtomFamily(threadKey(ref)),
    quietVisibleTurnItemsAtom: (ref: ScopedThreadRef) =>
      quietVisibleTurnItemsAtomFamily(threadKey(ref)),
    timelineVisibleTurnItemsAtom: (ref: ScopedThreadRef) =>
      timelineVisibleTurnItemsAtomFamily(threadKey(ref)),
    starredMessageIdsAtom: (ref: ScopedThreadRef | null) =>
      ref === null ? EMPTY_STARRED_MESSAGE_IDS_ATOM : starredMessageIdsAtomFamily(threadKey(ref)),
    isMessageStarredAtom: (ref: ScopedThreadRef | null, messageId: MessageId) =>
      ref === null
        ? NOT_STARRED_ATOM
        : isMessageStarredAtomFamily(`${threadKey(ref)}\u0000${messageId}`),
    starredMessagePreviewsAtom: (ref: ScopedThreadRef) =>
      starredMessagePreviewsAtomFamily(threadKey(ref)),
    assistantMessageTextAtom: (ref: ScopedThreadRef, itemId: string) =>
      assistantMessageTextAtomFamily(`${threadKey(ref)}\u0000${itemId}`),
    statusAtom: (ref: ScopedThreadRef) => statusAtomFamily(threadKey(ref)),
    sequenceAtom: (ref: ScopedThreadRef) => sequenceAtomFamily(threadKey(ref)),
    errorAtom: (ref: ScopedThreadRef) => errorAtomFamily(threadKey(ref)),
    historyAtom: (ref: ScopedThreadRef) => historyAtomFamily(threadKey(ref)),
  };
}
