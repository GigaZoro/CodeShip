import type { CommandId, ThreadId, TurnItemId } from "@t3tools/contracts/baseSchemas";
import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Run,
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts/orchestrationV2";
import type {
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
} from "@t3tools/contracts/providerPolicy";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as Orchestrator from "../Orchestrator.ts";
import type { RecordedCommandOutput } from "./CommandOutputRecorder.ts";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";

export type OrchestratorV2ScenarioStep =
  | {
      readonly type: "dispatch";
      readonly command: OrchestrationV2Command;
      readonly await?: boolean;
      readonly key?: string;
    }
  | {
      readonly type: "advance_clock";
      readonly duration: Duration.Input;
    }
  | {
      readonly type: "await";
      readonly key: string;
    }
  | {
      readonly type: "await_all";
    }
  | {
      readonly type: "await_thread_idle";
      readonly threadId: ThreadId;
    }
  | {
      readonly type: "await_no_background_work";
      readonly threadId: ThreadId;
    }
  | {
      readonly type: "await_run_steerable";
      readonly threadId: ThreadId;
      readonly runId: OrchestrationV2Run["id"];
    }
  | {
      readonly type: "await_run_status";
      readonly threadId: ThreadId;
      readonly runId: OrchestrationV2Run["id"];
      readonly status: OrchestrationV2Run["status"];
    }
  | {
      readonly type: "finish_held_run";
      readonly threadId: ThreadId;
      readonly runId: OrchestrationV2Run["id"];
      readonly status: OrchestrationV2Run["status"];
    }
  | {
      readonly type: "await_run_turn_item";
      readonly threadId: ThreadId;
      readonly runId: OrchestrationV2Run["id"];
      readonly itemType: OrchestrationV2TurnItem["type"];
    }
  | {
      readonly type: "release_replay_gate_after_waiting";
      readonly label: string;
      readonly threadId: ThreadId;
      readonly runId: OrchestrationV2Run["id"];
    }
  | {
      readonly type: "release_replay_gate";
      readonly label: string;
    }
  | {
      readonly type: "capture_shell_snapshot";
      readonly key: string;
    }
  | {
      readonly type: "respond_to_next_runtime_request";
      readonly threadId: ThreadId;
      readonly commandId: CommandId;
      readonly decision?: ProviderApprovalDecision;
      readonly answers?: ProviderUserInputAnswers;
      readonly shellSnapshotKeyWhilePending?: string;
    };

export interface OrchestratorV2Scenario {
  readonly name: string;
  readonly commands: ReadonlyArray<OrchestrationV2Command>;
  readonly steps?: ReadonlyArray<OrchestratorV2ScenarioStep>;
  readonly projectionThreadIds?: ReadonlyArray<ThreadId>;
}

export interface OrchestratorV2ScenarioResult {
  readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
  readonly domainEvents: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly projections: ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection>;
  readonly shellSnapshot: OrchestrationV2ThreadShellSnapshot;
  readonly capturedShellSnapshots: ReadonlyMap<string, OrchestrationV2ThreadShellSnapshot>;
  /** Live output each command streamed (never persisted). Provider replays fill it in. */
  readonly commandOutput?: ReadonlyMap<TurnItemId, RecordedCommandOutput>;
}

