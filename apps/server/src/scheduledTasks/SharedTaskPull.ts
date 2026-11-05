import {
  type EnvironmentId,
  OrchestratorMcpSharedScheduledTasksResult,
  type PeerLink,
  type ScheduledTaskApplySharedInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { forkParked } from "../serverActivation.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const PULL_INTERVAL = Duration.minutes(5);
const PEER_CALL_TIMEOUT = Duration.seconds(20);

/** Copies shared tasks from linked machines in the background, so they sync with no app open. */
export class SharedTaskPull extends Context.Service<
  SharedTaskPull,
  {
    readonly pullOnce: Effect.Effect<void>;
    /** Pulls now, then every few minutes, for as long as the server runs. */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/scheduledTasks/SharedTaskPull") {}

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const client = yield* PeerMcpClient.PeerMcpClient;
  const tasks = yield* ScheduledTaskService.ScheduledTaskService;
  const hereId = yield* ServerEnvironment.ServerEnvironmentIdentity.pipe(
    Effect.flatMap((identity) => identity.getEnvironmentId),
  );

  // Each record's revision check makes a repeat pull change nothing, so one failure only skips that record.
  const applyAll = Effect.fn("SharedTaskPull.applyAll")(function* (
    peer: EnvironmentId,
    pulled: OrchestratorMcpSharedScheduledTasksResult,
  ) {
    const apply = (label: string, id: string, input: ScheduledTaskApplySharedInput) =>
      tasks.applyShared(input).pipe(
        Effect.catch((error) =>
          Effect.logDebug("Could not apply a shared scheduled task", {
            peer,
            record: label,
            id,
            reason: error.message,
          }),
        ),
      );
    yield* Effect.forEach(
      pulled.projectMachineOrders,
      (order) =>
        apply("projectMachineOrder", order.project.type, { type: "projectMachineOrder", order }),
      { discard: true },
    );
    yield* Effect.forEach(
      pulled.tasks,
      (task) => apply("upsert", task.id, { type: "upsert", task }),
      { discard: true },
    );
    yield* Effect.forEach(
      pulled.deletions,
      (deletion) => apply("delete", deletion.id, { type: "delete", deletion }),
      { discard: true },
    );
  });

  const pullFrom = Effect.fn("SharedTaskPull.pullFrom")(function* (link: PeerLink) {
    const answer = yield* client
      .call({
        environmentId: link.environmentId,
        tool: "t3_shared_scheduled_tasks",
        arguments: { forEnvironmentId: hereId },
        limits: { runtimeMode: "approval-required", interactionMode: "plan" },
        success: OrchestratorMcpSharedScheduledTasksResult,
      })
      .pipe(Effect.timeoutOption(PEER_CALL_TIMEOUT));
    if (Option.isNone(answer)) {
      return yield* Effect.logWarning("A linked machine did not answer a shared task pull", {
        peer: link.environmentId,
      });
    }
    yield* applyAll(link.environmentId, answer.value);
  });

  const pullOnce = Effect.gen(function* () {
    if (!(yield* links.enabled)) return;
    const stored = yield* links.listStored;
    const now = yield* DateTime.now;
    yield* Effect.forEach(
      stored.filter((link) => DateTime.isGreaterThan(link.expiresAt, now)),
      (link) =>
        pullFrom(link).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not pull shared tasks from a linked machine", {
              peer: link.environmentId,
              cause,
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not pull shared tasks", { cause })),
    Effect.withSpan("SharedTaskPull.pullOnce"),
  );

  const start = forkParked(
    pullOnce.pipe(Effect.andThen(Effect.sleep(PULL_INTERVAL)), Effect.forever),
  ).pipe(Effect.asVoid);

  return SharedTaskPull.of({ pullOnce, start });
});

/** @public */
export const layer = Layer.effect(SharedTaskPull, make);

/** Starts the background pull with the server. */
export const layerWorker = Layer.effectDiscard(
  SharedTaskPull.pipe(Effect.flatMap((pull) => pull.start)),
).pipe(Layer.provide(layer));
