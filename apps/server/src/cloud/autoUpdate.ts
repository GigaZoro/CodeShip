import { ServerSelfUpdateError, type ServerSelfUpdateOutcome } from "@t3tools/contracts";
import { cliReleaseChannelOf, type CliReleaseChannel } from "@t3tools/shared/cliRelease";
import { isRestartHoldEmpty, untilRestartHoldIsEmpty } from "@t3tools/shared/restartHold";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
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

/**
 * Releases land every few minutes, and each install restarts the server. Checking this rarely,
 * starting from a boot, keeps a run of releases from becoming a run of restarts.
 */
const AUTO_UPDATE_CHECK_INTERVAL = Duration.minutes(30);
/** A failed attempt for a version waits this long, doubling per further failure up to the cap. */
export const AUTO_UPDATE_RETRY_BASE = Duration.minutes(15);
export const AUTO_UPDATE_RETRY_MAX = Duration.hours(6);

export class ServerReleaseLookup extends Context.Service<
  ServerReleaseLookup,
  {
    readonly newest: (
      channel: CliReleaseChannel,
    ) => Effect.Effect<string, ReleaseIndex.ReleaseIndexError>;
  }
>()("t3/cloud/autoUpdate/ServerReleaseLookup") {}

const layerReleaseLookup = Layer.effect(
  ServerReleaseLookup,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return ServerReleaseLookup.of({
      newest: Effect.fn("ServerReleaseLookup.newest")(function* (channel) {
        return yield* ReleaseIndex.resolveNewestVersion(channel).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );
      }),
    });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

interface FailedAttempt {
  readonly version: string;
  readonly attempts: number;
  readonly retryAtMillis: number;
}

export type AutoUpdateDecision =
  | { readonly _tag: "up-to-date" }
  | { readonly _tag: "rolled-back"; readonly version: string }
  | { readonly _tag: "backing-off"; readonly version: string; readonly retryAtMillis: number }
  | { readonly _tag: "update"; readonly version: string };

export const autoUpdateRetryDelay = (attempts: number): Duration.Duration =>
  Duration.min(
    Duration.times(AUTO_UPDATE_RETRY_BASE, 2 ** Math.max(0, attempts - 1)),
    AUTO_UPDATE_RETRY_MAX,
  );

/**
 * A release the launcher already rolled back is never offered again by this rule: the launcher
 * keeps that record across restarts, and the same release would only roll back again. A newer
 * release is a different version and gets its own attempt. Failures before the handoff are
 * remembered in memory and retried on a growing delay.
 */
function decideAutoUpdate(input: {
  readonly currentVersion: string;
  readonly newestVersion: string;
  readonly settledOutcome: ServerSelfUpdateOutcome | undefined;
  readonly failed: FailedAttempt | undefined;
  readonly nowMillis: number;
}): AutoUpdateDecision {
  const { newestVersion, settledOutcome, failed } = input;
  if (compareExactServiceVersions(newestVersion, input.currentVersion) <= 0) {
    return { _tag: "up-to-date" };
  }
  if (
    settledOutcome !== undefined &&
    settledOutcome.status !== "committed" &&
    settledOutcome.targetVersion === newestVersion
  ) {
    return { _tag: "rolled-back", version: newestVersion };
  }
  if (failed?.version === newestVersion && failed.retryAtMillis > input.nowMillis) {
    return { _tag: "backing-off", version: newestVersion, retryAtMillis: failed.retryAtMillis };
  }
  return { _tag: "update", version: newestVersion };
}

/**
 * Installs new releases on a background service once no chat is answering or has background work
 * a restart would cut, and checks again right before the launcher takes over: preparing a release
 * takes minutes, and a chat may start meanwhile. Then it waits for the next check. Foreground and
 * desktop-hosted servers never self-update here; the desktop app owns its own install.
 */
