import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type RunId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as MemoryAdmission from "../resourceTelemetry/MemoryAdmission.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

type QueueCommand = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "run.memory-admit" | "run.memory-wait" }
>;

// Every run the queue holds carries its admission record on each of its own updates, so the one
// that ends its start (running, waiting, failed, cancelled or cut by a restart) sweeps it too.
const affectsQueue = (event: OrchestrationV2DomainEvent) =>
  (event.type === "run.created" || event.type === "run.updated") &&
  event.payload.memoryAdmission !== undefined;

/**
 * Starts the automatic starts the orchestrator held back (restart, network and usage-limit
 * continuations): none while memory is short, then one at a time, each once the one before it
 * has started its provider session, the run that stopped first first.
 */
export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const memory = yield* MemoryAdmission.MemoryAdmission;
  const due = DueHint.make();
  const permit = yield* Semaphore.make(1);
  // Runs this server already told they wait for memory; a run that stops waiting is told again.
  const told = new Set<RunId>();
  const currentShortage = MemoryAdmission.holdShortage(memory.shortage);
  /** Whether the command committed; a failure is logged and the next sweep tries again. */
  const dispatch = (command: QueueCommand) =>
    orchestrator.dispatch(command).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration-v2.memory-admission.dispatch-failed", {
          threadId: command.threadId,
          runId: command.runId,
          commandType: command.type,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );
  const sweepDue = Effect.fn("MemoryAdmissionQueue.sweep")(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const { waiting, admittedStarting } = yield* projections
      .getMemoryAdmissionQueue()
      .pipe(NodeSqliteClient.inBackground);
    const waitingIds = new Set(waiting.map((run) => run.id));
    for (const runId of told) if (!waitingIds.has(runId)) told.delete(runId);
    const [next] = waiting;
    // A start holds the queue until an update of its own ends it. Setup scripts and resumes can
    // outlast any fixed limit; the provider's start limits, Stop or a restart end one that hangs.
    if (next === undefined || admittedStarting) {
      yield* due.record(readVersion, Infinity, nowMs);
      return;
    }
    const shortage = yield* currentShortage(nowMs);
    if (shortage === null) {
      yield* dispatch({
        type: "run.memory-admit",
        commandId: CommandId.make(`command:memory-admit:${next.id}:${nowMs}`),
        threadId: next.threadId,
        runId: next.id,
      });
      return;
    }
    for (const run of waiting) {
      if (told.has(run.id)) continue;
      const committed = yield* dispatch({
        type: "run.memory-wait",
        commandId: CommandId.make(`command:memory-wait:${run.id}:${nowMs}`),
        threadId: run.threadId,
        runId: run.id,
        shortage: MemoryAdmission.describeMemoryShortage(shortage.shortage),
      });
      if (committed) told.add(run.id);
    }
    yield* due.record(readVersion, shortage.readAtMs + MemoryAdmission.SHORTAGE_RECHECK_MS, nowMs);
  });
  // A change during an older read must get its own sweep, even before the next scheduler tick.
  const sweep = permit.withPermit(sweepDue());
  return {
    /** Sweeps when the last sweep left something to recheck by now. */
    sweep,
    /** Sweeps at once, for a change to the queue: a run began to wait, was admitted or started. */
    queueChanged: due.invalidate.pipe(Effect.andThen(sweep)),
  };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const queue = yield* make;
    const scheduler = yield* Scheduler.Scheduler;
    const sink = yield* EventSink.EventSinkV2;
    // The first sweep can finish before the subscription opens. Replay changes from before that read.
    const afterSequence = yield* sink.latestSequence().pipe(Effect.orDie);
    yield* scheduler.register("memory-admission", queue.sweep);
    // A sweep reads the whole queue. One pending wake covers every change since its last read.
    const wakes = yield* Queue.dropping<void>(1);
    const sweepOnWake = queue.queueChanged.pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("orchestration-v2.memory-admission.sweep-failed", { cause }),
      ),
    );
    yield* forkParked(Queue.take(wakes).pipe(Effect.andThen(sweepOnWake), Effect.forever));
    yield* forkParked(
      sink
        .stream({ afterSequence })
        .pipe(
          Stream.runForEachArray((events) =>
            events.some(({ event }) => affectsQueue(event))
              ? Queue.offer(wakes, undefined)
              : Effect.void,
          ),
        ),
    );
  }),
);
