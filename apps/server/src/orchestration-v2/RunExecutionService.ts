import { makeAssistantStreamingFilter } from "./assistantStreaming.ts";
import { executionTurnItemTypes } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  isDelegatedAppThread,
  isOrchestrationV2WorkActive,
  CommandId,
  type EventId,
  type ModelSelection,
  type NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderSessionId,
  type ProviderThreadId,
  type ProviderTurnId,
  type RunAttemptId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { PROVIDER_STOP_REASON_SIGNAL } from "@t3tools/provider-core/server/subagentProjection";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import type { ProjectionStoreV2Error } from "./ProjectionStore.ts";
import {
  knownProviderFailureMessage,
  makeProviderFailure,
  makeProviderFailureTurnItem,
  providerFailureDiagnostic,
} from "@t3tools/provider-core/server/failure";
import { makeInterruptResultTurnItem } from "./runInterruptResult.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import {
  makeRunLoopGuardState,
  resolveRunLoopRole,
  stepRunLoopGuard,
  type RunLoopAbortDecision,
} from "./RunLoopGuard.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import { userFacingDatabaseErrorMessage } from "./UserFacingErrors.ts";

export interface ProviderEventRoutingState {
  readonly ownedThreadIds: ReadonlySet<ThreadId>;
  // After root settlement, new children belong to the live run unless their coordinator still holds this run open.
  readonly rootTurnEnded: boolean;
  readonly workflowMemberParents: ReadonlyMap<ThreadId, ThreadId>;
  readonly ownedProviderThreadIds: ReadonlySet<ProviderThreadId>;
  readonly ownedProviderTurns: ReadonlyMap<ProviderTurnId, ProviderThreadId>;
  readonly inheritedBackgroundTurnItems: ReadonlyMap<TurnItemId, OrchestrationV2Run["id"]>;
  readonly rootProviderTurnId: ProviderTurnId | null;
}

export interface ProviderEventRouteIdentity {
  readonly threadId: ThreadId;
  readonly runId: OrchestrationV2Run["id"];
  readonly attemptId: RunAttemptId;
  readonly providerThreadId: ProviderThreadId;
}

export interface InheritedBackgroundTurnItemRoute {
  readonly id: TurnItemId;
  readonly runId: OrchestrationV2Run["id"];
}

type ProviderTerminalEvent = Extract<
  ProviderAdapter.ProviderAdapterV2Event,
  { readonly type: "turn.terminal" }
>;

function isTerminalProviderTurnStatus(status: OrchestrationV2ProviderTurn["status"]): boolean {
  return (
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function isSettledSubagentStatus(status: OrchestrationV2Subagent["status"]): boolean {
  return !isOrchestrationV2WorkActive(status);
}

/** A provider-native subagent's turns arrive on its parent's run, but the parent agent started them. */
const NATIVE_SUBAGENT_TURN_ORIGIN: ProviderUsageAnalytics.ProviderTurnOrigin = {
  createdBy: "agent",
  creationSource: "provider",
  scheduled: false,
  subagent: true,
};

const backgroundCapableTurnItemTypes: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "dynamic_tool",
  "subagent",
]);

function isSettledTurnItemStatus(status: OrchestrationV2TurnItem["status"]): boolean {
  return !isOrchestrationV2WorkActive(status);
}

/** Subagents settle through their own cascade; every other execution item is a tool call. */
export const toolTurnItemTypes: ReadonlyArray<OrchestrationV2TurnItem["type"]> =
  executionTurnItemTypes.filter((type) => type !== "subagent");

export function isOpenToolTurnItem(item: OrchestrationV2TurnItem): boolean {
  return toolTurnItemTypes.includes(item.type) && !isSettledTurnItemStatus(item.status);
}

/**
 * When T3 stops a turn's runtime itself, no provider event will record the end of the tool calls
 * that runtime had open; left open, they count as background work for ever.
 */
export function abandonedTurnItemEvent(input: {
  readonly id: EventId;
  readonly item: OrchestrationV2TurnItem;
  readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
  readonly completedAt: DateTime.Utc;
}) {
  const { item, completedAt } = input;
  const payload: OrchestrationV2TurnItem = {
    ...item,
    status: "interrupted",
    completedAt,
    updatedAt: completedAt,
  };
  return {
    id: input.id,
    type: "turn-item.updated" as const,
    threadId: item.threadId,
    ...(item.runId === null ? {} : { runId: item.runId }),
    ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
    providerInstanceId: input.providerInstanceId,
    occurredAt: completedAt,
    payload,
  };
}

function isSettledRunEligibleForInheritedBackground(status: OrchestrationV2Run["status"]): boolean {
  return status === "interrupted" || status === "failed" || status === "cancelled";
}

/** Use durable provider-thread lineage; sessions can host multiple threads. */
export function selectInheritedBackgroundTurnItems(input: {
  readonly threadId: ThreadId;
  readonly currentProviderThreadId: ProviderThreadId;
  readonly currentRunOrdinal: number;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): ReadonlyArray<InheritedBackgroundTurnItemRoute> {
  const settledPriorRunIds = new Set(
    input.runs
      .filter(
        (run) =>
          run.threadId === input.threadId &&
          run.ordinal < input.currentRunOrdinal &&
          isSettledRunEligibleForInheritedBackground(run.status),
      )
      .map((run) => run.id),
  );
  return input.turnItems.flatMap((turnItem) =>
    turnItem.threadId === input.threadId &&
    turnItem.providerThreadId === input.currentProviderThreadId &&
    turnItem.runId !== null &&
    settledPriorRunIds.has(turnItem.runId) &&
    backgroundCapableTurnItemTypes.has(turnItem.type) &&
    !isSettledTurnItemStatus(turnItem.status)
      ? [{ id: turnItem.id, runId: turnItem.runId }]
      : [],
  );
}

type SubagentTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "subagent" }>;

// Tool calls that only a live provider process can end.
const processBoundToolCallTypes: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "dynamic_tool",
]);

type OpenRunOwnedSubagentProjection = {
  readonly subagents: ReadonlyMap<NodeId, OrchestrationV2Subagent>;
  readonly turnItems: ReadonlyMap<NodeId, SubagentTurnItem>;
  readonly childTurnItems: ReadonlyMap<TurnItemId, OrchestrationV2TurnItem>;
  readonly nodes: ReadonlyMap<NodeId, OrchestrationV2ExecutionNode>;
  readonly linkedChildThreadIds: ReadonlySet<ThreadId>;
};

export type UnsettledWork = {
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly nodes: ReadonlyArray<OrchestrationV2ExecutionNode>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
};

type RunOwnedSubagentTerminalStatus = Extract<
  OrchestrationV2Subagent["status"],
  "interrupted" | "failed" | "cancelled"
>;

function isOpenExecutionNodeStatus(status: OrchestrationV2ExecutionNode["status"]): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

function isRunOwnedSubagentTerminalStatus(
  status: ProviderTerminalEvent["status"],
): status is RunOwnedSubagentTerminalStatus {
  return status === "interrupted" || status === "failed" || status === "cancelled";
}

function streamedThreadId(event: ProviderAdapter.ProviderAdapterV2Event): ThreadId | null {
  if (event.type === "message.updated") return event.message.threadId;
  if (event.type === "turn_item.updated") return event.turnItem.threadId;
  return null;
}

function childTurnsContinue(terminal: ProviderTerminalEvent): boolean {
  return terminal.status === "failed" && terminal.childTurnsContinue === true;
}

/** Launching runs still ingest running subagents; taking them over would duplicate events. */
export function canRouteRelatedSubagent(status: OrchestrationV2Subagent["status"]): boolean {
  return status === "completed";
}

function emptyOpenRunOwnedSubagentProjection(): OpenRunOwnedSubagentProjection {
  return {
    subagents: new Map(),
    turnItems: new Map(),
    childTurnItems: new Map(),
    nodes: new Map(),
    linkedChildThreadIds: new Set(),
  };
}

function withLinkedChildThreadId(
  current: OpenRunOwnedSubagentProjection,
  childThreadId: ThreadId | null,
): OpenRunOwnedSubagentProjection {
  if (childThreadId === null || current.linkedChildThreadIds.has(childThreadId)) {
    return current;
  }
  const linkedChildThreadIds = new Set(current.linkedChildThreadIds);
  linkedChildThreadIds.add(childThreadId);
  return { ...current, linkedChildThreadIds };
}

export const cascadeTerminalizeRunOwnedSubagents = Effect.fn(
  "RunExecutionService.cascadeTerminalizeRunOwnedSubagents",
)(function* (input: {
  readonly run: OrchestrationV2Run;
  readonly open: OpenRunOwnedSubagentProjection;
  readonly status: RunOwnedSubagentTerminalStatus;
  readonly completedAt: DateTime.Utc;
  readonly allocateEventId: () => Effect.Effect<EventId, IdAllocator.IdAllocatorV2AllocationError>;
}): Effect.fn.Return<
  ReadonlyArray<OrchestrationV2DomainEvent>,
  IdAllocator.IdAllocatorV2AllocationError
> {
  const events: Array<OrchestrationV2DomainEvent> = [];
  // Prefer lifetime linkage over currently-open rows: subagent/turn-item
  // snapshots may terminalize before the linked child-thread node settles.
  const childThreadIds = new Set(input.open.linkedChildThreadIds);
  for (const item of [...input.open.subagents.values(), ...input.open.turnItems.values()]) {
    if (item.childThreadId !== null) {
      childThreadIds.add(item.childThreadId);
    }
  }
  const keys = new Set<NodeId>([
    ...input.open.subagents.keys(),
    ...input.open.turnItems.keys(),
    ...input.open.nodes.keys(),
  ]);
  for (const key of keys) {
    const subagent = input.open.subagents.get(key);
    if (subagent !== undefined && !isSettledSubagentStatus(subagent.status)) {
      events.push({
        id: yield* input.allocateEventId(),
        type: "subagent.updated",
        threadId: subagent.threadId,
        runId: input.run.id,
        nodeId: subagent.id,
        driver: subagent.driver,
        providerInstanceId: subagent.providerInstanceId,
        occurredAt: input.completedAt,
        payload: {
          ...subagent,
          status: input.status,
          completedAt: input.completedAt,
          updatedAt: input.completedAt,
        },
      });
    }
    const node = input.open.nodes.get(key);
    if (
      node !== undefined &&
      ((node.threadId === input.run.threadId && node.runId === input.run.id) ||
        childThreadIds.has(node.threadId)) &&
      isOpenExecutionNodeStatus(node.status)
    ) {
      events.push({
        id: yield* input.allocateEventId(),
        type: "node.updated",
        threadId: node.threadId,
        runId: node.runId ?? input.run.id,
        nodeId: node.id,
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: input.completedAt,
        payload: {
          ...node,
          status: input.status,
          completedAt: input.completedAt,
        },
      });
    }
    const turnItem = input.open.turnItems.get(key);
    if (
      turnItem !== undefined &&
      turnItem.runId === input.run.id &&
      !isSettledTurnItemStatus(turnItem.status)
    ) {
      events.push({
        id: yield* input.allocateEventId(),
        type: "turn-item.updated",
        threadId: turnItem.threadId,
        runId: input.run.id,
        ...(turnItem.nodeId === null ? {} : { nodeId: turnItem.nodeId }),
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: input.completedAt,
        payload: {
          ...turnItem,
          status: input.status,
          completedAt: input.completedAt,
          updatedAt: input.completedAt,
        },
      });
    }
  }
  for (const turnItem of input.open.childTurnItems.values()) {
    if (!childThreadIds.has(turnItem.threadId) || isSettledTurnItemStatus(turnItem.status)) {
      continue;
    }
    events.push({
      id: yield* input.allocateEventId(),
      type: "turn-item.updated",
      threadId: turnItem.threadId,
      runId: turnItem.runId ?? input.run.id,
      ...(turnItem.nodeId === null ? {} : { nodeId: turnItem.nodeId }),
      providerInstanceId: input.run.providerInstanceId,
      occurredAt: input.completedAt,
      payload: {
        ...turnItem,
        ...("streaming" in turnItem ? { streaming: false } : {}),
        status: input.status,
        completedAt: input.completedAt,
        updatedAt: input.completedAt,
      },
    });
  }
  return events;
});

const interruptLostToolCalls = Effect.fn("RunExecutionService.interruptLostToolCalls")(
  function* (input: {
    readonly run: OrchestrationV2Run;
    readonly toolCalls: Iterable<OrchestrationV2TurnItem>;
    readonly completedAt: DateTime.Utc;
    readonly allocateEventId: () => Effect.Effect<
      EventId,
      IdAllocator.IdAllocatorV2AllocationError
    >;
  }) {
    const events: Array<OrchestrationV2DomainEvent> = [];
    for (const toolCall of input.toolCalls) {
      events.push({
        id: yield* input.allocateEventId(),
        type: "turn-item.updated",
        threadId: toolCall.threadId,
        runId: toolCall.runId ?? input.run.id,
        ...(toolCall.nodeId === null ? {} : { nodeId: toolCall.nodeId }),
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: input.completedAt,
        payload: {
          ...toolCall,
          status: "interrupted",
          completedAt: input.completedAt,
          updatedAt: input.completedAt,
        },
      });
    }
    return events;
  },
);

function finalProviderThreadStatus(
  disposition: ProviderTerminalEvent["threadDisposition"],
): OrchestrationV2ProviderThread["status"] {
  return disposition === "broken" ? "error" : "idle";
}

