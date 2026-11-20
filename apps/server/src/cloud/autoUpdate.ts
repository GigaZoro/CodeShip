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
import { drainInBackground, whileDraining } from "./updateDrain.ts";

/**
 * Releases land every few minutes, and each install restarts the server. Checking this rarely,
 * starting from a boot, keeps a run of releases from becoming a run of restarts.
 */
const AUTO_UPDATE_CHECK_INTERVAL = Duration.minutes(30);
/**
 * The last automatic attempt from the running version. It outlives the process: a handoff stops
 * it, and an install that did not apply starts this version again, which must then wait.
 */
const AttemptRecord = Schema.fromJsonString(
  Schema.Struct({
    fromVersion: Schema.String,
    targetVersion: Schema.String,
    attempts: Schema.Int,
    retryAtMillis: Schema.Number,
  }),
);
type AttemptRecord = typeof AttemptRecord.Type;
const decodeAttemptRecord = Schema.decodeUnknownEffect(AttemptRecord);
const encodeAttemptRecord = Schema.encodeEffect(AttemptRecord);
/** A failed attempt waits this long, doubling per further failure up to the cap. */
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
/** Background work still listed this long after the cut no longer holds the install. */
export const AUTO_UPDATE_CUT_GRACE = Duration.hours(1);
/**
 * An installer that accepted the handoff stops this server within seconds. Scheduled starts stay
 * held until then; a server still running after this long lets them go again.
 */
export const AUTO_UPDATE_HANDOFF_STOP_LIMIT = Duration.minutes(5);

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

export interface AutomaticUpdateTarget {
  /** The newest release above the running one: what a launcher installs. */
  readonly newest: string;
  /**
   * The newest release published by the install time. A desktop app takes its feed's newest
   * release, which can lag the release index, so this is the least it may install.
   */
  readonly due: string;
}

/** Why the last check before the handoff put it off; `chats` when chats are what hold it. */
interface HoldOff {
  readonly reason: string;
  readonly chats: boolean;
}

