import { CheckpointScopeId, CommandId, RunId, ThreadId } from "@t3tools/contracts/baseSchemas";
import {
  isOrchestrationV2TerminalRunStatus,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts/orchestrationV2";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

export class CheckpointCaptureExecutionError extends Schema.TaggedError<CheckpointCaptureExecutionError>()(
  "CheckpointCaptureExecutionError",
  {
    threadId: ThreadId,
    runId: RunId,
    scopeId: CheckpointScopeId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isCheckpointCaptureExecutionError = Schema.is(CheckpointCaptureExecutionError);

export interface CheckpointCaptureServiceV2Shape {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly scopeId: CheckpointScopeId;
    /** False on the last attempt: a failure then completes the waiting run without a checkpoint. */
    readonly willRetry: boolean;
  }) => Effect.Effect<void, CheckpointCaptureExecutionError>;
}

export class CheckpointCaptureServiceV2 extends Context.Service<
  CheckpointCaptureServiceV2,
  CheckpointCaptureServiceV2Shape
>()("t3/orchestration-v2/CheckpointCaptureService/CheckpointCaptureServiceV2") {}

export const layer: Layer.Layer<
  CheckpointCaptureServiceV2,
  never,
  | CheckpointService.CheckpointServiceV2
  | EventSink.EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProjectionStore.ProjectionStoreV2
  | ThreadCommandExecutor.ThreadCommandExecutor
> = Layer.effect(
  CheckpointCaptureServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadDispatch = yield* ThreadCommandExecutor.ThreadCommandExecutor;

    const execute = Effect.fn("orchestrationV2.checkpointCapture.execute")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly scopeId: CheckpointScopeId;
    }) {
      const { run, rootNode, scope, providerThread, readyCheckpointOrdinals, sideChat } =
        yield* projections.getCheckpointCaptureContext(input.threadId, input);
      // Stopped runs remain terminal; their checkpoint is the next message's rollback point.
      const stopped = run?.status === "interrupted" || run?.status === "cancelled";

      // A checkpoint on a settled run proves this at-least-once effect already committed.
      if (
        run !== undefined &&
        run.checkpointId !== null &&
        (run.status === "completed" || stopped)
      ) {
        return;
      }
      // Rollback uses the same lane and can precede a capture retry; preserve the restored workspace and discarded run.
      if (run?.status === "rolled_back") {
        return;
      }

      if (
        run === undefined ||
        (run.status !== "waiting" && !stopped) ||
        rootNode === undefined ||
        scope === undefined ||
        rootNode.checkpointScopeId !== scope.id ||
        providerThread === undefined
      ) {
        return yield* new CheckpointCaptureExecutionError({
          threadId: input.threadId,
          runId: input.runId,
          scopeId: input.scopeId,
          cause: "The persisted checkpoint capture target is incomplete or no longer waiting.",
        });
      }

      const capturedAt = yield* DateTime.now;
      const baselineOrdinalWithinScope = Math.max(0, run.ordinal - 1);
      const hasReadyCheckpoint = (ordinalWithinScope: number) =>
        readyCheckpointOrdinals.includes(ordinalWithinScope);
      const threadStartCheckpoint =
        baselineOrdinalWithinScope === 0 || hasReadyCheckpoint(0)
          ? null
          : yield* checkpoints.materializeBaselineCheckpoint({
              scope,
              ordinalWithinScope: 0,
              forceMissing: sideChat,
            });
      const baselineCheckpoint = hasReadyCheckpoint(baselineOrdinalWithinScope)
        ? null
        : yield* checkpoints.materializeBaselineCheckpoint({
            scope,
            ordinalWithinScope: baselineOrdinalWithinScope,
            forceMissing: sideChat,
          });
      const checkpoint = yield* checkpoints.capture({
        scope,
        runId: run.id,
        nodeId: rootNode.id,
        ordinalWithinScope: run.ordinal,
        appRunOrdinal: run.ordinal,
        capturedAt,
        forceMissing: sideChat,
      });
      // Commands plan from a run they read under this lock, so commit from a fresh read under it:
      // a command that settled the run meanwhile keeps its status, and the run gets the checkpoint.
      yield* threadDispatch.withLock(
        input.threadId,
        Effect.gen(function* () {
          const latest = (yield* projections.getCheckpointCaptureContext(input.threadId, input))
            .run;
          if (
            latest === undefined ||
            latest.status === "rolled_back" ||
            latest.checkpointId !== null
          ) {
            return;
          }
          const settled = isOrchestrationV2TerminalRunStatus(latest.status);
          const commandId = CommandId.make(`command:effect:checkpoint.capture:${run.id}`);
          yield* eventSink.commitCommand({
            commandId,
            threadId: input.threadId,
            commandType: "checkpoint.capture",
            acceptedAt: capturedAt,
            effects: [],
            events: [
              ...(threadStartCheckpoint === null
                ? []
                : [
                    {
                      id: yield* ids.allocate.event(),
                      type: "checkpoint.captured" as const,
                      threadId: input.threadId,
                      nodeId: threadStartCheckpoint.nodeId,
                      driver: providerThread.driver,
                      providerInstanceId: run.providerInstanceId,
                      occurredAt: capturedAt,
                      payload: threadStartCheckpoint,
                    },
                  ]),
              ...(baselineCheckpoint === null
                ? []
                : [
                    {
                      id: yield* ids.allocate.event(),
                      type: "checkpoint.captured" as const,
                      threadId: input.threadId,
                      nodeId: baselineCheckpoint.nodeId,
                      driver: providerThread.driver,
                      providerInstanceId: run.providerInstanceId,
                      occurredAt: capturedAt,
                      payload: baselineCheckpoint,
                    },
                  ]),
              {
                id: yield* ids.allocate.event(),
                type: "checkpoint.captured",
                threadId: input.threadId,
                runId: run.id,
                nodeId: rootNode.id,
                driver: providerThread.driver,
                providerInstanceId: run.providerInstanceId,
                occurredAt: capturedAt,
                payload: checkpoint,
              },
              {
                id: yield* ids.allocate.event(),
                type: "turn-item.updated",
                threadId: input.threadId,
                runId: run.id,
                nodeId: rootNode.id,
                driver: providerThread.driver,
                providerInstanceId: run.providerInstanceId,
                occurredAt: capturedAt,
                payload: makeCheckpointTurnItem({
                  idAllocator: ids,
                  run,
                  rootNode,
                  providerThread,
                  checkpoint,
                  completedAt: capturedAt,
                }),
              },
              {
                id: yield* ids.allocate.event(),
                type: "run.updated",
                threadId: input.threadId,
                runId: run.id,
                nodeId: rootNode.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: capturedAt,
                payload: settled
                  ? { ...latest, checkpointId: checkpoint.id }
                  : {
                      ...latest,
                      status: "completed",
                      completedAt: capturedAt,
                      checkpointId: checkpoint.id,
                    },
              },
              ...(settled
                ? []
                : [
                    {
                      id: yield* ids.allocate.event(),
                      type: "node.updated" as const,
                      threadId: input.threadId,
                      runId: run.id,
                      nodeId: rootNode.id,
                      providerInstanceId: run.providerInstanceId,
                      occurredAt: capturedAt,
                      payload: {
                        ...rootNode,
                        status: "completed" as const,
                        completedAt: capturedAt,
                        checkpointScopeId: scope.id,
                      },
                    },
                  ]),
            ],
          });
        }),
      );
    });

    // A waiting run counts as active, so it would hold the thread and its queue until a restart.
    const completeWithoutCheckpoint = Effect.fn(
      "orchestrationV2.checkpointCapture.completeWithoutCheckpoint",
    )(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly scopeId: CheckpointScopeId;
    }) {
      yield* threadDispatch.withLock(input.threadId, completeWaitingRun(input));
    });

    const completeWaitingRun = Effect.fn("orchestrationV2.checkpointCapture.completeWaitingRun")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly runId: RunId;
        readonly scopeId: CheckpointScopeId;
      }) {
        const { run, rootNode } = yield* projections.getCheckpointCaptureContext(
          input.threadId,
          input,
        );
        if (run?.status !== "waiting") return;
        const completedAt = yield* DateTime.now;
        const commandId = CommandId.make(`command:effect:checkpoint.capture:${run.id}:uncaptured`);
        yield* eventSink.commitCommand({
          commandId,
          threadId: input.threadId,
          commandType: "checkpoint.capture",
          acceptedAt: completedAt,
          effects: [],
          events: [
            {
              id: yield* ids.allocate.event(),
              type: "run.updated",
              threadId: input.threadId,
              runId: run.id,
              ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
              providerInstanceId: run.providerInstanceId,
              occurredAt: completedAt,
              payload: { ...run, status: "completed", completedAt },
            },
            ...(rootNode === undefined
              ? []
              : [
                  {
                    id: yield* ids.allocate.event(),
                    type: "node.updated" as const,
                    threadId: input.threadId,
                    runId: run.id,
                    nodeId: rootNode.id,
                    providerInstanceId: run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: { ...rootNode, status: "completed" as const, completedAt },
                  },
                ]),
          ],
        });
      },
    );

    return CheckpointCaptureServiceV2.of({
      execute: Effect.fn("CheckpointCaptureServiceV2.execute")(function ({ willRetry, ...input }) {
        return execute(input).pipe(
          Effect.mapError((cause) =>
            isCheckpointCaptureExecutionError(cause)
              ? cause
              : new CheckpointCaptureExecutionError({ ...input, cause }),
          ),
          Effect.tapCause((cause) =>
            willRetry || Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError(
                  "Checkpoint capture failed for good; completing the run without one",
                  {
                    ...input,
                    cause,
                  },
                ).pipe(
                  Effect.andThen(completeWithoutCheckpoint(input)),
                  Effect.catchCause((settleCause) =>
                    Effect.logError("Failed to complete a run whose checkpoint capture failed", {
                      ...input,
                      cause: settleCause,
                    }),
                  ),
                ),
          ),
        );
      }),
    });
  }),
);

function makeCheckpointTurnItem(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly checkpoint: OrchestrationV2Checkpoint;
  readonly completedAt: DateTime.Utc;
}): OrchestrationV2TurnItem {
  return {
    id: input.idAllocator.derive.turnItemFromProviderItem({
      driver: input.providerThread.driver,
      nativeItemId: `checkpoint:${input.checkpoint.id}`,
    }),
    threadId: input.run.threadId,
    runId: input.run.id,
    nodeId: input.rootNode.id,
    providerThreadId: input.providerThread.id,
    providerTurnId: input.rootNode.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.run.ordinal * 100 + 99,
    status: "completed",
    title: null,
    startedAt: input.completedAt,
    completedAt: input.completedAt,
    updatedAt: input.completedAt,
    type: "checkpoint",
    checkpointId: input.checkpoint.id,
    scopeId: input.checkpoint.scopeId,
    files: input.checkpoint.files,
  };
}