export function makeProviderEventRoutingState(input: {
  readonly identity: ProviderEventRouteIdentity;
  readonly inheritedBackgroundTurnItems?: ReadonlyArray<InheritedBackgroundTurnItemRoute>;
  readonly providerTurnId: ProviderTurnId | null;
  readonly relatedThreadIds?: ReadonlyArray<ThreadId>;
  readonly relatedProviderThreadIds?: ReadonlyArray<ProviderThreadId>;
}): ProviderEventRoutingState {
  return {
    ownedThreadIds: new Set([input.identity.threadId, ...(input.relatedThreadIds ?? [])]),
    rootTurnEnded: false,
    workflowMemberParents: new Map(),
    ownedProviderThreadIds: new Set([
      input.identity.providerThreadId,
      ...(input.relatedProviderThreadIds ?? []),
    ]),
    ownedProviderTurns:
      input.providerTurnId === null
        ? new Map()
        : new Map([[input.providerTurnId, input.identity.providerThreadId]]),
    inheritedBackgroundTurnItems: new Map(
      (input.inheritedBackgroundTurnItems ?? []).map((item) => [item.id, item.runId]),
    ),
    rootProviderTurnId: input.providerTurnId,
  };
}

export function routeProviderEvent(
  event: ProviderAdapter.ProviderAdapterV2Event,
  input: ProviderEventRouteIdentity,
  state: ProviderEventRoutingState,
): readonly [boolean, ProviderEventRoutingState] {
  const ownsThread = (threadId: ThreadId): boolean => state.ownedThreadIds.has(threadId);
  const ownsChildThread = (threadId: ThreadId): boolean =>
    threadId !== input.threadId && ownsThread(threadId);
  const ownsRun = (runId: string | null): boolean => runId === input.runId;
  // ACP plan ids are session-scoped, so a turn can update a plan an earlier turn of this
  // thread reported. Only an active root turn adopts those rows, never a lingering run.
  const adoptsEarlierPlan = (threadId: ThreadId): boolean =>
    threadId === input.threadId && !state.rootTurnEnded;
  const addProviderThread = (providerThreadId: ProviderThreadId): ProviderEventRoutingState => ({
    ...state,
    ownedProviderThreadIds: new Set([...state.ownedProviderThreadIds, providerThreadId]),
  });
  const addProviderTurn = (
    providerTurnId: ProviderTurnId,
    providerThreadId: ProviderThreadId,
    root: boolean,
  ): ProviderEventRoutingState => ({
    ...state,
    ownedProviderTurns: new Map(state.ownedProviderTurns).set(providerTurnId, providerThreadId),
    rootProviderTurnId: root ? providerTurnId : state.rootProviderTurnId,
  });

  switch (event.type) {
    case "provider_session.updated":
      return [false, state];
    case "app_thread.created": {
      if (event.appThread.id === input.threadId) {
        return [true, state];
      }
      const isOwnedSubagent =
        event.appThread.lineage.relationshipToParent === "subagent" &&
        event.appThread.lineage.parentThreadId !== null &&
        ownsThread(event.appThread.lineage.parentThreadId) &&
        (!state.rootTurnEnded ||
          state.workflowMemberParents.get(event.appThread.id) ===
            event.appThread.lineage.parentThreadId);
      if (!isOwnedSubagent) {
        return [false, state];
      }
      return [
        true,
        {
          ...state,
          ownedThreadIds: new Set([...state.ownedThreadIds, event.appThread.id]),
        },
      ];
    }
    case "thread_model_selection.updated":
      return [event.threadId === input.threadId, state];
    case "provider_thread.updated": {
      const belongs =
        state.ownedProviderThreadIds.has(event.providerThread.id) ||
        (event.providerThread.appThreadId !== null && ownsThread(event.providerThread.appThreadId));
      return belongs ? [true, addProviderThread(event.providerThread.id)] : [false, state];
    }
    case "provider_turn.updated": {
      const isRoot = event.providerTurn.runAttemptId === input.attemptId;
      const belongs =
        isRoot ||
        (event.providerTurn.providerThreadId !== input.providerThreadId &&
          state.ownedProviderThreadIds.has(event.providerTurn.providerThreadId)) ||
        state.ownedProviderTurns.has(event.providerTurn.id) ||
        (event.threadId !== undefined && ownsChildThread(event.threadId));
      return belongs
        ? [
            true,
            addProviderTurn(event.providerTurn.id, event.providerTurn.providerThreadId, isRoot),
          ]
        : [false, state];
    }
    case "node.updated": {
      const belongs =
        ownsRun(event.node.runId) ||
        ownsChildThread(event.node.threadId) ||
        ((event.node.kind === "todo_list" || event.node.kind === "plan") &&
          adoptsEarlierPlan(event.node.threadId));
      if (!belongs || event.node.providerThreadId === null) {
        return [belongs, state];
      }
      return [true, addProviderThread(event.node.providerThreadId)];
    }
    case "subagent.updated": {
      const moved = event.subagent;
      if (
        moved.origin === "provider_native" &&
        moved.threadId === input.threadId &&
        moved.runId !== null &&
        !ownsRun(moved.runId) &&
        moved.childThreadId !== null &&
        ownsChildThread(moved.childThreadId)
      ) {
        const ownedThreadIds = new Set(state.ownedThreadIds);
        ownedThreadIds.delete(moved.childThreadId);
        const ownedProviderThreadIds = new Set(state.ownedProviderThreadIds);
        if (moved.providerThreadId !== null) ownedProviderThreadIds.delete(moved.providerThreadId);
        const ownedProviderTurns = new Map(state.ownedProviderTurns);
        for (const [turnId, threadId] of ownedProviderTurns) {
          if (threadId === moved.providerThreadId) ownedProviderTurns.delete(turnId);
        }
        return [false, { ...state, ownedThreadIds, ownedProviderThreadIds, ownedProviderTurns }];
      }
      const belongs = ownsRun(event.subagent.runId) || ownsChildThread(event.subagent.threadId);
      const coordinator = event.subagent;
      // Resumes reattribute child threads to the live run, which may not have observed their creation.
      const adopted =
        ownsRun(coordinator.runId) &&
        !state.rootTurnEnded &&
        isOrchestrationV2WorkActive(coordinator.status) &&
        coordinator.origin === "provider_native" &&
        coordinator.childThreadId !== null &&
        !ownsThread(coordinator.childThreadId)
          ? {
              ...state,
              ownedThreadIds: new Set([...state.ownedThreadIds, coordinator.childThreadId]),
            }
          : state;
      if (
        !ownsRun(coordinator.runId) ||
        coordinator.workflow === undefined ||
        coordinator.childThreadId === null
      ) {
        return [belongs, adopted];
      }
      const workflowMemberParents = new Map(state.workflowMemberParents);
      for (const member of coordinator.workflow.agents) {
        if (member.childThreadId !== undefined) {
          workflowMemberParents.set(member.childThreadId, coordinator.childThreadId);
        }
      }
      return [true, { ...adopted, workflowMemberParents }];
    }
    case "message.updated":
      return [ownsRun(event.message.runId) || ownsChildThread(event.message.threadId), state];
    case "steer.updated":
      return [ownsRun(event.runId), state];
    case "turn_item.updated": {
      if (
        ownsRun(event.turnItem.runId) ||
        ownsChildThread(event.turnItem.threadId) ||
        ((event.turnItem.type === "todo_list" || event.turnItem.type === "proposed_plan") &&
          adoptsEarlierPlan(event.turnItem.threadId))
      ) {
        return [true, state];
      }
      const inheritedRunId = state.inheritedBackgroundTurnItems.get(event.turnItem.id);
      const isInheritedBackgroundItem =
        event.turnItem.threadId === input.threadId &&
        event.turnItem.runId !== null &&
        event.turnItem.runId === inheritedRunId &&
        backgroundCapableTurnItemTypes.has(event.turnItem.type);
      if (!isInheritedBackgroundItem) {
        return [false, state];
      }
      if (!isSettledTurnItemStatus(event.turnItem.status)) {
        return [true, state];
      }
      const inheritedBackgroundTurnItems = new Map(state.inheritedBackgroundTurnItems);
      inheritedBackgroundTurnItems.delete(event.turnItem.id);
      return [true, { ...state, inheritedBackgroundTurnItems }];
    }
    case "plan.updated":
      return [
        ownsRun(event.plan.runId) ||
          ownsChildThread(event.plan.threadId) ||
          adoptsEarlierPlan(event.plan.threadId),
        state,
      ];
    case "runtime_request.updated":
      return [
        (event.threadId !== undefined && ownsChildThread(event.threadId)) ||
          (event.runtimeRequest.providerTurnId !== null &&
            state.ownedProviderTurns.has(event.runtimeRequest.providerTurnId)),
        state,
      ];
    case "background_work.updated":
      return [state.ownedProviderTurns.has(event.providerTurnId), state];
    case "background_work.lost":
    case "command_output.delta":
    case "prompt_suggestion.updated":
      // The session manager handles these itself; runs never see them.
      return [false, state];
    case "turn.terminal":
      return event.providerTurnId === state.rootProviderTurnId
        ? [true, { ...state, rootTurnEnded: true }]
        : [false, state];
  }
}

export class RunExecutionStartError extends Schema.TaggedError<RunExecutionStartError>()(
  "RunExecutionStartError",
  {
    commandId: CommandId,
    runId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to start orchestration V2 run execution ${this.runId}.`;
  }
}

const isProviderEventStreamError = Schema.is(ProviderAdapter.ProviderAdapterEventStreamError);

export class RunExecutionIngestError extends Schema.TaggedError<RunExecutionIngestError>()(
  "RunExecutionIngestError",
  {
    runId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed while ingesting orchestration V2 run execution ${this.runId}.`;
  }
}
const isRunExecutionIngestError = Schema.is(RunExecutionIngestError);

export const RunExecutionServiceV2Error = Schema.Union([
  RunExecutionStartError,
  RunExecutionIngestError,
]);
export type RunExecutionServiceV2Error = typeof RunExecutionServiceV2Error.Type;

/** A provider turn its starter prepared: what to send, and what to record about the prompt. */
export interface RunExecutionServiceV2PreparedTurn {
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly accepted: Effect.Effect<void>;
  /** The provider was not called (`undefined`), or failed with this error. */
  readonly notAccepted: (
    error: ProviderAdapter.ProviderAdapterV2Error | undefined,
  ) => Effect.Effect<void>;
}

export interface RunExecutionServiceV2StartRootRunInput {
  readonly commandId: CommandId;
  readonly appThread: OrchestrationV2AppThread;
  readonly providerSessionId: ProviderSessionId;
  readonly session: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly checkpointScope: OrchestrationV2CheckpointScope;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly attempt: OrchestrationV2RunAttempt;
  readonly attemptId: RunAttemptId;
  /** Waits for a baseline started with `forkBaseline`; without it the run captures one itself. */
  readonly baseline?: Effect.Effect<void>;
  readonly providerTurnOrdinal: number;
  readonly nativeThreadHasTurns?: boolean;
  readonly resume?: boolean;
  readonly loadInheritedBackgroundTurnItems?: () => Effect.Effect<
    ReadonlyArray<InheritedBackgroundTurnItemRoute>,
    unknown
  >;
  readonly relatedThreadIds?: ReadonlyArray<ThreadId>;
  readonly relatedProviderThreadIds?: ReadonlyArray<ProviderThreadId>;
  readonly shouldStartProviderTurn?: () => Effect.Effect<boolean, ProjectionStoreV2Error>;
  readonly shouldFinalizeRun?: () => Effect.Effect<boolean, ProjectionStoreV2Error>;
  readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean, never>;
  readonly loadRunInterruptReason?: () => Effect.Effect<string | undefined, never>;
  readonly hasWorkspaceMoved?: () => Effect.Effect<boolean, never>;
  /** Restores inline context handoffs if the provider drops this turn's prompt before persisting it. */
  readonly loadDroppedInlineHandoffs?: () => Effect.Effect<
    ReadonlyArray<OrchestrationV2ContextHandoff>,
    never
  >;
  /**
   * Stored rows of a thread's unsettled work. Work a dead runtime left is ended from these, since
   * Stop may have settled it after the snapshots this run holds.
   */
  readonly loadUnsettledWork?: (
    threadId: ThreadId,
    nodeIds: ReadonlyArray<NodeId>,
  ) => Effect.Effect<UnsettledWork, ProjectionStoreV2Error>;
  readonly message: ProviderAdapter.ProviderAdapterV2TurnMessage;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  /** How a provider turn that failed to start is recorded: the starter knows what it waited through. */
  readonly startFailure: (error: unknown) => Effect.Effect<OrchestrationV2ProviderFailure>;
  /** Builds the turn the provider gets, such as context handoffs; a Stop meanwhile ends the start. */
  readonly prepareTurn?: (
    turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
    compact: boolean,
  ) => Effect.Effect<RunExecutionServiceV2PreparedTurn, ProviderAdapter.ProviderAdapterV2Error>;
  /**
   * Continue the provider turn a taken-over process was running before a planned update, instead
   * of starting one. Its baseline and prompt belong to the server that started it.
   */
  readonly adoptRunningTurn?: {
    readonly providerTurn: OrchestrationV2ProviderTurn;
    readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  };
}

type RunBaselineInput = Pick<
  RunExecutionServiceV2StartRootRunInput,
  "appThread" | "run" | "checkpointScope"
>;

