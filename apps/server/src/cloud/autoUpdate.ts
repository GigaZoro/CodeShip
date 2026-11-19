import { ServerSelfUpdateError, type ServerSelfUpdateOutcome } from "@t3tools/contracts";
import { cliReleaseChannelOf, type CliReleaseChannel } from "@t3tools/shared/cliRelease";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import {
  isRestartHoldEmpty,
  untilListedRestartHoldWorkEnds,
  untilRestartHoldIsEmpty,
} from "@t3tools/shared/restartHold";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import { ProviderRuntimeRecoveryService } from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { managedUpdateRefusal } from "../policy/managedUpdates.ts";
import * as ServerConfig from "../config.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as Settings from "../serverSettings.ts";
import * as ReleaseIndex from "./releaseIndex.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { compareExactServiceVersions } from "./serviceProtocol.ts";
import { whileDraining } from "./updateDrain.ts";

/**
 * Releases land every few minutes, and each install restarts the server. Checking this rarely,
 * starting from a boot, keeps a run of releases from becoming a run of restarts.
 */
const AUTO_UPDATE_CHECK_INTERVAL = Duration.minutes(30);
const InstallRecord = Schema.fromJsonString(
  Schema.Struct({ localDay: Schema.String, fromVersion: Schema.String }),
);
const decodeInstallRecord = Schema.decodeUnknownEffect(InstallRecord);
const encodeInstallRecord = Schema.encodeEffect(InstallRecord);
/** A failed attempt for a version waits this long, doubling per further failure up to the cap. */
export const AUTO_UPDATE_RETRY_BASE = Duration.minutes(15);
export const AUTO_UPDATE_RETRY_MAX = Duration.hours(6);
/**
 * A machine whose chats overlap (scheduled runs, autopilot) rarely reaches a hold with no running
 * turn. After this long the update drains: new scheduled starts wait, so the running turns can
 * finish and the install can follow them.
 */
export const AUTO_UPDATE_IDLE_PATIENCE = Duration.hours(2);
/**
 * A drain that has not emptied the machine by now cuts what still runs, like a user's "Update when
 * it finishes" does: it waits for background work and tool calls, and the cut turns resume.
 */
export const AUTO_UPDATE_DRAIN_LIMIT = Duration.hours(3);

export class ServerReleaseLookup extends Context.Service<
  ServerReleaseLookup,
  {
    readonly releases: (
      channel: CliReleaseChannel,
    ) => Stream.Stream<ReleaseIndex.PublishedRelease, ReleaseIndex.ReleaseIndexError>;
  }
>()("t3/cloud/autoUpdate/ServerReleaseLookup") {}

const layerReleaseLookup = Layer.effect(
  ServerReleaseLookup,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return ServerReleaseLookup.of({
      releases: (channel) =>
        ReleaseIndex.publishedReleases(channel).pipe(
          Stream.provideService(HttpClient.HttpClient, httpClient),
        ),
    });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

interface FailedAttempt {
  readonly version: string;
  readonly attempts: number;
  readonly retryAtMillis: number;
}

export type AutoUpdateDecision =
  | { readonly _tag: "rolled-back"; readonly version: string }
  | { readonly _tag: "backing-off"; readonly version: string; readonly retryAtMillis: number }
  | { readonly _tag: "update"; readonly version: string };

export const autoUpdateRetryDelay = (attempts: number): Duration.Duration =>
  Duration.min(
    Duration.times(AUTO_UPDATE_RETRY_BASE, 2 ** Math.max(0, attempts - 1)),
    AUTO_UPDATE_RETRY_MAX,
  );

function latestInstallTime(now: DateTime.Zoned, time: string): number {
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(3));
  const occurrence = (day: DateTime.Zoned) => {
    const { year, month, day: date } = DateTime.toParts(day);
    const parts = { year, month, day: date, hour, minute };
    const options = { timeZone: now.zone, adjustForTimeZone: true };
    // "later" advances a nonexistent time by the gap and otherwise gives the last occurrence.
    const later = DateTime.makeZonedUnsafe(parts, { ...options, disambiguation: "later" });
    if (DateTime.toEpochMillis(later) <= DateTime.toEpochMillis(now)) {
      return DateTime.toEpochMillis(later);
    }
    // Between two occurrences, the first is due. For a gap, "compatible" also advances.
    return DateTime.toEpochMillis(DateTime.makeZonedUnsafe(parts, options));
  };
  const today = occurrence(now);
  return today <= DateTime.toEpochMillis(now)
    ? today
    : occurrence(DateTime.subtract(now, { days: 1 }));
}

