import { CommandId, MessageId } from "@t3tools/contracts/baseSchemas";
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Run,
  OrchestrationV2Subagent,
} from "@t3tools/contracts/orchestrationV2";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { reportLabel } from "@t3tools/provider-core/server/notification";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class DelegatedTaskQuestionReactor extends Context.Service<
  DelegatedTaskQuestionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/DelegatedTaskQuestionReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const wakeParent = Effect.fnUntraced(function* (
    task: OrchestrationV2Subagent,
    request: OrchestrationV2RuntimeRequest,
    source: OrchestrationV2Run | undefined,
  ) {
    if (task.childThreadId === null) return;
    const key = `${task.threadId}:${request.id}`;
    const messageId = MessageId.make(`message:delegated-task-question:${key}`);
    const label = reportLabel(task.title?.trim() || task.prompt);
    const situation =
      request.responseCapability.type === "message"
        ? `Delegated task ${task.id} asked a question and is still working.`
        : `Delegated task ${task.id} is blocked on a question and cannot continue until it is answered.`;
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:delegated-task-question:${key}`),
      threadId: task.threadId,
      demandId: source?.demandId ?? null,
      messageId,
      text: `${situation} Read it with t3_pending_request action read, threadId ${task.childThreadId}, and requestId ${request.id}. Answer it with action respond when the answer follows from the task or the user's instructions; otherwise ask the user, then answer it. If it is no longer pending, it was answered or dismissed.`,
      notification: {
        wakeEventIds: [messageId],
        source: { kind: "delegated_task", taskIds: [task.id], childThreadId: task.childThreadId },
        outcome: "updated",
        summary: `Delegated task${label === undefined ? "" : ` "${label}"`} has a question`,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  // Runs for every domain event; most events return before any work is needed.
  const handle: DelegatedTaskQuestionReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type === "run.updated") {
        if (!["completed", "failed", "waiting"].includes(event.payload.status)) return;
        const parent = yield* projections.getThreadRecords(event.threadId, ["subagents"]);
        if (parent.thread.archivedAt !== null || parent.thread.deletedAt !== null) return;
        for (const task of parent.subagents) {
          if (
            task.origin !== "app_owned" ||
            task.runId !== event.payload.id ||
            task.completionWake !== "settled_only" ||
            task.completionDelivery?.state === "disposed" ||
            task.childThreadId === null ||
            ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
          ) {
            continue;
          }
          const child = yield* projections.getThreadRecords(task.childThreadId, [
            "runtimeRequests",
          ]);
          const pending = child.runtimeRequests.filter(
            (request) =>
              request.kind === "user_input" &&
              request.status === "pending" &&
              request.responseCapability.type === "live",
          );
          if (pending.length === 0) continue;
          const { nodes } = yield* projections.getThreadRecords(task.childThreadId, ["nodes"], {
            nodeIds: pending.map((request) => request.nodeId),
          });
          const { runs } = yield* projections.getThreadRecords(task.childThreadId, ["runs"], {
            runIds: nodes.flatMap((node) => (node.runId === null ? [] : [node.runId])),
          });
          const byRun = new Map(runs.map((run) => [run.id, run]));
          const byNode = new Map(
            nodes.map((node) => [node.id, node.runId === null ? undefined : byRun.get(node.runId)]),
          );
          for (const request of pending) {
            const source = byNode.get(request.nodeId);
            if (source?.delegatedTaskId !== undefined && source.delegatedTaskId !== task.id)
              continue;
            yield* wakeParent(task, request, source).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("catching up a delegated task question failed", {
                  taskId: task.id,
                  requestId: request.id,
                  cause,
                }),
              ),
            );
          }
        }
        return;
      }
      if (event.type !== "runtime-request.updated" || event.payload.kind !== "user_input") {
        return;
      }
      const child = yield* projections.getThread(event.threadId);
      const parentThreadId = child.lineage.parentThreadId;
      if (parentThreadId === null) return;
      const request = yield* projections.getRuntimeRequest(event.threadId, event.payload.id);
      const key = `${parentThreadId}:${event.payload.id}`;
      const messageId = MessageId.make(`message:delegated-task-question:${key}`);
      if (event.payload.status !== "pending" || request?.status !== "pending") {
        const parent = yield* projections.getThreadRecords(parentThreadId, ["runs"]);
        const queued = parent.runs.find(
          (run) => run.status === "queued" && run.userMessageId === messageId,
        );
        if (queued !== undefined) {
          yield* engine.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`server:delegated-task-question-cancel:${key}`),
            threadId: parentThreadId,
            runId: queued.id,
          });
        }
        return;
      }
      const parent = yield* projections.getThreadRecords(parentThreadId, ["subagents", "runs"]);
      const sourceRunId =
        event.runId ??
        (yield* projections.getThreadRecords(child.id, ["nodes"], { nodeIds: [request.nodeId] }))
          .nodes[0]?.runId;
      const run =
        sourceRunId == null
          ? undefined
          : (yield* projections.getThreadRecords(child.id, ["runs"], { runIds: [sourceRunId] }))
              .runs[0];
      const taskId =
        run?.delegatedTaskId ??
        (child.forkedFrom?.type === "node" ? child.forkedFrom.nodeId : undefined);
      const task = parent.subagents.find(
        (candidate) => candidate.origin === "app_owned" && candidate.id === taskId,
      );
      if (
        task === undefined ||
        parent.thread.archivedAt !== null ||
        parent.thread.deletedAt !== null
      ) {
        return;
      }
      // A blocking delegate_task wait delivers the question itself.
      if (
        task.completionWake === "settled_only" &&
        event.payload.responseCapability.type === "live" &&
        parent.runs.some(
          (run) =>
            run.id === task.runId &&
            (run.status === "preparing" || run.status === "starting" || run.status === "running"),
        )
      ) {
        return;
      }
      yield* wakeParent(task, request, run);
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("waking the parent of a delegated task question failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: DelegatedTaskQuestionReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated task question event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies DelegatedTaskQuestionReactor["Service"];
});

export const layer = Layer.effect(DelegatedTaskQuestionReactor, make);