export interface RunExecutionServiceV2Shape {
  readonly startRootRun: (
    input: RunExecutionServiceV2StartRootRunInput,
  ) => Effect.Effect<void, RunExecutionServiceV2Error>;
  /**
   * Waits until the event stream of an attempt started here has ingested that attempt's root
   * terminal, and so everything its provider reported before it, or has ended. Returns at once
   * for an attempt with no stream in this server.
   */
  readonly awaitRootTerminalIngested: (attemptId: RunAttemptId) => Effect.Effect<void>;
  /**
   * Starts the run's baseline capture on a child fiber so it overlaps provider session startup.
   * Pass the returned effect to `startRootRun`, which awaits it before prompting the provider.
   */
  readonly forkBaseline: (input: RunBaselineInput) => Effect.Effect<Effect.Effect<void>>;
}

export class RunExecutionServiceV2 extends Context.Service<
  RunExecutionServiceV2,
  RunExecutionServiceV2Shape
>()("t3/orchestration-v2/RunExecutionService/RunExecutionServiceV2") {}

export const layer: Layer.Layer<
  RunExecutionServiceV2,
  never,
  | CheckpointService.CheckpointServiceV2
  | EventSink.EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProviderEventIngestor.ProviderEventIngestorV2
  | ServerSettings.ServerSettingsService
  | McpAppModelContext.McpAppModelContext
  | PreviewAgentActivity.PreviewAgentActivity
  | TurnItemPositionStore.TurnItemPositionStoreV2
  | ThreadCommandExecutor.ThreadCommandExecutor