export function automaticUpdateTarget<E, R>(
  releases: Stream.Stream<ReleaseIndex.PublishedRelease, E, R>,
  currentVersion: string,
  now: DateTime.Zoned,
  time: string,
) {
  const cutoff = latestInstallTime(now, time);
  return releases.pipe(
    Stream.takeWhile(({ version }) => compareExactServiceVersions(version, currentVersion) > 0),
    Stream.scan(
      { newest: undefined, due: false } as { newest: string | undefined; due: boolean },
      (state, release) => ({
        newest: state.newest ?? release.version,
        due: release.publishedAtMillis !== undefined && release.publishedAtMillis <= cutoff,
      }),
    ),
    Stream.filterMap((state) =>
      state.due && state.newest !== undefined ? Result.succeed(state.newest) : Result.failVoid,
    ),
    Stream.runHead,
  );
}

/**
 * A release the launcher already rolled back is never offered again by this rule: the launcher
 * keeps that record across restarts, and the same release would only roll back again. A newer
 * release is a different version and gets its own attempt. Failures before the handoff are
 * remembered in memory and retried on a growing delay.
 */
function decideAutoUpdate(input: {
  readonly newestVersion: string;
  readonly settledOutcome: ServerSelfUpdateOutcome | undefined;
  readonly notAppliedDesktopVersion: string | undefined;
  readonly failed: FailedAttempt | undefined;
  readonly nowMillis: number;
}): AutoUpdateDecision {
  const { newestVersion, settledOutcome, failed } = input;
  if (
    input.notAppliedDesktopVersion === newestVersion ||
    (settledOutcome !== undefined &&
      settledOutcome.status !== "committed" &&
      settledOutcome.targetVersion === newestVersion)
  ) {
    return { _tag: "rolled-back", version: newestVersion };
  }
  if (failed?.version === newestVersion && failed.retryAtMillis > input.nowMillis) {
    return { _tag: "backing-off", version: newestVersion, retryAtMillis: failed.retryAtMillis };
  }
  return { _tag: "update", version: newestVersion };
}

/**
 * Owns the schedule and restart hold in the server that runs the chats. Installation is handed
 * off to that server's launcher or desktop shell.
 */