export const make = Effect.fn("cloud.auto_update.make")(function* () {
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const settings = yield* Settings.ServerSettingsService;
  const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
  const recovery = yield* ProviderRuntimeRecoveryService;
  const lookup = yield* ServerReleaseLookup;
  const policy = yield* ManagedPolicy.ManagedPolicy;

  const failedRef = yield* Ref.make<FailedAttempt | undefined>(undefined);
  const reportedSkipRef = yield* Ref.make<string | undefined>(undefined);

  const enabled = settings.getSettings.pipe(
    Effect.map((current) => current.installUpdatesAutomatically),
    Effect.catch((error) =>
      Effect.logWarning("Could not read the automatic update setting.", { error }).pipe(
        Effect.as(false),
      ),
    ),
  );

  /** Ends when the owner turns the setting off, so a wait for idle does not outlive the choice. */
  const turnedOff = settings.streamChanges.pipe(
    Stream.filter((current) => !current.installUpdatesAutomatically),
    Stream.runHead,
    Effect.flatMap(Option.match({ onNone: () => Effect.never, onSome: () => Effect.void })),
  );

  const waitUntilIdle = untilRestartHoldIsEmpty(recovery.watchRestartHold, (hold) =>
    Effect.logInfo("Automatic update waiting for chats to finish.", {
      backgroundWork: hold.work.length,
      runningTurns: hold.runningTurns?.length ?? 0,
    }),
  ).pipe(Stream.runHead, Effect.map(Option.isSome));

  /** Why the update must not go now, read fresh: the setting, the policy and what chats are doing. */
  const reasonToHoldOff = Effect.fn("cloud.auto_update.reason_to_hold_off")(function* (
    channel: CliReleaseChannel,
  ) {
    if (!(yield* enabled)) return "the setting was turned off";
    const refusal = managedUpdateRefusal(policy.document, channel);
    if (refusal !== undefined) return refusal;
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
  ) {
    yield* Effect.logInfo("Automatic update found a newer release.", {
      currentVersion: packageJson.version,
      targetVersion: version,
    });
    const idle = yield* Effect.raceFirst(
      waitUntilIdle.pipe(
        Effect.catch((error) =>
          recordFailure(version, `Could not read background work: ${error.message}`).pipe(
            Effect.as(false),
          ),
        ),
      ),
      turnedOff.pipe(Effect.as(false)),
    );
    if (!idle) return;
    yield* Effect.logInfo("Automatic update starting.", { targetVersion: version });
    // Set when the last check puts the update off, which is not a failed attempt.
    const heldOff = yield* Ref.make<string | undefined>(undefined);
    const beforeHandoff = () =>
      reasonToHoldOff(channel).pipe(
        Effect.flatMap((reason) =>
          reason === undefined
            ? Effect.void
            : Ref.set(heldOff, reason).pipe(
                Effect.andThen(Effect.fail(new ServerSelfUpdateError({ reason }))),
              ),
        ),
      );
    yield* selfUpdate.update({ targetVersion: version }, undefined, undefined, beforeHandoff).pipe(
      Effect.flatMap((result) =>
        Effect.logInfo("Automatic update handed to the service launcher.", {
          targetVersion: result.targetVersion,
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
  });

  /** One look at the release index; installs when the decision says so and nothing holds it. */
  const check = Effect.fn("cloud.auto_update.check")(function* () {
    if (!(yield* enabled)) return;
    const channel = cliReleaseChannelOf(packageJson.version);
    const newest = yield* lookup.newest(channel).pipe(Effect.option);
    if (Option.isNone(newest)) {
      yield* Effect.logDebug("Automatic update could not read the release index.");
      return;
    }
    const decision = decideAutoUpdate({
      currentVersion: packageJson.version,
      newestVersion: newest.value,
      settledOutcome: launcher.settledOutcome,
      failed: yield* Ref.get(failedRef),
      nowMillis: yield* Clock.currentTimeMillis,
    });
    if (decision._tag === "up-to-date") return;
    if (decision._tag === "update") {
      const refusal = managedUpdateRefusal(policy.document, channel);
      if (refusal !== undefined) {
        yield* Effect.logDebug("Automatic update skipped by policy.", { reason: refusal });
        return;
      }
      return yield* install(decision.version, channel);
    }
    if ((yield* Ref.getAndSet(reportedSkipRef, decision.version)) !== decision.version) {
      yield* Effect.logInfo("Automatic update is holding off a release that did not install.", {
        targetVersion: decision.version,
        reason: decision._tag,
      });
    }
  });

  return { check };
});

/**
 * Starts after the server commits, so a trial never begins another update. An unmanaged server and
 * a desktop-hosted one have nothing to do here.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
    if (!launcher.managed || serverConfig.mode === "desktop") return;
    const { check } = yield* make();
    yield* ServerActivation.forkParked(
      Effect.sleep(AUTO_UPDATE_CHECK_INTERVAL).pipe(
        Effect.andThen(check()),
        Effect.catchCause((cause) => Effect.logError("Automatic update check failed.", { cause })),
        Effect.forever,
      ),
    );
  }),
).pipe(Layer.provide(layerReleaseLookup));
