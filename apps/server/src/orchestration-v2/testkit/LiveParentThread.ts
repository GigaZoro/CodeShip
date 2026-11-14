import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  type ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";

/** A thread whose run is live, as when its agent calls delegate_task or t3_command_run. */
export const seedLiveParent = Effect.fn("LiveParentThread.seedLiveParent")(function* (input: {
  readonly name: string;
  readonly driver: ProviderDriverKind;
  readonly modelSelection: ModelSelection;
  readonly worktreePath?: string;
}) {
  const { name, driver, modelSelection } = input;
  const instanceId = modelSelection.instanceId;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${name}`);
  const runId = RunId.make(`run:${name}`);
  const rootNodeId = NodeId.make(`node:${name}:root`);
  const providerThreadId = ProviderThreadId.make(`provider-thread:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:create:${name}`),
    threadId,
    projectId: ProjectId.make(`project:${name}`),
    title: "Parent",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath ?? null,
  });
  yield* sink.write({
    commandId: CommandId.make(`command:seed:${name}`),
    events: [
      {
        id: EventId.make(`event:seed-provider-thread:${name}`),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId: instanceId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId: instanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: rootNodeId,
          nativeThreadRef: { driver, nativeId: `native:${name}`, strength: "strong" },
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        id: EventId.make(`event:seed-node:${name}`),
        type: "node.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId: instanceId,
        occurredAt: now,
        payload: {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "running",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      },
      {
        id: EventId.make(`event:seed-run:${name}`),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: instanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`message:seed-user:${name}`),
          rootNodeId,
          activeAttemptId: null,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
    ],
  });
  return { threadId, runId, rootNodeId };
});