/** The schedule a check found, and the moment it changes. */
interface UpdateSchedule {
  readonly channel: CliReleaseChannel;
  readonly time: string;
  readonly changed: Effect.Effect<void>;
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

const higherVersion = (current: string | undefined, candidate: string) =>
  current === undefined || compareExactServiceVersions(candidate, current) > 0
    ? candidate
    : current;

/**
 * Some release above the running one is due once it was published by the latest install time.
 * The index lists releases newest first but not strictly by version, so the whole stretch above
 * the running release is read rather than stopping at the first older one.
 */
export function automaticUpdateTarget<E, R>(
  releases: Stream.Stream<ReleaseIndex.PublishedRelease, E, R>,
  currentVersion: string,
  now: DateTime.Zoned,
  time: string,
): Effect.Effect<Option.Option<AutomaticUpdateTarget>, E, R> {
  const cutoff = latestInstallTime(now, time);
  return releases.pipe(
    Stream.takeWhile(({ version }) => compareExactServiceVersions(version, currentVersion) !== 0),
    Stream.filter(({ version }) => compareExactServiceVersions(version, currentVersion) > 0),
    Stream.runFold(
      (): { newest: string | undefined; due: string | undefined } => ({
        newest: undefined,
        due: undefined,
      }),
      (found, release) => ({
        newest: higherVersion(found.newest, release.version),
        due:
          release.publishedAtMillis !== undefined && release.publishedAtMillis <= cutoff
            ? higherVersion(found.due, release.version)
            : found.due,
      }),
    ),
    Effect.map(({ newest, due }) =>
      newest !== undefined && due !== undefined ? Option.some({ newest, due }) : Option.none(),
    ),
  );
}

/**
 * A release the launcher rolled back, or a desktop install that did not apply, is never offered
 * again by this rule: the same release would only fail the same way. A newer release gets its own
 * attempt. Every other failure waits out the attempt record's retry time, which survives restarts.
 */
function decideAutoUpdate(input: {
  readonly newestVersion: string;
  readonly settledOutcome: ServerSelfUpdateOutcome | undefined;
  readonly notAppliedDesktopVersion: string | undefined;
  readonly attempt: AttemptRecord | undefined;
  readonly nowMillis: number;
}): AutoUpdateDecision {
  const { newestVersion, settledOutcome, attempt } = input;
  const reachesNewest = (version: string | undefined) =>
    version !== undefined && compareExactServiceVersions(version, newestVersion) >= 0;
  if (
    reachesNewest(input.notAppliedDesktopVersion) ||
    (settledOutcome?.status === "rolled-back" && reachesNewest(settledOutcome.targetVersion))
  ) {
    return { _tag: "rolled-back", version: newestVersion };
  }
  if (attempt !== undefined && attempt.retryAtMillis > input.nowMillis) {
    return { _tag: "backing-off", version: newestVersion, retryAtMillis: attempt.retryAtMillis };
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
  // A desktop app installs its feed's newest release, so it gets the least it may install.
  const installerVersion = (target: AutomaticUpdateTarget) =>
    config.mode === "desktop" ? target.due : target.newest;

  /** The record of an earlier attempt from the running version, if there is one. */
  const lastAttempt = fs.readFileString(recordPath).pipe(
    Effect.flatMap(decodeAttemptRecord),
    Effect.map((record) => (record.fromVersion === packageJson.version ? record : undefined)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
    Effect.catch((error) =>
      Effect.logWarning("Ignoring an unreadable automatic update record.", { error }).pipe(
        Effect.andThen(fs.remove(recordPath, { force: true })),
        Effect.ignore({ log: true }),
        Effect.as(undefined),
      ),
    ),
  );

  /**
   * Counts an attempt and sets when the next may start. Attempts count per running version, so a
   * run of new releases does not reset the wait.
   */
  const recordAttempt = Effect.fn("cloud.auto_update.record_attempt")(
    function* (targetVersion: string) {
      const attempts = ((yield* lastAttempt)?.attempts ?? 0) + 1;
      const delay = autoUpdateRetryDelay(attempts);
      const contents = yield* encodeAttemptRecord({
        fromVersion: packageJson.version,
        targetVersion,
        attempts,
        retryAtMillis: (yield* Clock.currentTimeMillis) + Duration.toMillis(delay),
      });
      yield* writeFileStringAtomically({ filePath: recordPath, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      return { attempts, delay };
    },
    Effect.mapError(
      (cause) =>
        new ServerSelfUpdateError({ reason: "Could not record the automatic update.", cause }),
    ),
  );

  const recordFailure = Effect.fn("cloud.auto_update.record_failure")(function* (
    version: string,
    reason: string,
  ) {
    yield* recordAttempt(version).pipe(
      Effect.flatMap(({ attempts, delay }) =>
        Effect.logWarning("Automatic update failed.", {
          targetVersion: version,
          attempts,
          retryInMinutes: Math.round(Duration.toMinutes(delay)),
          reason,
        }),
      ),
      Effect.catch((error) =>
        Effect.logError("Automatic update failed, and its retry time could not be recorded.", {
          targetVersion: version,
          reason,
          error,
        }),
      ),
    );
  });

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
    schedule: UpdateSchedule,
    afterPatience: boolean,
  ): Effect.fn.Return<HoldOff | undefined, never> {
    const current = yield* readSettings;
    if (!current?.installUpdatesAutomatically) {
      return { reason: "the setting was turned off", chats: false };
    }
    if (current.automaticUpdateTime !== schedule.time) {
      return { reason: "the automatic update time changed", chats: false };
    }
    const refusal = managedUpdateRefusal(policy.document, schedule.channel);
    if (refusal !== undefined) return { reason: refusal, chats: false };
    if (afterPatience) return undefined;
    const hold = yield* recovery.restartHold.pipe(Effect.option);
    if (Option.isNone(hold)) return { reason: "background work could not be read", chats: false };
    if (isRestartHoldEmpty(hold.value)) return undefined;
    return {
      reason: hold.value.work.length > 0 ? "a chat started background work" : "a chat is answering",
      chats: true,
    };
  });

  const install = Effect.fn("cloud.auto_update.install")(function* (
    target: AutomaticUpdateTarget,
    schedule: UpdateSchedule,
  ) {
    yield* Effect.logInfo("Automatic update found a newer release.", {
      currentVersion: packageJson.version,
      newestVersion: target.newest,
      dueVersion: target.due,
    });
    const waitFor = (wait: typeof waitUntilIdle) =>
      Effect.raceFirst(
        wait.pipe(
          Effect.catch((error) =>
            recordFailure(
              installerVersion(target),
              `Could not read background work: ${error.message}`,
            ).pipe(Effect.as(false)),
          ),
        ),
        schedule.changed.pipe(Effect.as(false)),
      );
    /** `true` once idle, `"busy"` when `deadline` passes first, `false` when the wait ends. */
    const idleBefore = (deadline: number) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          now >= deadline
            ? Effect.succeed("busy" as const)
            : waitFor(waitUntilIdle).pipe(
                Effect.timeoutOrElse({
                  duration: Duration.millis(deadline - now),
                  orElse: () => Effect.succeed("busy" as const),
                }),
              ),
        ),
      );
    const patienceEnds =
      (yield* Clock.currentTimeMillis) + Duration.toMillis(AUTO_UPDATE_IDLE_PATIENCE);
    // A chat that starts while the release is prepared sends the update back to waiting with the
    // same deadline: on a busy machine a fresh wait per such chat could put it off for good.
    while (true) {
      const idle = yield* idleBefore(patienceEnds);
      if (idle === false) return;
      if (idle === "busy") break;
      if ((yield* handOff(schedule, false)) !== "chats") return;
    }
    yield* Effect.logInfo("Automatic update drains: new scheduled starts wait for it.", {
      targetVersion: installerVersion(target),
    });
    return yield* whileDraining(
      drainThenInstall(installerVersion(target), schedule, waitFor, idleBefore),
    );
  });

  /** Lets running turns finish with scheduled starts held, then cuts only what outlasts the limit. */
  const drainThenInstall = Effect.fn("cloud.auto_update.drain_then_install")(function* (
    version: string,
    schedule: UpdateSchedule,
    waitFor: (wait: typeof waitUntilIdle) => Effect.Effect<boolean>,
    idleBefore: (deadline: number) => Effect.Effect<boolean | "busy">,
  ) {
    const drainEnds = (yield* Clock.currentTimeMillis) + Duration.toMillis(AUTO_UPDATE_DRAIN_LIMIT);
    while (true) {
      const drained = yield* idleBefore(drainEnds);
      if (drained === false) return;
      if (drained === "busy") break;
      if ((yield* handOff(schedule, false)) !== "chats") return;
    }
    const hold = yield* recovery.restartHold.pipe(Effect.option);
    yield* Effect.logWarning("Automatic update stops waiting for chats to be idle.", {
      targetVersion: version,
      cutThreadIds: Option.match(hold, {
        onNone: () => [],
        onSome: (current) => (current.runningTurns ?? []).map((turn) => turn.threadId),
      }),
    });
    // Work that never ends, such as a stuck tool call, would otherwise hold every later day too.
    const listedWorkEnded = yield* waitFor(waitForListedWork).pipe(
      Effect.timeoutOrElse({
        duration: AUTO_UPDATE_CUT_GRACE,
        orElse: () =>
          Effect.logWarning("Automatic update stops waiting for background work.", {
            targetVersion: version,
          }).pipe(Effect.as(true)),
      }),
    );
    if (!listedWorkEnded) return;
    return yield* handOff(schedule, true);
  });

  /** `"chats"` when a chat that started while the release was prepared put the handoff off. */
  const handOff = Effect.fn("cloud.auto_update.hand_off")(function* (
    schedule: UpdateSchedule,
    afterPatience: boolean,
  ) {
    const target = yield* findTarget(schedule);
    if (target === undefined) return;
    const version = installerVersion(target);
    yield* Effect.logInfo("Automatic update starting.", { targetVersion: version });
    // Set when the last check puts the update off, which is not a failed attempt.
    const heldOff = yield* Ref.make<HoldOff | undefined>(undefined);
    // Set once the attempt is counted, so a failed commit does not count it twice.
    const counted = yield* Ref.make(false);
    const handingOff = yield* Deferred.make<void>();
    // Counted before the commit, which can stop this process before the installer returns.
    const beforeHandoff = () =>
      reasonToHoldOff(schedule, afterPatience).pipe(
        Effect.flatMap((holdOff) =>
          holdOff === undefined
            ? recordAttempt(version).pipe(
                Effect.andThen(Ref.set(counted, true)),
                Effect.andThen(Deferred.succeed(handingOff, undefined)),
                Effect.asVoid,
              )
            : Ref.set(heldOff, holdOff).pipe(
                Effect.andThen(Effect.fail(new ServerSelfUpdateError({ reason: holdOff.reason }))),
              ),
        ),
      );
    // Once the final check allows a handoff, keep the drain until the installer settles.
    const cancelPreparation = Effect.raceFirst(
      schedule.changed.pipe(Effect.as(true)),
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
          }).pipe(
            // The installer stops this server shortly; until then no scheduled start may begin.
            Effect.andThen(
              drainInBackground(
                Effect.sleep(AUTO_UPDATE_HANDOFF_STOP_LIMIT).pipe(
                  Effect.andThen(
                    Effect.logWarning("Automatic update handoff did not stop this server.", {
                      targetVersion: result.targetVersion,
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            const holdOff = yield* Ref.get(heldOff);
            if (holdOff !== undefined) {
              return yield* Effect.logInfo(
                holdOff.chats
                  ? "Automatic update waits for chats again."
                  : "Automatic update put off until the next check.",
                { targetVersion: version, reason: holdOff.reason },
              );
            }
            if (yield* Ref.get(counted)) {
              return yield* Effect.logWarning("Automatic update failed at the handoff.", {
                targetVersion: version,
                reason: error.reason,
              });
            }
            return yield* recordFailure(version, error.reason);
          }),
        ),
      );
    // Held while the release is prepared, so no scheduled start begins under the handoff.
    yield* whileDraining(Effect.raceFirst(prepare, cancelPreparation));
    return (yield* Ref.get(heldOff))?.chats === true ? ("chats" as const) : undefined;
  });

  const findTarget = Effect.fn("cloud.auto_update.find_target")(function* (
    schedule: UpdateSchedule,
  ) {
    const now = yield* nowLocal;
    const target = yield* automaticUpdateTarget(
      lookup.releases(schedule.channel),
      packageJson.version,
      now,
      schedule.time,
    ).pipe(
      Effect.catch((error) =>
        Effect.logDebug("Automatic update could not read the release index.", { error }).pipe(
          Effect.as(Option.none<AutomaticUpdateTarget>()),
        ),
      ),
    );
    if (Option.isNone(target)) return;
    const decision = decideAutoUpdate({
      newestVersion: target.value.newest,
      settledOutcome: launcher.settledOutcome,
      notAppliedDesktopVersion: yield* selfUpdate.notAppliedDesktopVersion,
      attempt: yield* lastAttempt,
      nowMillis: DateTime.toEpochMillis(now),
    });
    if (decision._tag === "update") {
      const refusal = managedUpdateRefusal(policy.document, schedule.channel);
      if (refusal !== undefined) {
        yield* Effect.logDebug("Automatic update skipped by policy.", { reason: refusal });
        return;
      }
      return target.value;
    }
    if ((yield* Ref.getAndSet(reportedSkipRef, decision.version)) !== decision.version) {
      yield* Effect.logInfo("Automatic update is holding off a release that did not install.", {
        targetVersion: decision.version,
        reason: decision._tag,
      });
    }
  });

  const check = Effect.fn("cloud.auto_update.check")(function* () {
    // Subscribed before the settings are read, so a change during the lookup still ends the wait.
    const changes = yield* settings.subscribeChanges;
    const current = yield* readSettings;
    if (!current?.installUpdatesAutomatically) return;
    const time = current.automaticUpdateTime;
    const changed = yield* Deferred.make<void>();
    yield* changes.pipe(
      Stream.filter(
        (next) => !next.installUpdatesAutomatically || next.automaticUpdateTime !== time,
      ),
      Stream.runHead,
      Effect.flatMap((first) =>
        Option.isSome(first) ? Deferred.succeed(changed, undefined) : Effect.void,
      ),
      Effect.forkScoped,
    );
    const schedule: UpdateSchedule = {
      channel: cliReleaseChannelOf(packageJson.version),
      time,
      changed: Deferred.await(changed),
    };
    const target = yield* findTarget(schedule);
    if (target !== undefined) yield* install(target, schedule);
  }, Effect.scoped);

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
