import { DESKTOP_RESTART_HOLD_PATH } from "@t3tools/contracts/desktopBootstrap";
import { OrchestrationV2RestartHold } from "@t3tools/contracts/orchestrationV2";
import type { DesktopBackendEndpoint } from "@t3tools/contracts/resourceTelemetry";
import { currentDesktopControlToken } from "@t3tools/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RcRef from "effect/RcRef";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as ServerConfig from "../config.ts";
import {
  type ProviderRuntimeRecoveryError,
  ProviderRuntimeRecoveryService,
} from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as UpdateDrain from "./updateDrain.ts";

/** A backend resends its hold this often while it is unchanged, so a dead link shows. */
const LINK_KEEPALIVE = Duration.seconds(20);
const LINK_SILENCE_LIMIT = DesktopTelemetryReceiver.DESKTOP_BACKEND_SILENCE_LIMIT;
/** A drain lease that drops is taken again while the desktop app still runs that backend. */
const DRAIN_RELINK = Schedule.spaced(Duration.seconds(5));

export class BackendRestartHoldError extends Schema.TaggedError<BackendRestartHoldError>()(
  "BackendRestartHoldError",
  {
    backend: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The ${this.backend} backend did not report its background work.`;
  }
}

export type MachineRestartHoldError =
  | BackendRestartHoldError
  | ProviderRuntimeRecoveryError
  | DesktopTelemetryReceiver.DesktopBackendInventoryUnavailable;

/**
 * The restart hold of every backend the desktop install stops. The primary's automatic update
 * waits on it, while each other backend serves its own hold to the primary.
 */
export class MachineRestartHold extends Context.Service<
  MachineRestartHold,
  {
    readonly restartHold: Effect.Effect<OrchestrationV2RestartHold, MachineRestartHoldError>;
    /** The merged hold now and after every change in any backend or in which backends run. */
    readonly watchRestartHold: Stream.Stream<OrchestrationV2RestartHold, MachineRestartHoldError>;
    /** Holds scheduled starts in every backend for the life of `effect`. */
    readonly whileDraining: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | MachineRestartHoldError, R>;
    /**
     * Holds scheduled starts in every backend from now until `effect`, run in the background,
     * ends; it starts before this returns, so it outlasts a `whileDraining` the caller leaves.
     */
    readonly drainInBackground: <A, E>(
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<Fiber.Fiber<A, E>, BackendRestartHoldError>;
    /** This backend's hold as JSON lines for the primary; `drain` holds its scheduled starts. */
    readonly serveToPrimary: (
      drain: boolean,
    ) => Stream.Stream<Uint8Array, ProviderRuntimeRecoveryError>;
  }
>()("t3/cloud/machineRestartHold") {}

const decodeHoldLine = Schema.decodeEffect(Schema.fromJsonString(OrchestrationV2RestartHold));
const encodeHoldLine = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2RestartHold));

const sameBackends = (
  left: ReadonlyArray<DesktopBackendEndpoint>,
  right: ReadonlyArray<DesktopBackendEndpoint>,
) =>
  left.length === right.length &&
  left.every(
    (backend, index) =>
      backend.id === right[index]?.id &&
      backend.label === right[index]?.label &&
      backend.httpBaseUrl === right[index]?.httpBaseUrl,
  );

const mergeHolds = (
  holds: ReadonlyArray<OrchestrationV2RestartHold>,
): OrchestrationV2RestartHold => ({
  work: holds.flatMap((hold) => hold.work),
  runningTurns: holds.flatMap((hold) => hold.runningTurns ?? []),
  commands: holds.flatMap((hold) => hold.commands ?? []),
  ...(holds.some((hold) => hold.draining === true) ? { draining: true } : {}),
});

export const make = Effect.fn("cloud.machine_restart_hold.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const recovery = yield* ProviderRuntimeRecoveryService;
  const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const drainRef = yield* UpdateDrain.UpdateDrain;

  const backends = receiver.desktopBackends.pipe(Stream.changesWith(sameBackends));

  /** A backend's stream ends only when it stops, so its end fails like silence does. */
  const linkTo = (backend: DesktopBackendEndpoint, drain: boolean, invalidate = Effect.void) => {
    const failure = (cause: unknown) =>
      new BackendRestartHoldError({ backend: backend.label, cause });
    return Stream.unwrap(
      Effect.gen(function* () {
        const secret = config.desktopBootstrapSecret;
        if (secret === undefined) return yield* Effect.fail("no desktop bootstrap secret");
        const url = yield* Effect.try(
          () => new URL(DESKTOP_RESTART_HOLD_PATH, backend.httpBaseUrl),
        );
        const request = HttpClientRequest.get(url).pipe(
          HttpClientRequest.bearerToken(
            currentDesktopControlToken(secret, yield* Clock.currentTimeMillis),
          ),
          drain ? HttpClientRequest.setUrlParam("drain", "1") : (request) => request,
        );
        return (yield* httpClient.execute(request)).stream;
      }),
    ).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.length > 0),
      Stream.concat(Stream.fail("the backend closed the link")),
      Stream.timeoutOrElse({
        duration: LINK_SILENCE_LIMIT,
        orElse: () => Stream.fail("the backend went silent"),
      }),
      Stream.mapEffect((line) => decodeHoldLine(line)),
      Stream.tapError(() => invalidate),
      Stream.tapError((cause) =>
        Effect.logWarning("Could not read another desktop backend's background work.", {
          backend: backend.id,
          cause,
        }),
      ),
      Stream.mapError(failure),
    );
  };

  const watchRestartHold: Stream.Stream<OrchestrationV2RestartHold, MachineRestartHoldError> =
    backends.pipe(
      Stream.switchMap((others) =>
        others.length === 0
          ? recovery.watchRestartHold
          : Stream.zipLatestAll(
              recovery.watchRestartHold,
              ...others.map((backend) => linkTo(backend, false)),
            ).pipe(Stream.map(mergeHolds)),
      ),
    );

  /** A backend's link only ends by failing, so its first hold is always there. */
  const firstHold = (backend: DesktopBackendEndpoint) =>
    linkTo(backend, false).pipe(
      Stream.runHead,
      Effect.map(Option.getOrThrowWith(() => new Error("the link ended without a hold"))),
    );

  type LinkHolds = ReadonlyMap<string, { hold: OrchestrationV2RestartHold; at: number }>;
  const endpointKey = (backend: DesktopBackendEndpoint) =>
    encodeURIComponent(backend.id) + ":" + backend.httpBaseUrl;
  const activeLinks = yield* Ref.make<SubscriptionRef.SubscriptionRef<LinkHolds> | undefined>(
    undefined,
  );
  // Preparations, the patience drain and the installer overlap. Only their last release closes the links.
  const othersHeld = yield* RcRef.make({
    acquire: Effect.gen(function* () {
      const lines = yield* SubscriptionRef.make<LinkHolds>(new Map());
      yield* Effect.acquireRelease(Ref.set(activeLinks, lines), () =>
        Ref.update(activeLinks, (active) => (active === lines ? undefined : active)),
      );
      const links = yield* FiberMap.make<string>();
      yield* backends.pipe(
        Stream.retry(DRAIN_RELINK),
        Stream.runForEach((others) =>
          Effect.gen(function* () {
            const listed = new Map(others.map((backend) => [endpointKey(backend), backend]));
            for (const [key] of links) {
              if (!listed.has(key)) yield* FiberMap.remove(links, key);
            }
            for (const [key, backend] of listed) {
              if (yield* FiberMap.has(links, key)) continue;
              const forget = SubscriptionRef.update(lines, (holds) => {
                const next = new Map(holds);
                next.delete(key);
                return next;
              });
              const listen = linkTo(backend, true, forget).pipe(
                Stream.runForEach((hold) =>
                  Clock.currentTimeMillis.pipe(
                    Effect.flatMap((at) =>
                      SubscriptionRef.update(lines, (holds) =>
                        new Map(holds).set(key, { hold, at }),
                      ),
                    ),
                  ),
                ),
                Effect.ensuring(forget),
                Effect.retry(DRAIN_RELINK),
              );
              yield* FiberMap.run(links, key, listen);
            }
          }),
        ),
        Effect.forkScoped,
      );
      return lines;
    }),
  });

  const currentBackends = backends.pipe(
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new DesktopTelemetryReceiver.DesktopBackendInventoryUnavailable()),
        onSome: Effect.succeed,
      }),
    ),
  );

  const drainSnapshot = (
    others: ReadonlyArray<DesktopBackendEndpoint>,
    lines: LinkHolds,
    now: number,
  ): Result.Result<ReadonlyArray<OrchestrationV2RestartHold>, BackendRestartHoldError> => {
    const holds: Array<OrchestrationV2RestartHold> = [];
    for (const backend of others) {
      const line = lines.get(endpointKey(backend));
      if (!line || now - line.at >= Duration.toMillis(LINK_SILENCE_LIMIT)) {
        return Result.fail(
          new BackendRestartHoldError({
            backend: backend.label,
            cause: "the drain link has no live acknowledgement",
          }),
        );
      }
      holds.push(line.hold);
    }
    return Result.succeed(holds);
  };

  const readDrainSnapshot = Effect.fn("cloud.machine_restart_hold.read_drain_snapshot")(function* (
    lines: SubscriptionRef.SubscriptionRef<LinkHolds>,
  ) {
    const listed = yield* currentBackends;
    return drainSnapshot(listed, yield* SubscriptionRef.get(lines), yield* Clock.currentTimeMillis);
  });

  const awaitAcknowledgements = Effect.fn("cloud.machine_restart_hold.await_acknowledgements")(
    function* (lines: SubscriptionRef.SubscriptionRef<LinkHolds>) {
      const read = readDrainSnapshot(lines);
      const initial = yield* read;
      if (Result.isSuccess(initial)) return;
      let missing = initial.failure;
      // Queued notifications can describe an older inventory or a link that has since dropped.
      yield* Stream.merge(backends, SubscriptionRef.changes(lines)).pipe(
        Stream.mapEffect(() => read),
        Stream.map((snapshot) => {
          if (Result.isSuccess(snapshot)) return true;
          missing = snapshot.failure;
          return false;
        }),
        Stream.filter((ready) => ready),
        Stream.runHead,
        Effect.flatMap(
          Option.match({ onNone: () => Effect.fail(missing), onSome: () => Effect.void }),
        ),
        Effect.timeoutOrElse({ duration: LINK_SILENCE_LIMIT, orElse: () => Effect.fail(missing) }),
      );
    },
  );

  const localTimeout = () =>
    Effect.fail(
      new BackendRestartHoldError({ backend: "primary", cause: "the local hold timed out" }),
    );
  const restartHold = Effect.gen(function* () {
    const local = yield* recovery.restartHold.pipe(
      Effect.timeoutOrElse({ duration: LINK_SILENCE_LIMIT, orElse: localTimeout }),
    );
    const links = yield* Ref.get(activeLinks);
    if (links !== undefined) {
      const snapshot = yield* readDrainSnapshot(links);
      if (Result.isFailure(snapshot)) return yield* snapshot.failure;
      return mergeHolds([local, ...snapshot.success]);
    }
    const others = yield* currentBackends;
    return mergeHolds([
      local,
      ...(yield* Effect.forEach(others, firstHold, { concurrency: "unbounded" })),
    ]);
  });

  const startDrain = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<SubscriptionRef.SubscriptionRef<LinkHolds>>();
        const child = yield* UpdateDrain.whileDraining(
          RcRef.get(othersHeld).pipe(
            Effect.flatMap((lines) => Deferred.succeed(ready, lines)),
            Effect.andThen(effect),
            Effect.scoped,
          ),
        ).pipe(
          Effect.provideService(UpdateDrain.UpdateDrain, drainRef),
          Effect.interruptible,
          Effect.forkDetach,
        );
        const links = yield* restore(
          Deferred.await(ready).pipe(
            Effect.timeoutOrElse({ duration: LINK_SILENCE_LIMIT, orElse: localTimeout }),
          ),
        ).pipe(Effect.onError(() => Fiber.interrupt(child)));
        return { child, links };
      }),
    );

  const drainInBackground = <A, E>(effect: Effect.Effect<A, E>) =>
    startDrain(effect).pipe(Effect.map(({ child }) => child));

  const whileDraining = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      startDrain(Effect.never),
      ({ links }) => awaitAcknowledgements(links).pipe(Effect.andThen(effect)),
      ({ child }) => Fiber.interrupt(child),
    );

  const serveToPrimary = (drain: boolean) => {
    const lines = recovery.watchRestartHold.pipe(
      Stream.switchMap((hold) => Stream.tick(LINK_KEEPALIVE).pipe(Stream.as(hold))),
      Stream.map((hold) => `${encodeHoldLine(hold)}\n`),
      Stream.encodeText,
    );
    return drain
      ? Stream.unwrap(
          UpdateDrain.drainUntilClosed.pipe(
            Effect.as(lines),
            Effect.provideService(UpdateDrain.UpdateDrain, drainRef),
          ),
        )
      : lines;
  };

  return MachineRestartHold.of({
    restartHold,
    watchRestartHold,
    whileDraining,
    drainInBackground,
    serveToPrimary,
  });
});

export const layer = Layer.effect(MachineRestartHold, make()).pipe(
  Layer.provide(FetchHttpClient.layer),
);