export const make = Effect.fn("cloud.auto_update.make")(function* () {
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const settings = yield* Settings.ServerSettingsService;
  const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
  const recovery = yield* ProviderRuntimeRecoveryService;
  const lookup = yield* ServerReleaseLookup;
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const recordPath = path.join(config.baseDir, "runtime", "automatic-update.json");
  const nowLocal = DateTime.now.pipe(
    Effect.map((now) => DateTime.setZone(now, DateTime.zoneMakeLocal())),
  );
  const lastInstall = fs.readFileString(recordPath).pipe(
    Effect.flatMap(decodeInstallRecord),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
  );
  // Persist before handoff, which can stop this process before the installer returns.
  const rememberInstall = nowLocal.pipe(
    Effect.flatMap((now) =>
      encodeInstallRecord({
        localDay: DateTime.formatIsoDate(now),
        fromVersion: packageJson.version,
      }),
    ),
    Effect.flatMap((contents) => writeFileStringAtomically({ filePath: recordPath, contents })),
    Effect.mapError(
      (cause) =>
        new ServerSelfUpdateError({
          reason: "Could not record the automatic update handoff.",
          cause,
        }),
    ),
  );

  const failedRef = yield* Ref.make<FailedAttempt | undefined>(undefined);
  const reportedSkipRef = yield* Ref.make<string | undefined>(undefined);
  const readSettings = settings.getSettings.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not read the automatic update setting.", { error }).pipe(
        Effect.as(undefined),
      ),
    ),
  );

  const waitUntilIdle = untilRestartHoldIsEmpty(recovery.watchRestartHold, (hold) =>
    Effect.logInfo("Automatic update waiting for chats to finish.", {
      backgroundWork: hold.work.length,
      runningTurns: hold.runningTurns?.length ?? 0,
    }),
  ).pipe(Stream.runHead, Effect.map(Option.isSome));

  const waitForListedWork = untilListedRestartHoldWorkEnds(recovery.watchRestartHold, (work) =>
    Effect.logInfo("Automatic update waiting for background work to end.", {
      backgroundWork: work.length,
    }),
  ).pipe(Stream.runHead, Effect.map(Option.isSome));

  /**
   * Why the update must not go now, read fresh: the setting, the policy and what chats are doing.
   * After the patience ran out (`afterPatience`) chats no longer hold it: the wait already ended
   * on the listed work, and a busy machine would otherwise always put it off again.
   */
  const reasonToHoldOff = Effect.fn("cloud.auto_update.reason_to_hold_off")(function* (
    channel: CliReleaseChannel,
    afterPatience: boolean,
    time: string,
  ) {
    const current = yield* readSettings;
    if (!current?.installUpdatesAutomatically) return "the setting was turned off";
    if (current.automaticUpdateTime !== time) return "the automatic update time changed";
    const refusal = managedUpdateRefusal(policy.document, channel);
    if (refusal !== undefined) return refusal;
    if (afterPatience) return undefined;
    const hold = yield* recovery.restartHold.pipe(Effect.option);
    if (Option.isNone(hold)) return "background work could not be read";
    if (isRestartHoldEmpty(hold.value)) return undefined;
    return hold.value.work.length > 0 ? "a chat started background work" : "a chat is answering";
  });

  const recordFailure = Effect.fn("cloud.auto_update.record_failure")(function* (
    version: string,
    reason: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const previous = yield* Ref.get(failedRef);
    const attempts = previous?.version === version ? previous.attempts + 1 : 1;
    const delay = autoUpdateRetryDelay(attempts);
    yield* Ref.set(failedRef, {
      version,
      attempts,
      retryAtMillis: now + Duration.toMillis(delay),
    });
    yield* Effect.logWarning("Automatic update failed.", {
      targetVersion: version,
      attempts,
      retryInMinutes: Math.round(Duration.toMinutes(delay)),
      reason,
    });
  });

  const install = Effect.fn("cloud.auto_update.install")(function* (
    version: string,
    channel: CliReleaseChannel,
    time: string,
  ) {
    yield* Effect.logInfo("Automatic update found a newer release.", {
      currentVersion: packageJson.version,
      targetVersion: version,
    });
    const scheduleChanged = settings.streamChanges.pipe(
      Stream.filter(
        (current) => !current.installUpdatesAutomatically || current.automaticUpdateTime !== time,
      ),
      Stream.runHead,
      Effect.flatMap(Option.match({ onNone: () => Effect.never, onSome: () => Effect.void })),
    );
    const waitFor = (wait: typeof waitUntilIdle) =>
      Effect.raceFirst(
        wait.pipe(
          Effect.catch((error) =>
            recordFailure(version, `Could not read background work: ${error.message}`).pipe(
              Effect.as(false),
            ),
          ),
        ),
        scheduleChanged.pipe(Effect.as(false)),
      );
    const idleOrPatienceRanOut = yield* waitFor(waitUntilIdle).pipe(
      Effect.timeoutOrElse({
        duration: AUTO_UPDATE_IDLE_PATIENCE,
        orElse: () => Effect.succeed("busy" as const),
      }),
    );
    if (idleOrPatienceRanOut === false) return;
    if (idleOrPatienceRanOut === "busy") {
      yield* Effect.logInfo("Automatic update drains: new scheduled starts wait for it.", {
        targetVersion: version,
      });
      // Held until the handoff or the put-off, so no scheduled start begins while it prepares.
      return yield* whileDraining(
        drainThenInstall(version, channel, time, waitFor, scheduleChanged),
      );
    }
    return yield* handOff(channel, false, time, scheduleChanged);
  });

  /** Lets running turns finish with scheduled starts held, then cuts only what outlasts the limit. */
  const drainThenInstall = Effect.fn("cloud.auto_update.drain_then_install")(function* (
    version: string,
    channel: CliReleaseChannel,
    time: string,
    waitFor: (wait: typeof waitUntilIdle) => Effect.Effect<boolean>,
    scheduleChanged: Effect.Effect<void>,
  ) {
    const drained = yield* waitFor(waitUntilIdle).pipe(
      Effect.timeoutOrElse({
        duration: AUTO_UPDATE_DRAIN_LIMIT,
        orElse: () => Effect.succeed("busy" as const),
      }),
    );
    if (drained === false) return;
    if (drained === "busy") {
      const hold = yield* recovery.restartHold.pipe(Effect.option);
      yield* Effect.logWarning("Automatic update stops waiting for chats to be idle.", {
        targetVersion: version,
        cutThreadIds: Option.match(hold, {
          onNone: () => [],
          onSome: (current) => (current.runningTurns ?? []).map((turn) => turn.threadId),
        }),
      });
      if (!(yield* waitFor(waitForListedWork))) return;
    }
    return yield* handOff(channel, drained === "busy", time, scheduleChanged);
  });

  const handOff = Effect.fn("cloud.auto_update.hand_off")(function* (
    channel: CliReleaseChannel,
    afterPatience: boolean,
    time: string,
    scheduleChanged: Effect.Effect<void>,
  ) {
    const version = yield* findTarget(channel, time);
    if (version === undefined) return;
    yield* Effect.logInfo("Automatic update starting.", { targetVersion: version });
    // Set when the last check puts the update off, which is not a failed attempt.
    const heldOff = yield* Ref.make<string | undefined>(undefined);
    const handingOff = yield* Deferred.make<void>();
    const beforeHandoff = () =>
      rememberInstall.pipe(
        Effect.andThen(reasonToHoldOff(channel, afterPatience, time)),
        Effect.flatMap((reason) =>
          reason === undefined
            ? Deferred.succeed(handingOff, undefined).pipe(Effect.asVoid)
            : Ref.set(heldOff, reason).pipe(
                Effect.andThen(Effect.fail(new ServerSelfUpdateError({ reason }))),
              ),
        ),
      );
    // Once the final check allows a handoff, keep the drain until the installer settles.
    const cancelPreparation = Effect.raceFirst(
      scheduleChanged.pipe(Effect.as(true)),
      Deferred.await(handingOff).pipe(Effect.as(false)),
    ).pipe(Effect.flatMap((changed) => (changed ? Effect.void : Effect.never)));
    const prepare = selfUpdate
      .update({ targetVersion: version }, undefined, undefined, beforeHandoff)
      .pipe(
        Effect.flatMap((result) =>
          Effect.logInfo("Automatic update handed to its installer.", {
            targetVersion: result.targetVersion,
            method: result.method,
            updateId: result.updateId,
          }),
        ),
        Effect.catch((error) =>
          Ref.get(heldOff).pipe(
            Effect.flatMap((reason) =>
              reason === undefined
                ? recordFailure(version, error.reason)
                : Effect.logInfo("Automatic update put off until the next check.", {
                    targetVersion: version,
                    reason,
                  }),
            ),
          ),
        ),
      );
    yield* Effect.raceFirst(prepare, cancelPreparation);
  });

  const findTarget = Effect.fn("cloud.auto_update.find_target")(function* (
    channel: CliReleaseChannel,
    time: string,
  ) {
    const now = yield* nowLocal;
    const previous = yield* lastInstall;
    if (
      previous?.localDay === DateTime.formatIsoDate(now) &&
      compareExactServiceVersions(packageJson.version, previous.fromVersion) > 0
    )
      return;
    const newest = yield* automaticUpdateTarget(
      lookup.releases(channel),
      packageJson.version,
      now,
      time,
    ).pipe(
      Effect.catch((error) =>
        Effect.logDebug("Automatic update could not read the release index.", { error }).pipe(
          Effect.as(Option.none<string>()),
        ),
      ),
    );
    if (Option.isNone(newest)) return;
    const decision = decideAutoUpdate({
      newestVersion: newest.value,
      settledOutcome: launcher.settledOutcome,
      notAppliedDesktopVersion: yield* selfUpdate.notAppliedDesktopVersion,
      failed: yield* Ref.get(failedRef),
      nowMillis: DateTime.toEpochMillis(now),
    });
    if (decision._tag === "update") {
      const refusal = managedUpdateRefusal(policy.document, channel);
      if (refusal !== undefined) {
        yield* Effect.logDebug("Automatic update skipped by policy.", { reason: refusal });
        return;
      }
      return decision.version;
    }
    if ((yield* Ref.getAndSet(reportedSkipRef, decision.version)) !== decision.version) {
      yield* Effect.logInfo("Automatic update is holding off a release that did not install.", {
        targetVersion: decision.version,
        reason: decision._tag,
      });
    }
  });

  const check = Effect.fn("cloud.auto_update.check")(function* () {
    const current = yield* readSettings;
    if (!current?.installUpdatesAutomatically) return;
    const channel = cliReleaseChannelOf(packageJson.version);
    const version = yield* findTarget(channel, current.automaticUpdateTime);
    if (version !== undefined) yield* install(version, channel, current.automaticUpdateTime);
  });

  return { check };
});

/**
 * Starts after activation, so a launcher trial never begins another update.
 */
export const start = Effect.fn("cloud.auto_update.start")(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  if (
    serverConfig.mode === "desktop"
      ? serverConfig.desktopTelemetryControlFd === undefined &&
        !serverConfig.desktopUpdateHttpControl
      : !launcher.managed
  )
    return;
  const { check } = yield* make();
  yield* ServerActivation.forkParked(
    check().pipe(
      Effect.catchCause((cause) => Effect.logError("Automatic update check failed.", { cause })),
      Effect.andThen(Effect.sleep(AUTO_UPDATE_CHECK_INTERVAL)),
      Effect.forever,
    ),
  );
});

export const layer = Layer.effectDiscard(start()).pipe(Layer.provide(layerReleaseLookup));