export class OrchestratorV2ScenarioStepError extends Schema.TaggedError<OrchestratorV2ScenarioStepError>()(
  "OrchestratorV2ScenarioStepError",
  {
    scenario: Schema.String,
    step: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid orchestrator scenario step ${this.step} in ${this.scenario}.`;
  }
}

function commandThreadIds(command: OrchestrationV2Command): ReadonlyArray<ThreadId> {
  switch (command.type) {
    case "thread.create":
    case "thread.stop":
    case "thread.archive":
    case "thread.unarchive":
    case "thread.delete":
    case "thread.guest-share.close":
    case "thread.guest-message.dismiss":
    case "thread.settle":
    case "thread.auto-settle":
    case "thread.unsettle":
    case "thread.snooze":
    case "thread.unsnooze":
    case "thread.auto-settle.set":
    case "thread.later.set":
    case "thread.pin":
    case "thread.unpin":
    case "thread.pin.reorder":
    case "thread.active.reorder":
    case "thread.tag.set":
    case "thread.notification-level.set":
    case "thread.color.set":
    case "thread.folder.set":
    case "thread.artifact.hide":
    case "thread.message.star":
    case "thread.visit":
    case "thread.mark-unread":
    case "thread.metadata.update":
    case "thread.pull-request.link":
    case "thread.pull-request.unlink":
    case "thread.pull-request-link.sync":
    case "thread.pull-request.watch":
    case "thread.pull-request.sync":
    case "thread.title.regeneration.complete":
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
    case "thread.model-selection.set":
    case "provider-session.detach":
    case "message.dispatch":
    case "notification.delivery.accept":
    case "prepared-run.release":
    case "prepared-run.progress":
    case "prepared-run.fail":
    case "prepared-run.retry":
    case "subagent.stop":
    case "run.interrupt":
    case "queued-message.promote-to-steer":
    case "queued-run.start":
    case "queue.resume":
    case "queued-run.reorder":
    case "queued-run.cancel":
    case "queued-run.edit":
    case "runtime-request.respond":
    case "thread.user-input.dismiss":
    case "checkpoint.rollback":
    case "provider.switch":
      return [command.threadId];
    case "delegated_task.request":
    case "delegated_task.wake-policy":
    case "delegated_task.completion-delivery.acknowledge":
    case "delegated_task.completion-delivery.dispose":
    case "thread.created.record":
      return [command.parentThreadId];
    case "thread.fork":
    case "thread.merge_back":
      return [command.sourceThreadId, command.targetThreadId];
  }
}

function scenarioSteps(
  scenario: OrchestratorV2Scenario,
): ReadonlyArray<OrchestratorV2ScenarioStep> {
  return (
    scenario.steps ??
    scenario.commands.map((command) => ({
      type: "dispatch" as const,
      command,
      await: true,
    }))
  );
}

function scenarioCommands(scenario: OrchestratorV2Scenario): ReadonlyArray<OrchestrationV2Command> {
  return scenarioSteps(scenario).flatMap((step) =>
    step.type === "dispatch" ? [step.command] : [],
  );
}

const findPendingRuntimeRequest = (projection: OrchestrationV2ThreadProjection) =>
  projection.runtimeRequests.find((request) => request.status === "pending");

const hasActiveRun = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.some((run) =>
    ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
  );

const SCENARIO_WAIT_DEADLINE_MS = 60_000;

function collectProjectionThreadIds(scenario: OrchestratorV2Scenario): ReadonlyArray<ThreadId> {
  if (scenario.projectionThreadIds) {
    return scenario.projectionThreadIds;
  }

  const ids = new Set<ThreadId>();
  for (const command of scenarioCommands(scenario)) {
    for (const threadId of commandThreadIds(command)) {
      ids.add(threadId);
    }
  }
  return Array.from(ids);
}

export function runOrchestratorV2Scenario(
  scenario: OrchestratorV2Scenario,
  options: {
    readonly replayGate?: ProviderReplayGate;
    readonly afterSteps?: Effect.Effect<void>;
  } = {},
): Effect.Effect<
  OrchestratorV2ScenarioResult,
  Orchestrator.OrchestratorV2Error | OrchestratorV2ScenarioStepError,
  Orchestrator.OrchestratorV2
> {
  return Effect.scoped(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const storedEventGroups: Array<ReadonlyArray<OrchestrationV2StoredEvent>> = [];
      const observedStoredEvents = yield* Ref.make<Array<OrchestrationV2StoredEvent>>([]);
      // Projections commit atomically with stored events, so waiting on streamStoredEvents wakes
      // scenario assertions only on relevant state transitions without busy-polling SQLite.
      const eventTypeVersions = new Map<string, number>();
      const storedEventWaiters = new Set<{
        readonly eventTypes: ReadonlySet<OrchestrationV2DomainEvent["type"]>;
        readonly wake: () => void;
      }>();
      const versionFor = (eventTypes: ReadonlySet<OrchestrationV2DomainEvent["type"]>) => {
        let sum = 0;
        for (const eventType of eventTypes) {
          sum += eventTypeVersions.get(eventType) ?? 0;
        }
        return sum;
      };
      const pendingWakes = new Set<() => void>();
      let wakeTimer: ReturnType<typeof setImmediate> | undefined;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (wakeTimer !== undefined) {
            clearImmediate(wakeTimer);
            wakeTimer = undefined;
          }
          pendingWakes.clear();
          storedEventWaiters.clear();
        }),
      );
      const flushPendingWakes = () => {
        wakeTimer = undefined;
        const ready = Array.from(pendingWakes);
        pendingWakes.clear();
        for (const wake of ready) wake();
      };
      const notifyStoredEvent = (eventType: OrchestrationV2DomainEvent["type"]) => {
        eventTypeVersions.set(eventType, (eventTypeVersions.get(eventType) ?? 0) + 1);
        for (const waiter of storedEventWaiters) {
          if (waiter.eventTypes.has(eventType)) {
            storedEventWaiters.delete(waiter);
            pendingWakes.add(waiter.wake);
          }
        }
        if (pendingWakes.size > 0 && wakeTimer === undefined) {
          wakeTimer = setImmediate(flushPendingWakes);
        }
      };
      const waitForNextStoredEvent = (
        eventTypes: ReadonlySet<OrchestrationV2DomainEvent["type"]>,
        seenVersion: number,
      ) =>
        Effect.callback<void>((resume) => {
          if (versionFor(eventTypes) > seenVersion) {
            resume(Effect.void);
            return;
          }
          const entry = {
            eventTypes,
            wake: () => {
              storedEventWaiters.delete(entry);
              resume(Effect.void);
            },
          };
          storedEventWaiters.add(entry);
          return Effect.sync(() => {
            storedEventWaiters.delete(entry);
            pendingWakes.delete(entry.wake);
          });
        });

      const waitUntil = <A>(
        eventTypes: ReadonlySet<OrchestrationV2DomainEvent["type"]>,
        read: Effect.Effect<A, Orchestrator.OrchestratorV2Error>,
        matches: (value: A) => boolean,
        formatTimeout: (last: A) => string,
      ): Effect.Effect<A, Orchestrator.OrchestratorV2Error | OrchestratorV2ScenarioStepError> =>
        Effect.gen(function* () {
          let seen = versionFor(eventTypes);
          let last = yield* read;
          if (matches(last)) {
            return last;
          }
          const matched = yield* Effect.gen(function* () {
            while (true) {
              yield* waitForNextStoredEvent(eventTypes, seen);
              seen = versionFor(eventTypes);
              last = yield* read;
              if (matches(last)) {
                return last;
              }
            }
          }).pipe(
            Effect.timeoutOption(Duration.millis(SCENARIO_WAIT_DEADLINE_MS)),
            Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
          );
          if (Option.isSome(matched)) {
            return matched.value;
          }
          last = yield* read;
          if (matches(last)) {
            return last;
          }
          return yield* new OrchestratorV2ScenarioStepError({
            scenario: scenario.name,
            step: formatTimeout(last),
          });
        });

      yield* orchestrator.streamStoredEvents.pipe(
        Stream.runForEach((event) =>
          Ref.update(observedStoredEvents, (existing) => {
            existing.push(event);
            return existing;
          }).pipe(Effect.andThen(Effect.sync(() => notifyStoredEvent(event.event.type)))),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      const backgroundDispatches = new Map<
        string,
        Fiber.Fiber<ReadonlyArray<OrchestrationV2StoredEvent>, Orchestrator.OrchestratorV2Error>
      >();
      const capturedShellSnapshots = new Map<string, OrchestrationV2ThreadShellSnapshot>();
      let anonymousBackgroundDispatchIndex = 0;

      const awaitDispatch = Effect.fn("awaitDispatch")(function* (key: string) {
        const fiber = backgroundDispatches.get(key);
        if (!fiber) {
          return yield* new OrchestratorV2ScenarioStepError({
            scenario: scenario.name,
            step: `await:${key}`,
          });
        }
        const events = yield* Fiber.join(fiber);
        backgroundDispatches.delete(key);
        storedEventGroups.push(events);
      });

      const RUNTIME_REQUEST_EVENTS = new Set<OrchestrationV2DomainEvent["type"]>([
        "runtime-request.updated",
      ]);
      const THREAD_IDLE_EVENTS = new Set<OrchestrationV2DomainEvent["type"]>([
        "run.created",
        "run.updated",
        "checkpoint.rollback-requested",
      ]);
      const BACKGROUND_WORK_EVENTS = new Set<OrchestrationV2DomainEvent["type"]>([
        "provider-thread.updated",
        "run.updated",
        "run.background-work-cancelled",
        "subagent.updated",
        "turn-item.updated",
        "checkpoint.rollback-requested",
        "thread.pull-request-synced",
        "thread.pull-request-link-updated",
      ]);
      const RUN_STEERABLE_EVENTS = new Set<OrchestrationV2DomainEvent["type"]>([
        "run.created",
        "run.updated",
        "provider-turn.updated",
      ]);
      const RUN_STATUS_EVENTS = new Set<OrchestrationV2DomainEvent["type"]>([
        "run.created",
        "run.updated",
      ]);
      const TURN_ITEM_EVENTS = new Set<OrchestrationV2DomainEvent["type"]>(["turn-item.updated"]);
      const GATE_WAIT_EVENTS = new Set<OrchestrationV2DomainEvent["type"]>([
        "run.updated",
        "provider-thread.updated",
      ]);

      const waitForPendingRuntimeRequest = (
        threadId: ThreadId,
      ): Effect.Effect<
        OrchestrationV2RuntimeRequest,
        Orchestrator.OrchestratorV2Error | OrchestratorV2ScenarioStepError,
        never
      > =>
        waitUntil(
          RUNTIME_REQUEST_EVENTS,
          orchestrator.getThreadProjection(threadId),
          (projection) => findPendingRuntimeRequest(projection) !== undefined,
          (projection) => {
            const runState = projection.runs.map((run) => `${run.id}:${run.status}`).join(",");
            return `respond_to_next_runtime_request:${threadId}:runs=${runState}:providerTurns=${projection.providerTurns.length}`;
          },
        ).pipe(Effect.map((projection) => findPendingRuntimeRequest(projection)!));

      const waitForThreadIdle = (
        threadId: ThreadId,
      ): Effect.Effect<
        void,
        Orchestrator.OrchestratorV2Error | OrchestratorV2ScenarioStepError,
        never
      > =>
        waitUntil(
          THREAD_IDLE_EVENTS,
          orchestrator.getThreadProjection(threadId),
          (projection) => !hasActiveRun(projection),
          (projection) => {
            const activeRuns = projection.runs
              .filter((run) =>
                ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
              )
              .map((run) => `${run.id}:${run.status}`)
              .join(",");
            const pendingRequests = projection.runtimeRequests
              .filter((request) => request.status === "pending")
              .map((request) => `${request.id}:${request.kind}`)
              .join(",");
            return `await_thread_idle:${threadId}:runs=${activeRuns}:requests=${pendingRequests}`;
          },
        ).pipe(Effect.asVoid);

      const waitForNoBackgroundWork = (
        threadId: ThreadId,
      ): Effect.Effect<
        void,
        Orchestrator.OrchestratorV2Error | OrchestratorV2ScenarioStepError,
        never
      > =>
        waitUntil(
          BACKGROUND_WORK_EVENTS,
          orchestrator.getThreadShell(threadId),
          (shell) => (shell?.pendingBackgroundTasks?.length ?? 0) === 0,
          (shell) =>
            `await_no_background_work:${threadId}:pending=${shell?.pendingBackgroundTasks?.map((task) => task.taskId).join(",")}`,
        ).pipe(Effect.asVoid);

      const waitForRunSteerable = (
        threadId: ThreadId,
        runId: OrchestrationV2Run["id"],
      ): Effect.Effect<
        void,
        Orchestrator.OrchestratorV2Error | OrchestratorV2ScenarioStepError,
        never
      > =>
        waitUntil(
          RUN_STEERABLE_EVENTS,
          orchestrator.getThreadProjection(threadId),
          (projection) => {
            const run = projection.runs.find((candidate) => candidate.id === runId);
            const providerTurn = projection.providerTurns.find(
              (candidate) =>
                run?.activeAttemptId !== null &&
                candidate.runAttemptId === run?.activeAttemptId &&
                candidate.status === "running",
            );
            return run?.status === "running" && providerTurn !== undefined;
          },
          () => `await_run_steerable:${runId}`,
        ).pipe(Effect.asVoid);

      const waitForRunStatus = (
        threadId: ThreadId,
        runId: OrchestrationV2Run["id"],
        status: OrchestrationV2Run["status"],
      ): Effect.Effect<
        void,
        Orchestrator.OrchestratorV2Error | OrchestratorV2ScenarioStepError,
        never
      > =>
        waitUntil(
          RUN_STATUS_EVENTS,
          orchestrator.getThreadProjection(threadId),
          (projection) =>
            projection.runs.find((candidate) => candidate.id === runId)?.status === status,
          (projection) => {
            const run = projection.runs.find((candidate) => candidate.id === runId);
            return `await_run_status:${runId}:${status}:actual=${run?.status ?? "missing"}`;
          },
        ).pipe(Effect.asVoid);

      const waitForRunTurnItem = (
        threadId: ThreadId,
        runId: OrchestrationV2Run["id"],
        itemType: OrchestrationV2TurnItem["type"],
      ): Effect.Effect<
        void,
        Orchestrator.OrchestratorV2Error | OrchestratorV2ScenarioStepError,
        never
      > =>
        waitUntil(
          TURN_ITEM_EVENTS,
          orchestrator.getThreadProjection(threadId),
          (projection) =>
            projection.turnItems.some((item) => item.runId === runId && item.type === itemType),
          () => `await_run_turn_item:${runId}:${itemType}`,
        ).pipe(Effect.asVoid);

      const releaseReplayGateAfterWaiting = (
        label: string,
        threadId: ThreadId,
        runId: OrchestrationV2Run["id"],
      ): Effect.Effect<
        void,
        Orchestrator.OrchestratorV2Error | OrchestratorV2ScenarioStepError,
        never
      > =>
        Effect.gen(function* () {
          const gate = options.replayGate;
          if (gate !== undefined && !gate.hasReached(label)) {
            const reached = yield* Effect.promise(() => gate.waitForReached(label)).pipe(
              Effect.timeoutOption(Duration.millis(SCENARIO_WAIT_DEADLINE_MS)),
              Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
            );
            if (Option.isNone(reached) || !reached.value) {
              gate.release(label);
              const projection = yield* orchestrator.getThreadProjection(threadId);
              const run = projection.runs.find((candidate) => candidate.id === runId);
              const providerThread = projection.providerThreads.find(
                (candidate) => candidate.id === run?.providerThreadId,
              );
              const pendingTaskCount = providerThread?.pendingBackgroundTasks?.length ?? 0;
              return yield* new OrchestratorV2ScenarioStepError({
                scenario: scenario.name,
                step: `release_replay_gate_after_waiting:${label}:reached=${gate.hasReached(label)}:run=${run?.status ?? "missing"}:providerThread=${run?.providerThreadId ?? "missing"}:pending=${pendingTaskCount}`,
              });
            }
          }
          const projection = yield* waitUntil(
            GATE_WAIT_EVENTS,
            orchestrator.getThreadProjection(threadId),
            (candidate) => {
              const run = candidate.runs.find((item) => item.id === runId);
              const providerThread = candidate.providerThreads.find(
                (item) => item.id === run?.providerThreadId,
              );
              const pendingTaskCount = providerThread?.pendingBackgroundTasks?.length ?? 0;
              return (
                (gate?.hasReached(label) ?? false) &&
                run?.status === "completed" &&
                providerThread !== undefined &&
                pendingTaskCount > 0
              );
            },
            (candidate) => {
              gate?.release(label);
              const run = candidate.runs.find((item) => item.id === runId);
              const providerThread = candidate.providerThreads.find(
                (item) => item.id === run?.providerThreadId,
              );
              const pendingTaskCount = providerThread?.pendingBackgroundTasks?.length ?? 0;
              return `release_replay_gate_after_waiting:${label}:reached=${gate?.hasReached(label) ?? false}:run=${run?.status ?? "missing"}:providerThread=${run?.providerThreadId ?? "missing"}:pending=${pendingTaskCount}`;
            },
          );
          const run = projection.runs.find((candidate) => candidate.id === runId);
          const providerThread = projection.providerThreads.find(
            (candidate) => candidate.id === run?.providerThreadId,
          );
          gate?.release(label);
          if (providerThread !== undefined) {
            yield* waitForProviderBackgroundTasksCleared(threadId, providerThread.id);
          }
        });

      const waitForProviderBackgroundTasksCleared = (
        threadId: ThreadId,
        providerThreadId: NonNullable<OrchestrationV2Run["providerThreadId"]>,
      ): Effect.Effect<
        void,
        Orchestrator.OrchestratorV2Error | OrchestratorV2ScenarioStepError,
        never
      > =>
        waitUntil(
          BACKGROUND_WORK_EVENTS,
          orchestrator.getThreadProjection(threadId),
          (projection) => {
            const providerThread = projection.providerThreads.find(
              (candidate) => candidate.id === providerThreadId,
            );
            const hasPendingTasks = (providerThread?.pendingBackgroundTasks?.length ?? 0) > 0;
            return !hasPendingTasks && providerThread?.status === "idle";
          },
          (projection) => {
            const providerState = projection.providerThreads
              .map(
                (candidate) =>
                  `${candidate.id}:${candidate.status}:pending=${candidate.pendingBackgroundTasks?.length ?? 0}`,
              )
              .join(",");
            return `await_provider_background_tasks_cleared:${threadId}:target=${providerThreadId}:providers=${providerState}`;
          },
        ).pipe(Effect.asVoid);

      let consumedFinishReceipts = 0;
      const finishHeldRun = Effect.fn("scenario.finishHeldRun")(function* (
        step: Extract<OrchestratorV2ScenarioStep, { readonly type: "finish_held_run" }>,
      ) {
        const gate = options.replayGate;
        if (gate === undefined) {
          return yield* new OrchestratorV2ScenarioStepError({
            scenario: scenario.name,
            step: `finish_held_run:${step.runId}:no_replay_gate`,
          });
        }
        while (true) {
          // Only the latest debounce receipt settles the run; late frames rearm it.
          const armed = yield* Effect.promise(() =>
            gate.waitForFinishArmed(consumedFinishReceipts),
          ).pipe(
            Effect.timeoutOption(Duration.millis(SCENARIO_WAIT_DEADLINE_MS)),
            Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
          );
          if (Option.isNone(armed)) {
            const projection = yield* orchestrator.getThreadProjection(step.threadId);
            const run = projection.runs.find((candidate) => candidate.id === step.runId);
            return yield* new OrchestratorV2ScenarioStepError({
              scenario: scenario.name,
              step: `finish_held_run:${step.runId}:${step.status}:actual=${run?.status ?? "missing"}:no_finish_armed`,
            });
          }
          consumedFinishReceipts = gate.finishArmedCount();
          yield* TestClock.adjust(armed.value);
          const settled = yield* Effect.raceFirst(
            waitForRunStatus(step.threadId, step.runId, step.status).pipe(Effect.as(true)),
            Effect.promise(() => gate.waitForFinishArmed(consumedFinishReceipts)).pipe(
              Effect.as(false),
            ),
          );
          if (settled) {
            consumedFinishReceipts = gate.finishArmedCount();
            return;
          }
        }
      });

      const releaseReplayGate = Effect.fn("scenario.releaseReplayGate")(function* (label: string) {
        const gate = options.replayGate;
        const reached =
          gate === undefined ? false : yield* Effect.promise(() => gate.waitForReached(label));
        if (!reached) {
          return yield* new OrchestratorV2ScenarioStepError({
            scenario: scenario.name,
            step: `release_replay_gate:${label}:not_configured`,
          });
        }
        gate?.release(label);
      });

      for (const step of scenarioSteps(scenario)) {
        switch (step.type) {
          case "dispatch": {
            if (step.await ?? true) {
              const result = yield* orchestrator.dispatch(step.command);
              storedEventGroups.push(result.storedEvents);
              break;
            }

            anonymousBackgroundDispatchIndex += 1;
            const key = step.key ?? `dispatch:${anonymousBackgroundDispatchIndex}`;
            backgroundDispatches.set(
              key,
              yield* orchestrator.dispatch(step.command).pipe(
                Effect.map((result) => result.storedEvents),
                Effect.forkScoped,
              ),
            );
            break;
          }
          case "advance_clock":
            yield* TestClock.adjust(step.duration);
            break;
          case "await":
            yield* awaitDispatch(step.key);
            break;
          case "await_all":
            for (const key of Array.from(backgroundDispatches.keys())) {
              yield* awaitDispatch(key);
            }
            break;
          case "await_thread_idle":
            yield* waitForThreadIdle(step.threadId);
            break;
          case "await_no_background_work":
            yield* waitForNoBackgroundWork(step.threadId);
            break;
          case "await_run_steerable":
            yield* waitForRunSteerable(step.threadId, step.runId);
            break;
          case "await_run_status":
            yield* waitForRunStatus(step.threadId, step.runId, step.status);
            break;
          case "finish_held_run":
            yield* finishHeldRun(step);
            break;
          case "await_run_turn_item":
            yield* waitForRunTurnItem(step.threadId, step.runId, step.itemType);
            break;
          case "release_replay_gate_after_waiting":
            yield* releaseReplayGateAfterWaiting(step.label, step.threadId, step.runId);
            break;
          case "release_replay_gate":
            yield* releaseReplayGate(step.label);
            break;
          case "capture_shell_snapshot":
            capturedShellSnapshots.set(step.key, yield* orchestrator.getShellSnapshot());
            break;
          case "respond_to_next_runtime_request": {
            const request = yield* waitForPendingRuntimeRequest(step.threadId);
            if (step.shellSnapshotKeyWhilePending !== undefined) {
              capturedShellSnapshots.set(
                step.shellSnapshotKeyWhilePending,
                yield* orchestrator.getShellSnapshot(),
              );
            }
            const result = yield* orchestrator.dispatch({
              type: "runtime-request.respond",
              commandId: step.commandId,
              threadId: step.threadId,
              requestId: request.id,
              ...(step.decision === undefined ? {} : { decision: step.decision }),
              ...(step.answers === undefined ? {} : { answers: step.answers }),
            });
            storedEventGroups.push(result.storedEvents);
            break;
          }
        }
      }

      for (const key of Array.from(backgroundDispatches.keys())) {
        yield* awaitDispatch(key);
      }
      if (options.afterSteps !== undefined) {
        yield* options.afterSteps;
      }

      const shellSnapshot = yield* orchestrator.getShellSnapshot();
      const projectionThreadIds = new Set(collectProjectionThreadIds(scenario));
      for (const thread of shellSnapshot.threads) {
        projectionThreadIds.add(thread.id);
      }
      const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>();
      for (const threadId of projectionThreadIds) {
        projections.set(threadId, yield* orchestrator.getThreadProjection(threadId));
      }

      yield* Effect.yieldNow;

      const observedEvents = yield* Ref.get(observedStoredEvents);
      const storedEvents = (
        observedEvents.length > 0 ? observedEvents : storedEventGroups.flat()
      ).toSorted((left, right) => left.sequence - right.sequence);
      return {
        storedEvents,
        domainEvents: storedEvents.map((stored) => stored.event),
        projections,
        shellSnapshot,
        capturedShellSnapshots,
      };
    }),
  ).pipe(
    // Release held provider frames before shutdown so teardown cannot block on gates.
    Effect.ensuring(Effect.sync(() => options.replayGate?.releaseAll())),
  );
}
