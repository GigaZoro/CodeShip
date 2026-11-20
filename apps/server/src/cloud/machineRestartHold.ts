import {
  DESKTOP_RESTART_HOLD_PATH,
  type DesktopBackendEndpoint,
  OrchestrationV2RestartHold,
} from "@t3tools/contracts";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
const LINK_SILENCE_LIMIT = Duration.minutes(1);
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

export type MachineRestartHoldError = BackendRestartHoldError | ProviderRuntimeRecoveryError;

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
    readonly whileDraining: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /**
     * Holds scheduled starts in every backend from now until `effect`, run in the background,
     * ends; it starts before this returns, so it outlasts a `whileDraining` the caller leaves.
     */
    readonly drainInBackground: <A, E>(
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<Fiber.Fiber<A, E>>;
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
});

export const make = Effect.fn("cloud.machine_restart_hold.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const recovery = yield* ProviderRuntimeRecoveryService;
  const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const drainRef = yield* UpdateDrain.UpdateDrain;

  const backends = receiver.desktopBackends.pipe(Stream.changesWith(sameBackends));

  /** A backend's stream ends only when it stops, so its end fails like silence does. */
  const linkTo = (backend: DesktopBackendEndpoint, drain: boolean) => {
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
            currentDesktopBootstrapToken(secret, yield* Clock.currentTimeMillis),
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
      Stream.changes,
      Stream.mapEffect((line) => decodeHoldLine(line)),
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

  const restartHold = backends.pipe(
    Stream.runHead,
    Effect.map(Option.getOrElse((): ReadonlyArray<DesktopBackendEndpoint> => [])),
    Effect.flatMap((others) =>
      others.length === 0
        ? recovery.restartHold
        : Effect.all([recovery.restartHold, ...others.map(firstHold)], {
            concurrency: "unbounded",
          }).pipe(Effect.map(mergeHolds)),
    ),
  );

  const drainLinks = backends.pipe(
    Stream.switchMap((others) =>
      Stream.mergeAll(
        others.map((backend) => linkTo(backend, true).pipe(Stream.retry(DRAIN_RELINK))),
        { concurrency: "unbounded" },
      ),
    ),
  );

  /** How many of this backend's drains hold the other backends' scheduled starts now. */
  const othersHeld = yield* SubscriptionRef.make(0);
  const holdOthers = SubscriptionRef.update(othersHeld, (holders) => holders + 1);
  const releaseOthers = SubscriptionRef.update(othersHeld, (holders) => holders - 1);
  // One set of drain links serves every overlapping drain, so a drain that hands over to a
  // background one never lets the other backends start anything between the two.
  yield* SubscriptionRef.changes(othersHeld).pipe(
    Stream.map((holders) => holders > 0),
    Stream.changes,
    Stream.switchMap((draining) => (draining ? drainLinks : Stream.empty)),
    Stream.runDrain,
    Effect.forkScoped,
  );

  const whileDraining = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    UpdateDrain.whileDraining(
      Effect.acquireUseRelease(
        holdOthers,
        () => effect,
        () => releaseOthers,
      ),
    ).pipe(Effect.provideService(UpdateDrain.UpdateDrain, drainRef));

  const drainInBackground = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.uninterruptibleMask((restore) =>
      holdOthers.pipe(
        Effect.andThen(
          UpdateDrain.drainInBackground(restore(effect).pipe(Effect.ensuring(releaseOthers))),
        ),
      ),
    ).pipe(Effect.provideService(UpdateDrain.UpdateDrain, drainRef));

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