> = Layer.effect(
  RunExecutionServiceV2,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const checkpointService = yield* CheckpointService.CheckpointServiceV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const providerEventIngestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const mcpAppModelContext = yield* McpAppModelContext.McpAppModelContext;
    const previewAgentActivity = yield* PreviewAgentActivity.PreviewAgentActivity;
    const turnItemPositions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const finalizationObserver = yield* RunFinalizationService.RunFinalizationObserver;
    const turnAnalytics = yield* ProviderUsageAnalytics.ProviderTurnAnalytics;
    const pendingRootTerminals = new Map<RunAttemptId, Deferred.Deferred<void>>();
    const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;

    const commitFinalRunEvents = Effect.fn("RunExecutionService.commitFinalRunEvents")(
      function* (input: {
        readonly run: OrchestrationV2Run;
        readonly rootNode: OrchestrationV2ExecutionNode;
        readonly checkpointScope: OrchestrationV2CheckpointScope;
        readonly providerThread: OrchestrationV2ProviderThread;
        readonly attempt: OrchestrationV2RunAttempt;
        readonly shouldFinalizeRun?: () => Effect.Effect<boolean, ProjectionStoreV2Error>;
        readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean, never>;
        readonly loadRunInterruptReason?: () => Effect.Effect<string | undefined, never>;
        readonly openRunOwnedSubagents?: OpenRunOwnedSubagentProjection;
        readonly openRunOwnedSubagentsTerminal?: ProviderTerminalEvent;
        // Root turn snapshot written with the run when T3 ends the run itself.
        readonly abandonedProviderTurn?: OrchestrationV2ProviderTurn;
        // Open tool calls of the runtime T3 stopped: nothing else can record their end.
        readonly abandonedTurnItems?: ReadonlyArray<OrchestrationV2TurnItem>;
        // Stored root tool calls still open when the provider runtime was lost; nothing else ends them.
        readonly lostToolCalls?: ReadonlyArray<OrchestrationV2TurnItem>;
        readonly restoredHandoffs?: ReadonlyArray<OrchestrationV2ContextHandoff>;
        readonly terminal: ProviderTerminalEvent;
        readonly completedAt?: DateTime.Utc;
        readonly failureItemPersisted: boolean;
        readonly refreshAfterTurn: Effect.Effect<void>;
        readonly writeIfRunCurrent?: {
          readonly activeAttemptId: RunAttemptId;
          readonly expectedStatus: OrchestrationV2Run["status"];
          readonly unlessInterruptRequested?: boolean;
        };
      }) {
        const completedAt = input.completedAt ?? (yield* DateTime.now);
        const finalizedAttempt: OrchestrationV2RunAttempt = {
          ...input.attempt,
          status: input.terminal.status,
          completedAt,
        };
        const allocateEventId = () => idAllocator.allocate.event({ threadId: input.run.threadId });
        const buildRestoredHandoffEvents = () =>
          input.terminal.promptDropped === true &&
          input.restoredHandoffs !== undefined &&
          input.restoredHandoffs.length > 0
            ? Effect.forEach(input.restoredHandoffs, (handoff) =>
                Effect.map(allocateEventId(), (id) => ({
                  id,
                  type: "context-handoff.updated" as const,
                  threadId: input.run.threadId,
                  runId: input.run.id,
                  providerInstanceId: input.run.providerInstanceId,
                  occurredAt: completedAt,
                  payload: { ...handoff, updatedAt: completedAt },
                })),
              )
            : Effect.succeed([]);
        const shouldFinalizeRun =
          input.shouldFinalizeRun === undefined ? true : yield* input.shouldFinalizeRun();
        if (!shouldFinalizeRun) {
          const restoredHandoffEvents = yield* buildRestoredHandoffEvents();
          const unpairedInterruptEvents =
            input.terminal.status === "interrupted" &&
            (input.hasUnpairedRunInterruptRequest === undefined
              ? false
              : yield* input.hasUnpairedRunInterruptRequest())
              ? [
                  {
                    id: yield* allocateEventId(),
                    type: "turn-item.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: makeInterruptResultTurnItem({
                      idAllocator,
                      run: input.run,
                      rootNode: input.rootNode,
                      providerThread: input.providerThread,
                      reason:
                        (input.loadRunInterruptReason === undefined
                          ? undefined
                          : yield* input.loadRunInterruptReason()) ?? input.terminal.reason,
                      completedAt,
                    }),
                  },
                ]
              : [];
          const earlyEvents = [...unpairedInterruptEvents, ...restoredHandoffEvents];
          if (earlyEvents.length > 0) {
            yield* eventSink.writeWithEffects({
              effects: [],
              events: earlyEvents,
            });
            return input.refreshAfterTurn.pipe(Effect.as(false));
          }
          return Effect.succeed(false);
        }
        const reason =
          input.terminal.status === "interrupted"
            ? ((input.loadRunInterruptReason === undefined
                ? undefined
                : yield* input.loadRunInterruptReason()) ?? input.terminal.reason)
            : undefined;
        const open = input.openRunOwnedSubagents ?? emptyOpenRunOwnedSubagentProjection();
        const hasOpenSubagentProjection =
          open.subagents.size > 0 ||
          open.turnItems.size > 0 ||
          open.childTurnItems.size > 0 ||
          open.nodes.size > 0;
        const subagentTerminal = input.openRunOwnedSubagentsTerminal ?? input.terminal;
        const cascadedSubagentEvents =
          isRunOwnedSubagentTerminalStatus(subagentTerminal.status) &&
          !childTurnsContinue(subagentTerminal) &&
          hasOpenSubagentProjection
            ? yield* cascadeTerminalizeRunOwnedSubagents({
                run: input.run,
                open,
                status: subagentTerminal.status,
                completedAt,
                allocateEventId,
              })
            : [];
        // The run settles now; turn-end checkpoint capture follows on this thread's effect lane.
        const persistedStatus = input.terminal.status;
        const finalizedRun: OrchestrationV2Run = {
          ...input.run,
          status: persistedStatus,
          completedAt,
        };
        const finalizedRootNode: OrchestrationV2ExecutionNode = {
          ...input.rootNode,
          status: persistedStatus,
          completedAt,
          checkpointScopeId: input.checkpointScope.id,
        };
        const finalizedProviderThread: OrchestrationV2ProviderThread = {
          ...input.providerThread,
          status: finalProviderThreadStatus(input.terminal.threadDisposition),
          updatedAt: completedAt,
        };
        const restoredHandoffEvents = yield* buildRestoredHandoffEvents();
        const runEventId = yield* allocateEventId();
        const nodeEventId = yield* allocateEventId();
        const providerThreadEventId = yield* allocateEventId();
        const checkpointCaptureCommandId = CommandId.make(
          `command:effect:checkpoint.capture:${input.run.id}`,
        );
        // Stopped runs capture rollback points for the next message; enqueue before later starts on this effect lane.
        const finalization = {
          effects:
            input.terminal.status === "completed" ||
            input.terminal.status === "interrupted" ||
            input.terminal.status === "cancelled"
              ? [
                  {
                    id: `effect:checkpoint.capture:${input.run.id}`,
                    commandId: checkpointCaptureCommandId,
                    threadId: input.run.threadId,
                    request: {
                      type: "checkpoint.capture" as const,
                      runId: input.run.id,
                      scopeId: input.checkpointScope.id,
                    },
                  },
                ]
              : [],
          events: [
            ...cascadedSubagentEvents,
            ...(yield* interruptLostToolCalls({
              run: input.run,
              toolCalls: (input.lostToolCalls ?? []).filter(
                (lost) => !input.abandonedTurnItems?.some((item) => item.id === lost.id),
              ),
              completedAt,
              allocateEventId,
            })),
            ...(input.abandonedProviderTurn === undefined
              ? []
              : [
                  {
                    id: yield* allocateEventId(),
                    type: "provider-turn.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: input.abandonedProviderTurn,
                  },
                ]),
            ...(yield* Effect.forEach(input.abandonedTurnItems ?? [], (item) =>
              Effect.map(allocateEventId(), (id) =>
                abandonedTurnItemEvent({
                  id,
                  item,
                  providerInstanceId: input.run.providerInstanceId,
                  completedAt,
                }),
              ),
            )),
            {
              id: yield* allocateEventId(),
              type: "run-attempt.updated" as const,
              threadId: input.run.threadId,
              runId: input.run.id,
              nodeId: input.rootNode.id,
              providerInstanceId: input.run.providerInstanceId,
              occurredAt: completedAt,
              payload: finalizedAttempt,
            },
            ...(input.terminal.status === "interrupted"
              ? [
                  {
                    id: yield* allocateEventId(),
                    type: "turn-item.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: makeInterruptResultTurnItem({
                      idAllocator,
                      run: input.run,
                      rootNode: input.rootNode,
                      providerThread: input.providerThread,
                      reason,
                      completedAt,
                    }),
                  },
                ]
              : []),
            // Codex reports a hook that stops the turn as completed; keep its reason visible.
            ...(input.terminal.status === "completed" && input.terminal.reason !== undefined
              ? [
                  {
                    id: yield* allocateEventId(),
                    type: "turn-item.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: {
                      id: idAllocator.derive.runSignalTurnItem({
                        runId: input.run.id,
                        signal: PROVIDER_STOP_REASON_SIGNAL,
                      }),
                      threadId: input.run.threadId,
                      runId: input.run.id,
                      nodeId: input.rootNode.id,
                      providerThreadId: input.providerThread.id,
                      providerTurnId: input.rootNode.providerTurnId,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: input.run.ordinal * 100 + 98,
                      status: "completed" as const,
                      title: "Stopped by the provider",
                      startedAt: completedAt,
                      completedAt,
                      updatedAt: completedAt,
                      type: "system_notice" as const,
                      level: "warning" as const,
                      message: input.terminal.reason,
                    },
                  },
                ]
              : []),
            ...(input.terminal.status === "failed" && !input.failureItemPersisted
              ? [
                  {
                    id: yield* allocateEventId(),
                    type: "turn-item.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: makeProviderFailureTurnItem({
                      ...(input.terminal.failureItemId === undefined
                        ? {}
                        : { id: input.terminal.failureItemId }),
                      driver: input.terminal.driver,
                      threadId: input.run.threadId,
                      runId: input.run.id,
                      nodeId: input.rootNode.id,
                      providerThreadId: input.terminal.providerThreadId,
                      providerTurnId: input.terminal.providerTurnId,
                      itemOrdinal: input.terminal.failureItemOrdinal,
                      failure: input.terminal.failure,
                      occurredAt: completedAt,
                    }),
                  },
                ]
              : []),
            {
              id: runEventId,
              type: "run.updated",
              threadId: input.run.threadId,
              runId: input.run.id,
              nodeId: input.rootNode.id,
              providerInstanceId: input.run.providerInstanceId,
              occurredAt: completedAt,
              payload: finalizedRun,
            },
            {
              id: nodeEventId,
              type: "node.updated",
              threadId: input.run.threadId,
              runId: input.run.id,
              nodeId: input.rootNode.id,
              providerInstanceId: input.run.providerInstanceId,
              occurredAt: completedAt,
              payload: finalizedRootNode,
            },
            {
              id: providerThreadEventId,
              type: "provider-thread.updated",
              threadId: input.run.threadId,
              providerInstanceId: input.run.providerInstanceId,
              occurredAt: completedAt,
              payload: finalizedProviderThread,
            },
            ...restoredHandoffEvents,
          ],
        } satisfies Parameters<typeof eventSink.writeWithEffects>[0];
        if (input.writeIfRunCurrent !== undefined) {
          const result = yield* eventSink.writeIfRunCurrent({
            threadId: input.run.threadId,
            runId: input.run.id,
            activeAttemptId: input.writeIfRunCurrent.activeAttemptId,
            expectedStatus: input.writeIfRunCurrent.expectedStatus,
            ...(input.writeIfRunCurrent.unlessInterruptRequested === true
              ? {
                  unlessInterruptRequested: {
                    requestId: idAllocator.derive.runSignalTurnItem({
                      runId: input.run.id,
                      signal: "interrupt-request",
                    }),
                    resultId: idAllocator.derive.runSignalTurnItem({
                      runId: input.run.id,
                      signal: "interrupt-result",
                    }),
                  },
                }
              : {}),
            events: finalization.events,
            effects: finalization.effects,
          });
          if (!result.committed) {
            if (restoredHandoffEvents.length > 0) {
              yield* eventSink.writeWithEffects({
                effects: [],
                events: restoredHandoffEvents,
              });
              yield* input.refreshAfterTurn;
            }
            return Effect.succeed(false);
          }
        } else {
          yield* eventSink.writeWithEffects(finalization);
        }
        return turnAnalytics
          .runSettled({
            runId: input.run.id,
            status: input.terminal.status,
            completedAt,
            childrenRunning: hasOpenSubagentProjection && cascadedSubagentEvents.length === 0,
          })
          .pipe(Effect.andThen(input.refreshAfterTurn), Effect.as(true));
      },
    );

    // Commands plan from the run they read under this lock; deciding and committing the terminal
    // under it keeps a provider terminal from landing between such a read and its write.
    const writeFinalRunEvents = (input: Parameters<typeof commitFinalRunEvents>[0]) =>
      threadCommands.withLock(input.run.threadId, commitFinalRunEvents(input)).pipe(Effect.flatten);

    const captureRunBaseline = Effect.fn("RunExecutionService.captureBaseline")(function* (
      input: RunBaselineInput,
    ) {
      // Side chats share the parent's worktree; a snapshot would capture the parent's edits.
      if (input.appThread.lineage.sideChat === true) return;
      yield* checkpointService
        .captureBaseline({
          scope: input.checkpointScope,
          ordinalWithinScope: Math.max(0, input.run.ordinal - 1),
          thread: input.appThread,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning(
                  "orchestration V2 checkpoint baseline capture failed; starting provider without a baseline",
                  { runId: input.run.id, cause },
                ),
          ),
        );
    });

    return RunExecutionServiceV2.of({
      forkBaseline: (input) =>
        captureRunBaseline(input).pipe(
          Effect.forkChild({ startImmediately: true }),
          Effect.map(Fiber.join),
        ),
      startRootRun: Effect.fn("RunExecutionService.startRootRun")(function* (input) {
        const rootTurnOrigin: ProviderUsageAnalytics.ProviderTurnOrigin = {
          createdBy: input.message.createdBy,
          creationSource: input.message.creationSource,
          scheduled: input.message.scheduledTaskId !== undefined,
          subagent: input.appThread.lineage.relationshipToParent === "subagent",
        };
        // Startup failure and stream shutdown can report the same attempt.
        const refreshAfterTurn = yield* Effect.cached(
          finalizationObserver.refreshAfterTurn(input.appThread.projectId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to refresh pull requests after run termination", {
                threadId: input.run.threadId,
                runId: input.run.id,
                cause,
              }),
            ),
          ),
        );
        const failedProviderTurnId =
          input.attempt.providerTurnId ??
          idAllocator.derive.providerTurn({
            driver: input.providerThread.driver,
            nativeTurnId: `failed:${input.attempt.id}`,
          });
        const makeFailedTerminalEvent = (
          failure: OrchestrationV2ProviderFailure,
          failureItemOrdinal: number,
        ): ProviderTerminalEvent => ({
          type: "turn.terminal",
          driver: input.providerThread.driver,
          providerThreadId: input.providerThread.id,
          providerTurnId: failedProviderTurnId,
          runOrdinal: input.run.ordinal,
          failureItemOrdinal,
          status: "failed",
          failure,
          threadDisposition: "reusable",
        });
        const runConfig = yield* Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings;
          const responseStreamingMode = resolveProjectSettings(settings, input.appThread.projectId)
            .settings.responseStreamingMode;
          yield* input.adoptRunningTurn !== undefined
            ? Effect.void
            : (input.baseline ?? captureRunBaseline(input));
          if (
            input.shouldStartProviderTurn !== undefined &&
            !(yield* input.shouldStartProviderTurn())
          ) {
            return null;
          }
          return {
            responseStreamingMode,
            runLoopGuardSettings: settings.runLoopGuard,
          };
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterruptsOnly(cause)) {
                return yield* Effect.failCause(cause);
              }
              yield* Effect.logError("orchestration V2 run preparation failed", {
                runId: input.run.id,
                cause,
              });
              yield* writeFinalRunEvents({
                run: input.run,
                rootNode: input.rootNode,
                checkpointScope: input.checkpointScope,
                providerThread: input.providerThread,
                attempt: input.attempt,
                terminal: makeFailedTerminalEvent(
                  makeProviderFailure({
                    cause: Cause.squash(cause),
                    message: "Run preparation failed.",
                    class: "unknown",
                  }),
                  input.providerTurnOrdinal * 100 + 1,
                ),
                failureItemPersisted: false,
                refreshAfterTurn,
                writeIfRunCurrent: {
                  activeAttemptId: input.attemptId,
                  expectedStatus: "running",
                },
              });
              return null;
            }),
          ),
          Effect.mapError(
            (cause) =>
              new RunExecutionStartError({
                commandId: input.commandId,
                runId: input.run.id,
                cause,
              }),
          ),
        );
        if (runConfig === null) {
          return;
        }
        const { responseStreamingMode } = runConfig;
        const runLoopGuardState = makeRunLoopGuardState({
          role: resolveRunLoopRole({
            appThread: input.appThread,
            run: input.run,
            message: input.message,
          }),
          settings: runConfig.runLoopGuardSettings,
        });
        const guardAbortRef = yield* Ref.make<RunLoopAbortDecision | null>(null);
        const guardInterruptSentRef = yield* Ref.make(false);
        const terminalEvent = yield* Ref.make<ProviderTerminalEvent | null>(null);
        const adopted = input.adoptRunningTurn;
        const latestTurnItemOrdinal = yield* Ref.make(
          Math.max(
            input.providerTurnOrdinal * 100,
            ...(adopted?.turnItems.map((item) => item.ordinal) ?? []),
          ),
        );
        const latestProviderThread = yield* Ref.make(input.providerThread);
        const latestRootProviderTurn = yield* Ref.make<OrchestrationV2ProviderTurn | null>(
          adopted?.providerTurn ?? null,
        );
        // Later root turns in one attempt are provider continuations, such as Codex goal turns.
        let firstRootProviderTurnId: ProviderTurnId | undefined = adopted?.providerTurn.id;
        const analyticsContext = {
          runId: input.run.id,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimePolicy.runtimeMode,
          interactionMode: input.runtimePolicy.interactionMode,
          origin: rootTurnOrigin,
          ...(input.run.restartContinuationOfRunId === undefined
            ? {}
            : { restartContinuation: true }),
        } satisfies ProviderUsageAnalytics.ProviderTurnAnalyticsContext;
        if (input.attempt.reason === "initial") {
          yield* turnAnalytics.runStarted({
            runId: input.run.id,
            driver: input.providerThread.driver,
            context: { ...analyticsContext, segment: "initial" },
          });
        }
        const routeIdentity: ProviderEventRouteIdentity = {
          threadId: input.run.threadId,
          runId: input.run.id,
          attemptId: input.attempt.id,
          providerThreadId: input.providerThread.id,
        };
        const eventSubscription =
          input.session.subscribeEvents === undefined
            ? { events: input.session.events, close: Effect.void }
            : yield* input.session.subscribeEvents;
        const inheritedBackgroundTurnItems = yield* (
          input.loadInheritedBackgroundTurnItems?.() ?? Effect.succeed([])
        ).pipe(
          Effect.onError(() => eventSubscription.close),
          Effect.mapError(
            (cause) =>
              new RunExecutionStartError({
                commandId: input.commandId,
                runId: input.run.id,
                cause,
              }),
          ),
        );
        const inheritedBackgroundTurnItemsById = new Map(
          inheritedBackgroundTurnItems.map((item) => [item.id, item.runId]),
        );
        const eventRouting = yield* Ref.make<ProviderEventRoutingState>(
          makeProviderEventRoutingState({
            identity: routeIdentity,
            inheritedBackgroundTurnItems,
            providerTurnId: input.attempt.providerTurnId,
            ...(input.relatedThreadIds === undefined
              ? {}
              : { relatedThreadIds: input.relatedThreadIds }),
            ...(input.relatedProviderThreadIds === undefined
              ? {}
              : { relatedProviderThreadIds: input.relatedProviderThreadIds }),
          }),
        );
        const rootTerminalSeen = yield* Ref.make(false);
        const rootRunFinalized = yield* Ref.make(false);
        const providerThreadOwnerLost = yield* Ref.make(false);
        const pendingBackgroundProviderTurns = new Set<ProviderTurnId>();
        const activeChildProviderTurns = yield* Ref.make<ReadonlySet<ProviderTurnId>>(new Set());
        const activeChildSubagents = yield* Ref.make<ReadonlyMap<NodeId, ThreadId>>(new Map());
        const activeBackgroundTurnItems = yield* Ref.make<
          ReadonlySet<OrchestrationV2TurnItem["id"]>
        >(new Set(inheritedBackgroundTurnItemsById.keys()));
        const openRunOwnedSubagents = yield* Ref.make(emptyOpenRunOwnedSubagentProjection());
        // Open tool calls on the root thread, to end from their stored rows if the runtime is lost.
        const openRootToolCalls = new Set<TurnItemId>();
        // The last stored root snapshot still reports background work, by flag or task roster.
        let rootSnapshotPendingWork = false;
        // Owned child threads whose last snapshot reported pending work, such as a queued native
        // continuation. Unlike the root's, these must hold the stream past owner loss.
        const childSnapshotPendingWork = new Set<ProviderThreadId>();
        let rootTurnOwnershipChecked = false;
        const assistantStreaming = makeAssistantStreamingFilter(responseStreamingMode);
        // Set when ingestion ends or finalization settles the run's open items, which a later
        // streaming snapshot must not reopen.
        let idleFlushClosed = false;
        const workspaceHandedOff = Effect.suspend(() =>
          input.shouldFinalizeRun === undefined || input.hasWorkspaceMoved === undefined
            ? Effect.succeed(false)
            : input.hasWorkspaceMoved(),
        );
        // Stored snapshots, so a terminal T3 writes itself can settle them as stored.
        const openToolTurnItems = yield* Ref.make<ReadonlyMap<TurnItemId, OrchestrationV2TurnItem>>(
          new Map(),
        );
        const trackOpenToolTurnItems = (storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>) =>
          Effect.forEach(storedEvents, ({ event }) => {
            if (event.type !== "turn-item.updated") return Effect.void;
            const item = event.payload;
            if (
              item.threadId !== input.run.threadId ||
              (item.runId !== input.run.id &&
                (item.runId === null ||
                  inheritedBackgroundTurnItemsById.get(item.id) !== item.runId))
            ) {
              return Effect.void;
            }
            const open = isOpenToolTurnItem(item);
            return Ref.update(openToolTurnItems, (current) => {
              if (!open && !current.has(item.id)) return current;
              const next = new Map(current);
              if (open) next.set(item.id, item);
              else next.delete(item.id);
              return next;
            });
          });
        const finalizeRootRun = Effect.fn("RunExecutionService.finalizeRootRun")(function* (
          terminal: ProviderTerminalEvent,
          options?: {
            readonly abandonedProviderTurn?: OrchestrationV2ProviderTurn;
            readonly abandonedTurnItems?: ReadonlyArray<OrchestrationV2TurnItem>;
            readonly completedAt?: DateTime.Utc;
          },
        ) {
          if (yield* Ref.get(rootRunFinalized)) {
            return;
          }
          const guardAbort = yield* Ref.get(guardAbortRef);
          const effectiveTerminal: ProviderTerminalEvent =
            guardAbort !== null &&
            (terminal.status === "completed" || terminal.status === "interrupted")
              ? {
                  ...terminal,
                  status: "interrupted",
                  failure: null,
                  reason: guardAbort.reason,
                }
              : terminal;
          const completedAt = options?.completedAt ?? (yield* DateTime.now);
          const rootProviderTurn = yield* Ref.get(latestRootProviderTurn);
          const openToolItems = yield* Ref.get(openToolTurnItems);
          const abandonedProviderTurn =
            options?.abandonedProviderTurn !== undefined
              ? options.abandonedProviderTurn
              : guardAbort !== null &&
                  effectiveTerminal.status === "interrupted" &&
                  rootProviderTurn !== null &&
                  !isTerminalProviderTurnStatus(rootProviderTurn.status)
                ? {
                    ...rootProviderTurn,
                    status: "interrupted" as const,
                    completedAt,
                  }
                : undefined;
          const abandonedTurnItems =
            options?.abandonedTurnItems !== undefined
              ? options.abandonedTurnItems
              : guardAbort !== null &&
                  effectiveTerminal.status === "interrupted" &&
                  openToolItems.size > 0
                ? [...openToolItems.values()]
                : undefined;
          const providerThread = yield* Ref.get(latestProviderThread);
          const openSubagents = yield* Ref.get(openRunOwnedSubagents);
          const writeTerminal = Effect.fnUntraced(
            function* (settledTerminal: ProviderTerminalEvent) {
              const restoredHandoffs =
                settledTerminal.promptDropped === true &&
                input.loadDroppedInlineHandoffs !== undefined
                  ? yield* input.loadDroppedInlineHandoffs()
                  : undefined;
              return yield* writeFinalRunEvents({
                run: input.run,
                rootNode: input.rootNode,
                checkpointScope: input.checkpointScope,
                providerThread,
                attempt: input.attempt,
                ...(input.shouldFinalizeRun === undefined
                  ? {}
                  : {
                      shouldFinalizeRun: input.shouldFinalizeRun,
                      // Stop may commit between the ownership read and this
                      // terminal write. Gate the events and checkpoint together.
                      writeIfRunCurrent: {
                        activeAttemptId: input.attempt.id,
                        expectedStatus: "running" as const,
                        unlessInterruptRequested: settledTerminal !== effectiveTerminal,
                      },
                    }),
                ...(input.hasUnpairedRunInterruptRequest === undefined
                  ? {}
                  : {
                      hasUnpairedRunInterruptRequest: input.hasUnpairedRunInterruptRequest,
                    }),
                ...(input.loadRunInterruptReason === undefined
                  ? {}
                  : { loadRunInterruptReason: input.loadRunInterruptReason }),
                openRunOwnedSubagents: openSubagents,
                openRunOwnedSubagentsTerminal: effectiveTerminal,
                ...(abandonedProviderTurn === undefined ? {} : { abandonedProviderTurn }),
                ...(abandonedTurnItems === undefined || abandonedTurnItems.length === 0
                  ? {}
                  : { abandonedTurnItems }),
                ...(restoredHandoffs === undefined ? {} : { restoredHandoffs }),
                terminal: settledTerminal,
                completedAt,
                failureItemPersisted: settledTerminal.status === "failed",
                refreshAfterTurn,
              });
            },
            (effect) =>
              effect.pipe(
                Effect.mapError(
                  (cause) => new RunExecutionIngestError({ runId: input.run.id, cause }),
                ),
              ),
          );
          // A workspace handoff detaches the session and stops the turn that asked
          // for it: the run completes, while its native subagents still settle
          // as interrupted. The completed write refuses in the same transaction
          // as a stored Stop request, so a racing Stop stays authoritative.
          const handedOff =
            guardAbort === null &&
            effectiveTerminal.status === "interrupted" &&
            (yield* workspaceHandedOff);
          if (
            !handedOff ||
            !(yield* writeTerminal({ ...effectiveTerminal, status: "completed" }))
          ) {
            yield* writeTerminal(effectiveTerminal);
          }
          if (
            isRunOwnedSubagentTerminalStatus(effectiveTerminal.status) &&
            !childTurnsContinue(effectiveTerminal)
          ) {
            yield* Ref.set(openRunOwnedSubagents, emptyOpenRunOwnedSubagentProjection());
            idleFlushClosed = true;
          }
          yield* Ref.set(rootRunFinalized, true);
        });
        // The stored rows of the work this run still tracks as open on the given threads.
        const loadTrackedWork = Effect.fn("RunExecutionService.loadTrackedWork")(function* (
          threadIds: Iterable<ThreadId>,
        ) {
          const open = yield* Ref.get(openRunOwnedSubagents);
          const subagents = new Map<NodeId, OrchestrationV2Subagent>();
          const nodes = new Map<NodeId, OrchestrationV2ExecutionNode>();
          const turnItems = new Map<TurnItemId, OrchestrationV2TurnItem>();
          if (input.loadUnsettledWork === undefined) return { subagents, nodes, turnItems };
          const trackedItemIds = new Set<TurnItemId>([
            ...openRootToolCalls.keys(),
            ...open.childTurnItems.keys(),
            ...[...open.turnItems.values()].map((item) => item.id),
          ]);
          for (const threadId of new Set(threadIds)) {
            const stored = yield* input.loadUnsettledWork(
              threadId,
              [...open.nodes.values(), ...open.subagents.values()]
                .filter((record) => record.threadId === threadId)
                .map((record) => record.id),
            );
            for (const subagent of stored.subagents) {
              if (open.subagents.has(subagent.id) && !isSettledSubagentStatus(subagent.status)) {
                subagents.set(subagent.id, subagent);
              }
            }
            for (const node of stored.nodes) {
              if (open.nodes.has(node.id) && isOpenExecutionNodeStatus(node.status)) {
                nodes.set(node.id, node);
              }
            }
            for (const item of stored.turnItems) {
              if (trackedItemIds.has(item.id) && !isSettledTurnItemStatus(item.status)) {
                turnItems.set(item.id, item);
              }
            }
          }
          return { subagents, nodes, turnItems };
        });
        const loadLostRootToolCalls = loadTrackedWork([input.run.threadId]).pipe(
          Effect.map(({ turnItems }) =>
            [...turnItems.values()].filter((item) => openRootToolCalls.has(item.id)),
          ),
        );
        // Subagents and tool calls that outlived the root run die with the provider runtime. Stop
        // can settle them meanwhile, so each write holds only while its stored row is unchanged.
        const endWorkLostAfterRootRun = Effect.fn("RunExecutionService.endWorkLostAfterRootRun")(
          function* (completedAt: DateTime.Utc) {
            const allocateEventId = () =>
              idAllocator.allocate.event({ threadId: input.run.threadId });
            const open = yield* Ref.get(openRunOwnedSubagents);
            const stored = yield* loadTrackedWork([
              input.run.threadId,
              ...[
                ...open.subagents.values(),
                ...open.nodes.values(),
                ...open.childTurnItems.values(),
              ].map((record) => record.threadId),
            ]);
            for (const subagent of stored.subagents.values()) {
              const subagentItemId = open.turnItems.get(subagent.id)?.id;
              const subagentItem =
                subagentItemId === undefined ? undefined : stored.turnItems.get(subagentItemId);
              const events = yield* cascadeTerminalizeRunOwnedSubagents({
                run: input.run,
                open: {
                  subagents: new Map([[subagent.id, subagent]]),
                  turnItems: new Map(
                    subagentItem?.type === "subagent" ? [[subagent.id, subagentItem]] : [],
                  ),
                  childTurnItems: new Map(
                    [...stored.turnItems].filter(
                      ([id, item]) =>
                        open.childTurnItems.has(id) && item.threadId === subagent.childThreadId,
                    ),
                  ),
                  nodes: new Map(
                    [...stored.nodes].filter(
                      ([id, node]) =>
                        id === subagent.id || node.threadId === subagent.childThreadId,
                    ),
                  ),
                  linkedChildThreadIds: new Set(
                    subagent.childThreadId === null ? [] : [subagent.childThreadId],
                  ),
                },
                status: "failed",
                completedAt,
                allocateEventId,
              });
              yield* eventSink.writeIfSubagentUnchanged({ expected: subagent, events });
            }
            for (const toolCall of stored.turnItems.values()) {
              if (!openRootToolCalls.has(toolCall.id)) continue;
              yield* eventSink.writeIfTurnItemUnchanged({
                expected: toolCall,
                events: yield* interruptLostToolCalls({
                  run: input.run,
                  toolCalls: [toolCall],
                  completedAt,
                  allocateEventId,
                }),
              });
            }
            yield* Ref.set(openRunOwnedSubagents, emptyOpenRunOwnedSubagentProjection());
            openRootToolCalls.clear();
          },
          (effect) =>
            effect.pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) =>
                  Effect.logWarning(
                    "orchestration V2 failed to end work lost with the provider runtime",
                    { runId: input.run.id, cause },
                  ),
              ),
            ),
        );
        const dispatchGuardInterruptTurn = Effect.fn(
          "RunExecutionService.dispatchGuardInterruptTurn",
        )(function* (reason: string) {
          if (input.session.interruptTurn === undefined) {
            return;
          }
          const routing = yield* Ref.get(eventRouting);
          const providerTurnId = routing.rootProviderTurnId;
          if (providerTurnId === null) {
            return;
          }
          const alreadySent = yield* Ref.modify(guardInterruptSentRef, (sent) => [sent, true]);
          if (alreadySent) {
            return;
          }
          const providerThread = yield* Ref.get(latestProviderThread);
          // Fork so interrupting the active provider turn cannot deadlock on this event stream.
          yield* input.session
            .interruptTurn({
              providerThread,
              providerTurnId,
              requestRuntimeRestart: true,
            })
            .pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) =>
                  Effect.logWarning("orchestration-v2.run-loop-guard.interrupt-failed", {
                    runId: input.run.id,
                    providerTurnId,
                    reason,
                    cause,
                  }),
              ),
              Effect.forkIn(scope),
            );
        });
        const requestGuardInterrupt = Effect.fn("RunExecutionService.requestGuardInterrupt")(
          function* (decision: RunLoopAbortDecision) {
            yield* Ref.set(guardAbortRef, decision);
            yield* Effect.logWarning("orchestration-v2.run-loop-guard.aborted", {
              runId: input.run.id,
              threadId: input.run.threadId,
              attemptId: input.attempt.id,
              role: decision.role,
              code: decision.code,
              observedCount: decision.observedCount,
              limit: decision.limit,
              ...(decision.errorSignature === undefined
                ? {}
                : { errorSignature: decision.errorSignature }),
              reason: decision.reason,
            });
            const alreadyRequested =
              input.hasUnpairedRunInterruptRequest === undefined
                ? false
                : yield* input.hasUnpairedRunInterruptRequest();
            if (!alreadyRequested) {
              const now = yield* DateTime.now;
              const routing = yield* Ref.get(eventRouting);
              const providerThread = yield* Ref.get(latestProviderThread);
              const itemOrdinal = (yield* Ref.get(latestTurnItemOrdinal)) + 1;
              const requestEventId = yield* idAllocator.allocate.event();
              const interruptRequestEvent: OrchestrationV2DomainEvent = {
                id: requestEventId,
                type: "turn-item.updated",
                threadId: input.run.threadId,
                runId: input.run.id,
                nodeId: input.rootNode.id,
                providerInstanceId: input.run.providerInstanceId,
                occurredAt: now,
                payload: makeInterruptRequestTurnItem({
                  idAllocator,
                  run: input.run,
                  rootNode: input.rootNode,
                  providerThread,
                  providerTurnId: routing.rootProviderTurnId ?? input.attempt.providerTurnId,
                  ordinal: itemOrdinal,
                  reason: decision.reason,
                  occurredAt: now,
                }),
              };
              yield* Effect.suspend(() =>
                input.shouldFinalizeRun !== undefined
                  ? eventSink
                      .writeIfRunCurrent({
                        threadId: input.run.threadId,
                        runId: input.run.id,
                        activeAttemptId: input.attempt.id,
                        expectedStatus: "running",
                        events: [interruptRequestEvent],
                        effects: [],
                      })
                      .pipe(Effect.asVoid)
                  : eventSink
                      .writeWithEffects({
                        events: [interruptRequestEvent],
                        effects: [],
                      })
                      .pipe(Effect.asVoid),
              ).pipe(Effect.ignoreCause);
            }
            yield* dispatchGuardInterruptTurn(decision.reason);
          },
        );
        // Runs for every provider event, including streamed text updates; avoid a per-event span.
        const trackChildLifecycle = Effect.fnUntraced(function* (
          event: ProviderAdapter.ProviderAdapterV2Event,
          deliverable: boolean,
        ) {
          const routing = yield* Ref.get(eventRouting);
          if (event.type === "provider_turn.updated") {
            const isRoot =
              event.providerTurn.runAttemptId === input.attempt.id ||
              event.providerTurn.id === routing.rootProviderTurnId;
            if (!isRoot) {
              yield* Ref.update(activeChildProviderTurns, (current) => {
                const next = new Set(current);
                if (isTerminalProviderTurnStatus(event.providerTurn.status)) {
                  next.delete(event.providerTurn.id);
                } else {
                  next.add(event.providerTurn.id);
                }
                return next;
              });
            }
          }
          if (event.type === "subagent.updated") {
            const belongsToRootRun = event.subagent.runId === input.run.id;
            const belongsToOwnedChildThread =
              event.subagent.threadId !== input.run.threadId &&
              routing.ownedThreadIds.has(event.subagent.threadId);
            if (belongsToRootRun || belongsToOwnedChildThread) {
              yield* Ref.update(activeChildSubagents, (current) => {
                const next = new Map(current);
                if (isSettledSubagentStatus(event.subagent.status)) {
                  next.delete(event.subagent.id);
                } else {
                  next.set(event.subagent.id, event.subagent.threadId);
                }
                return next;
              });
            }
            // Preserve childThreadId linkage for the root-run lifetime even after the subagent
            // row terminalizes, so open child-thread nodes can still be proven linked on a
            // later root interrupt. A provider records nested native subagents on the child
            // thread, runless; they die with this run too.
            if (
              belongsToRootRun ||
              (belongsToOwnedChildThread &&
                event.subagent.runId === null &&
                event.subagent.origin === "provider_native")
            ) {
              yield* Ref.update(openRunOwnedSubagents, (current) => {
                const withLink = withLinkedChildThreadId(current, event.subagent.childThreadId);
                const subagents = new Map(withLink.subagents);
                if (isSettledSubagentStatus(event.subagent.status)) {
                  subagents.delete(event.subagent.id);
                } else {
                  subagents.set(event.subagent.id, event.subagent);
                }
                return { ...withLink, subagents };
              });
            }
          }
          if (event.type === "node.updated") {
            const belongsToRootSubagent =
              event.node.kind === "subagent" && event.node.runId === input.run.id;
            const belongsToOwnedChildThread =
              event.node.threadId !== input.run.threadId &&
              routing.ownedThreadIds.has(event.node.threadId);
            if (
              !belongsToRootSubagent &&
              !(
                belongsToOwnedChildThread &&
                (event.node.runId === null || event.node.runId === input.run.id)
              )
            ) {
              return;
            }
            yield* Ref.update(openRunOwnedSubagents, (current) => {
              const nodes = new Map(current.nodes);
              if (isOpenExecutionNodeStatus(event.node.status)) {
                nodes.set(event.node.id, event.node);
              } else {
                nodes.delete(event.node.id);
              }
              return { ...current, nodes };
            });
          }
          if (event.type === "turn_item.updated") {
            const belongsToRootRun = event.turnItem.runId === input.run.id;
            const belongsToOwnedChildThread =
              event.turnItem.threadId !== input.run.threadId &&
              routing.ownedThreadIds.has(event.turnItem.threadId);
            const belongsToInheritedBackgroundItem =
              event.turnItem.threadId === input.run.threadId &&
              event.turnItem.runId !== null &&
              inheritedBackgroundTurnItemsById.get(event.turnItem.id) === event.turnItem.runId;
            if (
              backgroundCapableTurnItemTypes.has(event.turnItem.type) &&
              (belongsToRootRun || belongsToOwnedChildThread || belongsToInheritedBackgroundItem)
            ) {
              yield* Ref.update(activeBackgroundTurnItems, (current) => {
                const next = new Set(current);
                if (isSettledTurnItemStatus(event.turnItem.status)) {
                  next.delete(event.turnItem.id);
                } else {
                  next.add(event.turnItem.id);
                }
                return next;
              });
              if (
                event.turnItem.threadId === input.run.threadId &&
                processBoundToolCallTypes.has(event.turnItem.type)
              ) {
                if (isSettledTurnItemStatus(event.turnItem.status)) {
                  openRootToolCalls.delete(event.turnItem.id);
                } else {
                  openRootToolCalls.add(event.turnItem.id);
                }
              }
            }
            if (
              belongsToOwnedChildThread &&
              (event.turnItem.runId === null || belongsToRootRun) &&
              deliverable
            ) {
              yield* Ref.update(openRunOwnedSubagents, (current) => {
                const childTurnItems = new Map(current.childTurnItems);
                if (isSettledTurnItemStatus(event.turnItem.status)) {
                  childTurnItems.delete(event.turnItem.id);
                } else {
                  childTurnItems.set(event.turnItem.id, event.turnItem);
                }
                return { ...current, childTurnItems };
              });
            }
            if (belongsToRootRun && event.turnItem.type === "subagent") {
              const subagentItem = event.turnItem;
              yield* Ref.update(openRunOwnedSubagents, (current) => {
                const withLink = withLinkedChildThreadId(current, subagentItem.childThreadId);
                const turnItems = new Map(withLink.turnItems);
                if (isSettledTurnItemStatus(subagentItem.status)) {
                  turnItems.delete(subagentItem.subagentId);
                } else {
                  turnItems.set(subagentItem.subagentId, subagentItem);
                }
                return { ...withLink, turnItems };
              });
            }
          }
        });
        const agentTurnsSettled = Effect.gen(function* () {
          if (!(yield* Ref.get(rootTerminalSeen))) {
            return false;
          }
          const terminal = yield* Ref.get(terminalEvent);
          if (
            terminal !== null &&
            terminal.status !== "completed" &&
            !childTurnsContinue(terminal)
          ) {
            return true;
          }
          if (pendingBackgroundProviderTurns.size > 0) {
            return false;
          }
          const childProviderTurns = yield* Ref.get(activeChildProviderTurns);
          if (childProviderTurns.size > 0) {
            return false;
          }
          const childSubagents = yield* Ref.get(activeChildSubagents);
          return childSubagents.size === 0;
        });
        // Claude background Bash has no turn-item projection. Use only the
        // thread-scoped probe: session-wide pending work (siblings, wake
        // buffers, session subagents) must not pin this root subscription.
        const threadHasPendingBackgroundWork = Effect.gen(function* () {
          // The live probe reads adapter state, which can be ahead of the events consumed here.
          if (rootSnapshotPendingWork) {
            return true;
          }
          if (input.session.hasPendingBackgroundWorkForThread === undefined) {
            return false;
          }
          const latest = yield* Ref.get(latestProviderThread);
          if (
            input.session.backgroundTasksEndWithProcess &&
            (latest.pendingBackgroundTasks?.length ?? 0) > 0
          )
            return true;
          return yield* input.session
            .hasPendingBackgroundWorkForThread(latest)
            .pipe(Effect.catchCause(() => Effect.succeed(false)));
        });
        const shouldStopProviderEventIngestion = Effect.gen(function* () {
          if (!(yield* agentTurnsSettled)) {
            return false;
          }
          const terminal = yield* Ref.get(terminalEvent);
          if (
            terminal !== null &&
            terminal.status !== "completed" &&
            !childTurnsContinue(terminal)
          ) {
            // A failed turn can leave background work running in a live provider process.
            return (
              terminal.status !== "failed" ||
              (yield* Ref.get(providerThreadOwnerLost)) ||
              !(yield* threadHasPendingBackgroundWork)
            );
          }
          // Newly owned items depend on adapters emitting a non-terminal event before the root
          // terminal. Owner loss (a newer run claimed lastRunOrdinal) must not close this stream
          // while these sets are non-empty: turn_item.updated writes are not ownership-gated, so
          // late completions still land.
          const backgroundItems = yield* Ref.get(activeBackgroundTurnItems);
          if (backgroundItems.size > 0 || childSnapshotPendingWork.size > 0) {
            return false;
          }
          if (yield* Ref.get(providerThreadOwnerLost)) {
            return true;
          }
          return !(yield* threadHasPendingBackgroundWork);
        });
        // Held text writes nothing, so its item would take a position only
        // when finally written, behind every item that began after it.
        const reservedHeldTurnItemIds = new Set<TurnItemId>();
        // Ends once the root turn and the children it drives settle. Background commands such
        // as a dev server keep this consumer alive afterwards and must not pin preview focus.
        const endPreviewActivity = yield* previewAgentActivity.begin(input.run.threadId);
        const rootTerminalIngested = yield* Deferred.make<void>();
        pendingRootTerminals.set(input.attempt.id, rootTerminalIngested);
        const settleRootTerminal = Effect.suspend(() => {
          if (pendingRootTerminals.get(input.attempt.id) === rootTerminalIngested) {
            pendingRootTerminals.delete(input.attempt.id);
          }
          return Deferred.succeed(rootTerminalIngested, undefined);
        });
        // Per-event routing and lifecycle bookkeeping share the run's tracing boundary.
        const routeEvent = Effect.fnUntraced(function* (
          event: ProviderAdapter.ProviderAdapterV2Event,
        ) {
          const previous = yield* Ref.get(eventRouting);
          const [accepted, routing] = routeProviderEvent(event, routeIdentity, previous);
          yield* Ref.set(eventRouting, routing);
          if (
            event.type === "subagent.updated" &&
            event.subagent.childThreadId !== null &&
            previous.ownedThreadIds.has(event.subagent.childThreadId) &&
            !routing.ownedThreadIds.has(event.subagent.childThreadId)
          ) {
            const moved = event.subagent;
            const detached = yield* Ref.modify(openRunOwnedSubagents, (current) => {
              const subagentIds = new Set([moved.id]);
              for (const subagent of current.subagents.values()) {
                if (subagent.threadId === moved.childThreadId) subagentIds.add(subagent.id);
              }
              const childTurnItems = new Map(
                [...current.childTurnItems].filter(
                  ([, item]) => item.threadId !== moved.childThreadId,
                ),
              );
              const turnItems = new Map(current.turnItems);
              turnItems.delete(moved.id);
              const detachedItems = new Set(
                [...current.childTurnItems.values(), ...current.turnItems.values()]
                  .filter(
                    (item) => item.threadId === moved.childThreadId || item.nodeId === moved.id,
                  )
                  .map((item) => item.id),
              );
              return [
                { itemIds: detachedItems, subagentIds },
                {
                  subagents: new Map([...current.subagents].filter(([id]) => !subagentIds.has(id))),
                  turnItems,
                  childTurnItems,
                  nodes: new Map(
                    [...current.nodes].filter(
                      ([id, node]) => id !== moved.id && node.threadId !== moved.childThreadId,
                    ),
                  ),
                  linkedChildThreadIds: new Set(
                    [...current.linkedChildThreadIds].filter((id) => id !== moved.childThreadId),
                  ),
                },
              ];
            });
            yield* Ref.update(
              activeChildSubagents,
              (current) =>
                new Map(
                  [...current].filter(
                    ([id, threadId]) =>
                      !detached.subagentIds.has(id) && threadId !== moved.childThreadId,
                  ),
                ),
            );
            yield* Ref.update(
              activeChildProviderTurns,
              (current) => new Set([...current].filter((id) => routing.ownedProviderTurns.has(id))),
            );
            for (const id of pendingBackgroundProviderTurns) {
              if (!routing.ownedProviderTurns.has(id)) {
                pendingBackgroundProviderTurns.delete(id);
              }
            }
            // Routing now rejects the moved thread's snapshots, so none would clear its entry.
            for (const id of childSnapshotPendingWork) {
              if (!routing.ownedProviderThreadIds.has(id)) childSnapshotPendingWork.delete(id);
            }
            yield* Ref.update(
              activeBackgroundTurnItems,
              (current) => new Set([...current].filter((id) => !detached.itemIds.has(id))),
            );
          }
          return { event, accepted };
        });
        // Per-event ingestion avoids adding a span for every provider snapshot.
        const ingestDelivered = Effect.fnUntraced(function* (
          event: ProviderAdapter.ProviderAdapterV2Event,
          deliveredEvent: ProviderAdapter.ProviderAdapterV2Event,
        ) {
          const rootTerminalAlreadySeen = yield* Ref.get(rootTerminalSeen);
          const isRootProviderThreadUpdate =
            event.type === "provider_thread.updated" &&
            event.providerThread.id === input.providerThread.id;
          const nativeChildTurn =
            event.type === "provider_turn.updated" &&
            event.providerTurn.providerThreadId !== input.providerThread.id;
          if (event.type === "provider_turn.updated" && !nativeChildTurn) {
            firstRootProviderTurnId ??= event.providerTurn.id;
          }
          const storedEvents = yield* providerEventIngestor.ingestNormalized({
            analyticsContext: nativeChildTurn
              ? {
                  ...analyticsContext,
                  origin: NATIVE_SUBAGENT_TURN_ORIGIN,
                  segment: "native_child",
                }
              : {
                  ...analyticsContext,
                  segment:
                    event.type === "provider_turn.updated" &&
                    event.providerTurn.id !== firstRootProviderTurnId
                      ? "continuation"
                      : input.attempt.reason,
                },
            providerSessionId: input.providerSessionId,
            providerInstanceId: input.run.providerInstanceId,
            threadId: input.run.threadId,
            runId: input.run.id,
            nodeId: input.rootNode.id,
            event: deliveredEvent,
            ...(isRootProviderThreadUpdate
              ? rootTerminalAlreadySeen
                ? {
                    writeIfProviderThreadOwner: {
                      providerThreadId: input.providerThread.id,
                      runId: input.run.id,
                      activeAttemptId: input.attempt.id,
                      expectedLastRunOrdinal: input.run.ordinal,
                    },
                  }
                : {
                    writeIfRunCurrent: {
                      runId: input.run.id,
                      activeAttemptId: input.attempt.id,
                      expectedStatus: "running" as const,
                    },
                  }
              : {}),
          });
          if (isRootProviderThreadUpdate && rootTerminalAlreadySeen && storedEvents.length === 0) {
            yield* Ref.set(providerThreadOwnerLost, true);
          }
          yield* trackOpenToolTurnItems(storedEvents);
          return storedEvents.length;
        });
        // The timer only wakes ingestion. The flush runs as an ingestion step outside any provider
        // batch, so it stays ordered with routing and snapshots, and a write has committed when
        // it returns.
        const idleFlushTicks = yield* Queue.dropping<{
          readonly type: "idle_flush";
          readonly at: number;
        }>(1);
        let idleFlushWake: { readonly at: number; readonly fiber: Fiber.Fiber<void> } | undefined;
        const scheduleIdleFlush = Effect.suspend(() => {
          const at = assistantStreaming.nextIdleFlushAt();
          if (
            idleFlushClosed ||
            at === null ||
            (idleFlushWake !== undefined && idleFlushWake.at <= at)
          )
            return Effect.void;
          const previous = idleFlushWake?.fiber;
          return Effect.gen(function* () {
            if (previous !== undefined) yield* Fiber.interrupt(previous);
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            const fiber = yield* Effect.sleep(Duration.millis(Math.max(0, at - now))).pipe(
              Effect.andThen(Queue.offer(idleFlushTicks, { type: "idle_flush", at })),
              Effect.asVoid,
              Effect.forkDetach,
            );
            idleFlushWake = { at, fiber };
          });
        });
        const closeIdleFlush = Effect.suspend(() => {
          idleFlushClosed = true;
          const wake = idleFlushWake;
          idleFlushWake = undefined;
          return wake === undefined ? Effect.void : Fiber.interrupt(wake.fiber);
        });
        // Per-tick ingestion avoids adding a span for every idle wake.
        const flushIdleAssistantText = Effect.fnUntraced(function* (wokeAt: number) {
          // A tick means its timer slept until `wokeAt`, but the wall clock can still read up
          // to a millisecond earlier; trusting it would keep the finished wake and never re-arm.
          const now = Math.max(DateTime.toEpochMillis(yield* DateTime.now), wokeAt);
          // A wake due by now has fired; a later deadline needs a new one.
          if (idleFlushWake !== undefined && idleFlushWake.at <= now) idleFlushWake = undefined;
          if (idleFlushClosed) return;
          const rootSettled = yield* Ref.get(rootRunFinalized);
          for (const event of assistantStreaming.takeIdleFlushes(now)) {
            // Settling the root run closed its messages; only children may still stream.
            if (rootSettled && streamedThreadId(event) === input.run.threadId) continue;
            // The held text's child may have been handed to another run since it arrived.
            if (!routeProviderEvent(event, routeIdentity, yield* Ref.get(eventRouting))[0])
              continue;
            // A failed write fails ingestion like any provider write.
            yield* ingestDelivered(event, event);
            yield* trackChildLifecycle(event, true);
          }
          yield* scheduleIdleFlush;
        });
        const ingestEvent = Effect.fnUntraced(function* ({
          event,
          accepted,
        }: {
          event: ProviderAdapter.ProviderAdapterV2Event;
          accepted: boolean;
        }) {
          if (!accepted) return;
          if (
            event.type === "provider_turn.updated" &&
            event.providerTurn.runAttemptId === input.attempt.id &&
            event.providerTurn.providerThreadId === input.providerThread.id
          ) {
            yield* Ref.set(latestRootProviderTurn, event.providerTurn);
          }
          let storedEventCount = 0;
          const deliveredEvent = assistantStreaming.filter(
            event,
            DateTime.toEpochMillis(yield* DateTime.now),
          );
          const startedRootTurn =
            event.type === "provider_turn.updated" &&
            event.providerTurn.runAttemptId === input.attempt.id &&
            event.providerTurn.providerThreadId === input.providerThread.id &&
            !isTerminalProviderTurnStatus(event.providerTurn.status) &&
            !rootTurnOwnershipChecked
              ? event.providerTurn
              : undefined;
          const shouldStartProviderTurn = input.shouldStartProviderTurn;
          if (deliveredEvent && startedRootTurn !== undefined && shouldStartProviderTurn) {
            rootTurnOwnershipChecked = true;
            // Stop plans under this lock from stored turns. Storing the first turn and rechecking
            // the attempt under it means Stop either saw the turn or already settled the run.
            const [stored, owned] = yield* threadCommands.withLock(
              input.run.threadId,
              Effect.all([
                ingestDelivered(event, deliveredEvent),
                shouldStartProviderTurn().pipe(Effect.orElseSucceed(() => true)),
              ]),
            );
            storedEventCount = stored;
            if (!owned) {
              yield* Ref.get(latestProviderThread).pipe(
                Effect.flatMap((providerThread) =>
                  input.session.interruptTurn({
                    providerThread,
                    providerTurnId: startedRootTurn.id,
                  }),
                ),
                Effect.catchCauseIf(
                  (cause) => !Cause.hasInterruptsOnly(cause),
                  (cause) =>
                    Effect.logWarning(
                      "orchestration V2 failed to interrupt a provider turn that started after Stop",
                      { runId: input.run.id, cause },
                    ),
                ),
                Effect.forkIn(scope),
              );
            }
          } else if (deliveredEvent) {
            storedEventCount = yield* ingestDelivered(event, deliveredEvent);
          } else if (
            event.type === "turn_item.updated" &&
            (event.turnItem.type === "assistant_message" || event.turnItem.type === "reasoning") &&
            event.turnItem.streaming &&
            !reservedHeldTurnItemIds.has(event.turnItem.id)
          ) {
            yield* turnItemPositions.allocate({
              threadId: event.turnItem.threadId,
              turnItemId: event.turnItem.id,
              runId: event.turnItem.runId,
            });
            reservedHeldTurnItemIds.add(event.turnItem.id);
          }
          if (event.type === "provider_thread.updated") {
            if (event.providerThread.id === input.providerThread.id && storedEventCount > 0) {
              yield* Ref.set(latestProviderThread, event.providerThread);
              rootSnapshotPendingWork =
                event.pendingBackgroundWork === true ||
                (event.providerThread.pendingBackgroundTasks?.length ?? 0) > 0;
            } else if (event.providerThread.id !== input.providerThread.id) {
              if (event.pendingBackgroundWork === true) {
                childSnapshotPendingWork.add(event.providerThread.id);
              } else if (event.pendingBackgroundWork === false) {
                childSnapshotPendingWork.delete(event.providerThread.id);
              }
            }
          }
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.providerTurnId === (yield* Ref.get(eventRouting)).rootProviderTurnId
          ) {
            yield* Ref.update(latestTurnItemOrdinal, (current) =>
              Math.max(current, event.turnItem.ordinal),
            );
          }
          const guardDecision = stepRunLoopGuard(runLoopGuardState, {
            event,
            attemptId: input.attempt.id,
            rootThreadId: input.run.threadId,
            rootProviderThreadId: input.providerThread.id,
          });
          if (guardDecision !== null) {
            yield* requestGuardInterrupt(guardDecision);
          } else if (event.type === "provider_turn.updated") {
            const guardAbort = yield* Ref.get(guardAbortRef);
            if (guardAbort !== null) {
              yield* dispatchGuardInterruptTurn(guardAbort.reason);
            }
          }
          if (event.type === "turn.terminal") {
            yield* Ref.set(terminalEvent, event);
            yield* Ref.set(rootTerminalSeen, true);
            yield* finalizeRootRun(event);
            yield* settleRootTerminal;
          }
          if (event.type === "background_work.updated") {
            if (event.pending) {
              pendingBackgroundProviderTurns.add(event.providerTurnId);
            } else {
              pendingBackgroundProviderTurns.delete(event.providerTurnId);
            }
          }
          yield* trackChildLifecycle(event, deliveredEvent !== null);
          yield* scheduleIdleFlush;
        });
        // Text held back for streaming is stored in full before a detach records its replay point.
        yield* (
          eventSubscription.setBarrierFlush?.(
            Effect.gen(function* () {
              const now = DateTime.toEpochMillis(yield* DateTime.now);
              const rootSettled = yield* Ref.get(rootRunFinalized);
              for (const event of assistantStreaming.flushHeld(now)) {
                // Settling the root run closed its messages; only children may still stream.
                if (rootSettled && streamedThreadId(event) === input.run.threadId) continue;
                // The held text's child may have been handed to another run since it arrived.
                if (!routeProviderEvent(event, routeIdentity, yield* Ref.get(eventRouting))[0])
                  continue;
                yield* ingestDelivered(event, event);
                yield* trackChildLifecycle(event, true);
              }
            }).pipe(
              Effect.as(true),
              Effect.catchCause((cause) =>
                Effect.logError("Held assistant text could not be stored", cause).pipe(
                  Effect.as(false),
                ),
              ),
            ),
          ) ?? Effect.void
        );
        const providerEventFiber = yield* eventSink
          .consumeProviderEvents(
            eventSubscription.events.pipe(
              Stream.merge(Stream.fromQueue(idleFlushTicks), { haltStrategy: "left" }),
            ),
            (event) =>
              event.type === "idle_flush"
                ? flushIdleAssistantText(event.at)
                : Effect.gen(function* () {
                    yield* ingestEvent(yield* routeEvent(event));
                  }),
            Effect.gen(function* () {
              if (yield* agentTurnsSettled) yield* endPreviewActivity;
              return yield* shouldStopProviderEventIngestion;
            }),
            Ref.get(rootTerminalSeen).pipe(Effect.map((seen) => !seen)),
            { threadId: input.run.threadId, delegated: isDelegatedAppThread(input.appThread) },
          )
          .pipe(
            Effect.ensuring(closeIdleFlush),
            Effect.mapError((cause) => new RunExecutionIngestError({ runId: input.run.id, cause })),
            Effect.flatMap(() =>
              Effect.gen(function* () {
                const terminal = yield* Ref.get(terminalEvent);
                if (terminal === null) {
                  const guardAbort = yield* Ref.get(guardAbortRef);
                  if (guardAbort !== null) {
                    const routing = yield* Ref.get(eventRouting);
                    yield* finalizeRootRun({
                      type: "turn.terminal",
                      driver: input.providerThread.driver,
                      providerThreadId: input.providerThread.id,
                      providerTurnId:
                        routing.rootProviderTurnId ??
                        input.attempt.providerTurnId ??
                        idAllocator.derive.providerTurn({
                          driver: input.providerThread.driver,
                          nativeTurnId: `interrupted:${input.attempt.id}`,
                        }),
                      runOrdinal: input.run.ordinal,
                      status: "interrupted",
                      failure: null,
                      reason: guardAbort.reason,
                      threadDisposition: "reusable",
                    });
                    return;
                  }
                  // A session release interrupts or fails the stream; a clean
                  // end without a terminal means the run would never settle.
                  return yield* new RunExecutionIngestError({
                    runId: input.run.id,
                    cause: new ProviderAdapter.ProviderAdapterEventStreamError({
                      driver: input.providerThread.driver,
                      providerSessionId: input.providerSessionId,
                      raisedByT3: true,
                      cause: "Provider event stream ended without a root terminal.",
                    }),
                  });
                }
                yield* finalizeRootRun(terminal);
              }),
            ),
            // Server shutdown interrupts the subscription and leaves the run to
            // restart recovery; every other failure fails the run.
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) =>
                Effect.gen(function* () {
                  const completedAt = yield* DateTime.now;
                  const routing = yield* Ref.get(eventRouting);
                  const rootProviderTurn = yield* Ref.get(latestRootProviderTurn);
                  const squashed = Cause.squash(cause);
                  // An exclusive session closes when its thread detaches, and no terminal
                  // follows. The process is gone, so a handoff settles here with no interrupt.
                  if (
                    isRunExecutionIngestError(squashed) &&
                    isProviderEventStreamError(squashed.cause) &&
                    squashed.cause.detachedThreadId === input.run.threadId &&
                    (yield* workspaceHandedOff)
                  ) {
                    const handedOff = yield* finalizeRootRun(
                      {
                        type: "turn.terminal",
                        driver: input.providerThread.driver,
                        providerThreadId: input.providerThread.id,
                        providerTurnId: routing.rootProviderTurnId ?? failedProviderTurnId,
                        runOrdinal: input.run.ordinal,
                        status: "interrupted",
                        failure: null,
                        threadDisposition: "reusable",
                      },
                      rootProviderTurn === null ||
                        isTerminalProviderTurnStatus(rootProviderTurn.status)
                        ? undefined
                        : {
                            abandonedProviderTurn: {
                              ...rootProviderTurn,
                              status: "interrupted",
                              completedAt,
                            },
                          },
                    ).pipe(
                      Effect.as(true),
                      Effect.catchCauseIf(
                        (settleCause) => !Cause.hasInterruptsOnly(settleCause),
                        (settleCause) =>
                          Effect.logWarning(
                            "orchestration V2 failed to settle a run after its workspace handoff",
                            { runId: input.run.id, cause: settleCause },
                          ).pipe(Effect.as(false)),
                      ),
                    );
                    if (handedOff) {
                      // Its tool calls, the handoff's own among them, died with that process.
                      yield* endWorkLostAfterRootRun(completedAt);
                      return;
                    }
                  }
                  yield* Effect.logWarning("orchestration V2 provider event ingestion failed", {
                    runId: input.run.id,
                    cause,
                  });
                  // An adapter fails its stream when its runtime is gone. A failed write, or a session T3
                  // released or saw end, leaves work that can still report or that the releaser settles.
                  const runtimeLost =
                    isRunExecutionIngestError(squashed) &&
                    isProviderEventStreamError(squashed.cause) &&
                    squashed.cause.raisedByT3 !== true;
                  if (yield* Ref.get(rootRunFinalized)) {
                    if (runtimeLost) yield* endWorkLostAfterRootRun(completedAt);
                    return;
                  }
                  const guardAbort = yield* Ref.get(guardAbortRef);
                  const providerThread = yield* Ref.get(latestProviderThread);
                  // Stop background work too; the failed consumer cannot persist terminal events.
                  const abandonedProviderTurn =
                    routing.rootProviderTurnId !== null && !routing.rootTurnEnded
                      ? yield* input.session
                          .interruptTurn({
                            providerThread,
                            providerTurnId: routing.rootProviderTurnId,
                            requestRuntimeRestart: true,
                          })
                          .pipe(
                            Effect.as(true),
                            // An adapter whose session scope is closing exits interrupted. That is
                            // its fiber, not this one: Effect never hands a fiber its own interrupt.
                            Effect.catchCause((interruptCause) =>
                              Effect.logWarning(
                                "orchestration V2 failed to interrupt turn after ingestion failure",
                                { runId: input.run.id, cause: interruptCause },
                              ).pipe(Effect.as(false)),
                            ),
                            // A failed interrupt leaves the stored turn running so the next start
                            // retries it. The snapshot is cached before it is published, so it may
                            // not be stored: replay a terminal one as-is.
                            Effect.map((interrupted) =>
                              !interrupted || rootProviderTurn === null
                                ? null
                                : isTerminalProviderTurnStatus(rootProviderTurn.status)
                                  ? rootProviderTurn
                                  : {
                                      ...rootProviderTurn,
                                      status: "interrupted" as const,
                                      completedAt,
                                    },
                            ),
                          )
                      : null;
                  const latestItemOrdinal = yield* Ref.get(latestTurnItemOrdinal);
                  const openSubagents = yield* Ref.get(openRunOwnedSubagents);
                  const openToolItems = yield* Ref.get(openToolTurnItems);
                  const droppedPrompt =
                    (yield* Ref.get(terminalEvent))?.promptDropped === true ||
                    rootProviderTurn?.promptDropped === true;
                  const recoveredHandoffs =
                    droppedPrompt && input.loadDroppedInlineHandoffs !== undefined
                      ? yield* input.loadDroppedInlineHandoffs()
                      : undefined;
                  const lostToolCalls = runtimeLost
                    ? yield* loadLostRootToolCalls.pipe(
                        Effect.catchCauseIf(
                          (loadCause) => !Cause.hasInterruptsOnly(loadCause),
                          (loadCause) =>
                            Effect.logWarning(
                              "orchestration V2 failed to read tool calls lost with the provider runtime",
                              { runId: input.run.id, cause: loadCause },
                            ).pipe(Effect.as([])),
                        ),
                      )
                    : [];
                  let nextRetryWarningAt = completedAt;
                  const recoveryTerminal: ProviderTerminalEvent =
                    guardAbort !== null
                      ? {
                          type: "turn.terminal",
                          driver: input.providerThread.driver,
                          providerThreadId: input.providerThread.id,
                          providerTurnId:
                            routing.rootProviderTurnId ??
                            input.attempt.providerTurnId ??
                            idAllocator.derive.providerTurn({
                              driver: input.providerThread.driver,
                              nativeTurnId: `interrupted:${input.attempt.id}`,
                            }),
                          runOrdinal: input.run.ordinal,
                          status: "interrupted",
                          failure: null,
                          reason: guardAbort.reason,
                          threadDisposition: "reusable",
                        }
                      : {
                          ...makeFailedTerminalEvent(
                            makeProviderFailure({
                              cause: squashed,
                              message:
                                knownProviderFailureMessage(squashed) ??
                                userFacingDatabaseErrorMessage(squashed),
                              class: "unknown",
                            }),
                            latestItemOrdinal + 1,
                          ),
                          ...(droppedPrompt ? { promptDropped: true as const } : {}),
                        };
                  yield* writeFinalRunEvents({
                    run: input.run,
                    rootNode: input.rootNode,
                    checkpointScope: input.checkpointScope,
                    providerThread,
                    attempt: input.attempt,
                    writeIfRunCurrent: {
                      activeAttemptId: input.attempt.id,
                      expectedStatus: "running",
                    },
                    openRunOwnedSubagents: openSubagents,
                    ...(abandonedProviderTurn === null ? {} : { abandonedProviderTurn }),
                    ...(abandonedProviderTurn !== null ||
                    (guardAbort !== null && openToolItems.size > 0)
                      ? { abandonedTurnItems: [...openToolItems.values()] }
                      : {}),
                    ...(recoveredHandoffs === undefined
                      ? {}
                      : { restoredHandoffs: recoveredHandoffs }),
                    lostToolCalls,
                    completedAt,
                    terminal: recoveryTerminal,
                    failureItemPersisted: false,
                    refreshAfterTurn,
                  }).pipe(
                    // Storage failures can be defects; retry both failure channels.
                    Effect.catchCause((writeCause) =>
                      Effect.gen(function* () {
                        if (Cause.hasInterruptsOnly(writeCause)) {
                          return yield* Effect.failCause(writeCause);
                        }
                        const now = yield* DateTime.now;
                        if (DateTime.isGreaterThanOrEqualTo(now, nextRetryWarningAt)) {
                          yield* Effect.logWarning(
                            "orchestration V2 run failure finalization retry",
                            {
                              runId: input.run.id,
                              attemptId: input.attempt.id,
                              cause: writeCause,
                            },
                          );
                          // Persistent storage failures must not flood the same disk.
                          nextRetryWarningAt = DateTime.add(now, { minutes: 10 });
                        }
                        return yield* Effect.fail(writeCause);
                      }),
                    ),
                    Effect.retry({
                      schedule: Schedule.exponential("1 second").pipe(
                        Schedule.modifyDelay(({ duration }) =>
                          Effect.succeed(Duration.min(duration, Duration.seconds(30))),
                        ),
                      ),
                    }),
                    // Startup may cancel the consumer and fail its own terminal
                    // write. Only service shutdown or the atomic gate ends recovery.
                    Effect.forkIn(scope),
                    Effect.flatMap(Fiber.join),
                  );
                }),
            ),
            Effect.ensuring(endPreviewActivity),
            Effect.ensuring(eventSubscription.close),
            Effect.ensuring(settleRootTerminal),
            // A fiber interrupted before its first step skips these finalizers, and a start can
            // fail before the scheduler runs it.
            Effect.forkDetach({ startImmediately: true }),
          );

        // A provider turn is a sign that the session is still alive. Keep
        // its already-issued MCP credential valid even when the agent goes
        // a long time between browser-tool calls.
        const touchMcpCredential = McpSessionRegistry.touchActiveMcpThread(input.run.threadId).pipe(
          Effect.ignoreCause({
            log: true,
            message: "Failed to refresh MCP credential liveness.",
          }),
        );
        // A resume sends no prompt, so its message is never a command.
        const compact =
          input.resume !== true &&
          adopted === undefined &&
          input.message.attachments.length === 0 &&
          input.message.text.trim().toLowerCase() === "/compact";
        const adoptTurn = input.session.adoptTurn;
        const callProvider =
          adopted === undefined
            ? compact
              ? input.session.compactThread
              : input.session.startTurn
            : adoptTurn === undefined
              ? undefined
              : (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
                  adoptTurn({
                    turnInput,
                    providerTurn: adopted.providerTurn,
                    turnItems: adopted.turnItems,
                    runtimeRequests: adopted.runtimeRequests,
                  });
        // Ingestion can settle the run while the context read or the preparation awaits, so ownership
        // is checked after each. A failed ownership read fails the start below like a failed preparation.
        const stillOwned = Effect.exit(
          Effect.suspend(() => input.shouldStartProviderTurn?.() ?? Effect.succeed(true)),
        );
        type PreparedCall = RunExecutionServiceV2PreparedTurn & {
          readonly callProvider: NonNullable<typeof callProvider>;
        };
        // The failure is only logged and classified below, so its error type is not kept.
        const starting = (turn: Exit.Exit<PreparedCall, unknown>, ownershipFailed: boolean) => ({
          turn,
          ownershipFailed,
        });
        // A Stop before the provider turn starts leaves the consumer nothing to wait for. One during
        // the start does not: the provider may already hold the prompt, and its events settle the run.
        const start = yield* Effect.gen(function* () {
          yield* touchMcpCredential;
          const appContext = yield* McpAppModelContext.forProvider(
            mcpAppModelContext,
            input.run.threadId,
          );
          const turnInput = {
            appThread: input.appThread,
            threadId: input.run.threadId,
            runId: input.run.id,
            runOrdinal: input.run.ordinal,
            providerTurnOrdinal: input.providerTurnOrdinal,
            ...(input.nativeThreadHasTurns === undefined
              ? {}
              : { nativeThreadHasTurns: input.nativeThreadHasTurns }),
            ...(input.run.restartContinuationOfRunId === undefined
              ? {}
              : {
                  restartContinuationOfRunId: input.run.restartContinuationOfRunId,
                }),
            ...(input.resume === true ? { resume: true as const } : {}),
            attemptId: input.attemptId,
            rootNodeId: input.rootNode.id,
            providerThread: input.providerThread,
            message: input.message,
            modelSelection: input.modelSelection,
            runtimePolicy: input.runtimePolicy,
            ...(appContext.length === 0 ? {} : { appContext }),
          };
          const ownedBeforePrepare = yield* stillOwned;
          if (Exit.isFailure(ownedBeforePrepare)) {
            return starting(Exit.failCause(ownedBeforePrepare.cause), true);
          }
          if (!ownedBeforePrepare.value) return undefined;
          const prepared = yield* Effect.exit(
            callProvider === undefined
              ? Effect.fail(
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: input.session.driver,
                    threadId: input.run.threadId,
                    providerThreadId: input.providerThread.id,
                    runId: input.run.id,
                    cause:
                      adopted === undefined
                        ? new ProviderAdapter.ProviderCompactionUnsupportedError({
                            driver: input.session.driver,
                            providerThreadId: input.providerThread.id,
                          })
                        : "This provider cannot take over a running turn.",
                  }),
                )
              : (
                  (adopted === undefined ? input.prepareTurn?.(turnInput, compact) : undefined) ??
                  Effect.succeed<RunExecutionServiceV2PreparedTurn>({
                    turnInput,
                    accepted: Effect.void,
                    notAccepted: () => Effect.void,
                  })
                ).pipe(Effect.map((turn) => ({ ...turn, callProvider }))),
          );
          if (Exit.isFailure(prepared)) return starting(prepared, false);
          const owned = yield* stillOwned;
          if (Exit.isSuccess(owned) && owned.value) return starting(prepared, false);
          yield* prepared.value.notAccepted(undefined);
          return Exit.isFailure(owned) ? starting(Exit.failCause(owned.cause), true) : undefined;
        }).pipe(Effect.onInterrupt(() => Fiber.interrupt(providerEventFiber)));
        // A takeover that fails leaves the run to recovery, which ends the taken-over process and
        // continues the run; failing the run here would end it instead.
        const failTakeover = (cause: unknown) =>
          Fiber.interrupt(providerEventFiber).pipe(
            Effect.andThen(
              Effect.fail(
                new RunExecutionStartError({
                  commandId: input.commandId,
                  runId: input.run.id,
                  cause,
                }),
              ),
            ),
          );
        if (start === undefined) {
          if (adopted !== undefined) {
            return yield* failTakeover("The run is no longer this server's to take over.");
          }
          yield* Fiber.interrupt(providerEventFiber);
          return;
        }

        // Preparation drops the resume when it adds context, which needs a prompt to carry it.
        const callTurn = (turn: PreparedCall) => {
          if (turn.turnInput.resume !== true) return turn.callProvider(turn.turnInput);
          const { message, resume: _resume, ...resumeInput } = turn.turnInput;
          return (
            input.session.resumeTurn?.({ ...resumeInput, messageId: message.messageId }) ??
            Effect.fail(
              new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: input.session.driver,
                threadId: input.run.threadId,
                providerThreadId: input.providerThread.id,
                runId: input.run.id,
                cause: new ProviderAdapter.ProviderResumeUnsupportedError({
                  driver: input.session.driver,
                  providerThreadId: input.providerThread.id,
                }),
              }),
            )
          );
        };
        yield* Effect.flatMap(start.turn, (turn) =>
          callTurn(turn).pipe(Effect.tapError(turn.notAccepted), Effect.andThen(turn.accepted)),
        ).pipe(
          // Wait for acceptance so abandoned startup cannot leave a refresher
          // on the already-detached ingestion fiber.
          Effect.tap(() =>
            Fiber.await(providerEventFiber).pipe(
              Effect.raceFirst(touchMcpCredential.pipe(Effect.delay("1 hour"), Effect.forever)),
              Effect.forkDetach,
            ),
          ),
          Effect.catchCause((cause) =>
            adopted !== undefined
              ? failTakeover(Cause.squash(cause))
              : Effect.logError("orchestration V2 provider turn start failed", {
                  runId: input.run.id,
                  providerInstanceId: input.run.providerInstanceId,
                  cause: providerFailureDiagnostic(cause),
                }).pipe(
                  Effect.andThen(Fiber.interrupt(providerEventFiber)),
                  Effect.andThen(
                    start.ownershipFailed
                      ? Effect.succeed(
                          makeProviderFailure({ cause: Cause.squash(cause), class: "unknown" }),
                        )
                      : input.startFailure(Cause.squash(cause)),
                  ),
                  Effect.flatMap((failure) =>
                    Effect.all([
                      Ref.get(latestProviderThread),
                      Ref.get(latestTurnItemOrdinal),
                      Ref.get(openRunOwnedSubagents),
                    ]).pipe(
                      Effect.flatMap(([providerThread, latestItemOrdinal, openSubagents]) =>
                        writeFinalRunEvents({
                          run: input.run,
                          rootNode: input.rootNode,
                          checkpointScope: input.checkpointScope,
                          providerThread,
                          attempt: input.attempt,
                          writeIfRunCurrent: {
                            activeAttemptId: input.attempt.id,
                            expectedStatus: "running",
                          },
                          openRunOwnedSubagents: openSubagents,
                          terminal: makeFailedTerminalEvent(failure, latestItemOrdinal + 1),
                          failureItemPersisted: false,
                          refreshAfterTurn,
                        }),
                      ),
                    ),
                  ),
                  Effect.mapError(
                    (writeCause) =>
                      new RunExecutionStartError({
                        commandId: input.commandId,
                        runId: input.run.id,
                        cause: { start: cause, write: writeCause },
                      }),
                  ),
                ),
          ),
        );
      }),
      awaitRootTerminalIngested: (attemptId) =>
        Effect.suspend(() => {
          const pending = pendingRootTerminals.get(attemptId);
          return pending === undefined ? Effect.void : Deferred.await(pending);
        }),
    } satisfies RunExecutionServiceV2Shape);
  }),
);

/**
 * Clients send Stop without a reason; server callers acting for an agent
 * always set one, so a missing reason means a person stopped the run.
 */
export const USER_STOP_REASON = "Stopped by user";

function makeInterruptRequestTurnItem(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId | null;
  readonly ordinal: number;
  readonly reason: string;
  readonly occurredAt: DateTime.Utc;
}): OrchestrationV2TurnItem {
  return {
    id: input.idAllocator.derive.runSignalTurnItem({
      runId: input.run.id,
      signal: "interrupt-request",
    }),
    threadId: input.run.threadId,
    runId: input.run.id,
    nodeId: input.rootNode.id,
    providerThreadId: input.providerThread.id,
    providerTurnId: input.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed",
    title: "Interrupt requested",
    startedAt: input.occurredAt,
    completedAt: input.occurredAt,
    updatedAt: input.occurredAt,
    type: "run_interrupt_request",
    message: input.reason,
  };
}
