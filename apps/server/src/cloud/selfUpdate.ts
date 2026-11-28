import type { ServerSelfUpdateCapability } from "@t3tools/contracts/environment";
import {
  ServerSelfUpdateError,
  type ServerSelfUpdateInput,
  type ServerSelfUpdateProgressEvent,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
} from "@t3tools/contracts/serverUpdate";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";

import {
  CLI_RELEASE_BASE_URL_ENV,
  cliReleaseChannelOf,
  crossesReleaseTrack,
} from "@t3tools/shared/cliRelease";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import { databaseMigrationHead } from "../persistence/databaseMigrationHead.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { managedUpdateRefusal } from "../policy/managedUpdates.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerActivation from "../serverActivation.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimeCommand,
  PinnedRuntimeInstallError,
  pinnedRuntimePaths,
  PinnedRuntimePreflightBlockedError,
  prunePinnedRuntimes,
  repointPinnedRuntimeLaunchers,
} from "./pinnedRuntime.ts";
import { decodeServicePreflightResult } from "./servicePreflight.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { isExactServiceVersion, SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";
import * as UpdateDrain from "./updateDrain.ts";

// A staged runtime's cold start can take over a minute on a loaded, swapping host.
const PREFLIGHT_TIMEOUT = Duration.minutes(3);
/**
 * An accepted handoff stops this server within seconds. Keep UpdateDrain held server-side until
 * shutdown so closing the client drain stream cannot release queued work into a dying process;
 * release after this bound if the launcher or desktop host fails to stop the server.
 */
export const SELF_UPDATE_HANDOFF_DRAIN_LIMIT = Duration.minutes(5);

export function resolveServerSelfUpdateCapability(input: {
  readonly desktopManaged: boolean;
  readonly launcherManaged: boolean;
}): ServerSelfUpdateCapability | null {
  if (input.desktopManaged) return "desktop-managed" as const;
  return input.launcherManaged ? ("boot-service" as const) : null;
}

export interface PreparedServerSelfUpdate {
  readonly targetVersion: string;
  readonly runtimePath: string;
  readonly migratesDatabase: boolean;
}

export class ServerSelfUpdate extends Context.Service<
  ServerSelfUpdate,
  {
    /**
     * Downloads, verifies, and preflights a boot-service release on disk without handing off or
     * holding the in-flight lock after staging finishes, so callers can pre-stage while chats run.
     */
    readonly prepare: (
      input: ServerSelfUpdateInput,
      reportProgress?: (
        stage: ServerSelfUpdateProgressStage,
      ) => Effect.Effect<void, ServerSelfUpdateError>,
    ) => Effect.Effect<PreparedServerSelfUpdate, ServerSelfUpdateError>;
    /**
     * Hands an already-prepared boot-service release to the launcher. `beforeHandoff` is the last
     * check before the launcher takes over; when it fails, nothing is handed off and the staged
     * runtime remains cached on disk.
     */
    readonly activatePrepared: (
      prepared: PreparedServerSelfUpdate,
      reportProgress?: (
        stage: ServerSelfUpdateProgressStage,
      ) => Effect.Effect<void, ServerSelfUpdateError>,
      onHandoffAccepted?: () => Effect.Effect<void>,
      beforeHandoff?: () => Effect.Effect<void, ServerSelfUpdateError>,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
    /**
     * Automatic installs pass `beforeHandoff` to recheck after preparation and commit in the
     * same request. A manual desktop update returns a token for the client's separate commit.
     */
    readonly update: (
      input: ServerSelfUpdateInput,
      reportProgress?: (
        stage: ServerSelfUpdateProgressStage,
      ) => Effect.Effect<void, ServerSelfUpdateError>,
      onHandoffAccepted?: () => Effect.Effect<void>,
      beforeHandoff?: () => Effect.Effect<void, ServerSelfUpdateError>,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
    readonly commitDesktopUpdate: (
      requestId: string,
      onHandoffAccepted?: () => Effect.Effect<void>,
    ) => Effect.Effect<never, ServerSelfUpdateError>;
    readonly notAppliedDesktopVersion: Effect.Effect<string | undefined>;
  }
>()("t3/cloud/selfUpdate/ServerSelfUpdate") {}

/**
 * A server starting from the runtime its launcher settled on means runtimes left by earlier
 * updates can go. The boot service says so through its IPC context. The SSH launcher and the
 * install script's `t3` start this home's pinned runtime directly, without one.
 */
export const pruneRuntimesOnStart = Effect.fn("cloud.server_self_update.prune_on_start")(
  function* (input: { readonly baseDir: string; readonly managed: boolean }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const executablePath = yield* HostProcess.ExecutablePath;
    const { entryPath } = pinnedRuntimePaths(path, input.baseDir, packageJson.version, platform);
    // The executable path is resolved, so it names the real path of a symlinked T3 home.
    const realEntryPath = yield* fs.realPath(entryPath).pipe(Effect.orElseSucceed(() => entryPath));
    if (!input.managed && executablePath !== entryPath && executablePath !== realEntryPath) {
      return [];
    }
    const removed = yield* prunePinnedRuntimes({
      baseDir: input.baseDir,
      keep: [packageJson.version],
    });
    if (removed.length > 0) {
      yield* Effect.logInfo("Removed unused t3 runtimes.", { versions: removed });
    }
    return removed;
  },
);

/** The client checks this when planning; the host checks again because its database may have
 * moved on since (another client updated it). Stable and Nightly each build their own commits,
 * so crossing tracks needs the target release to know every migration this database holds. */
export function trackSwitchBlockReason(input: {
  readonly serverVersion: string;
  readonly targetVersion: string;
  readonly targetDatabaseMigration: number | undefined;
  /** Read only for a crossing; undefined when the database cannot be read. */
  readonly databaseMigration: () => number | undefined;
}): string | null {
  if (!crossesReleaseTrack(input.serverVersion, input.targetVersion)) return null;
  const databaseMigration = input.databaseMigration();
  if (input.targetDatabaseMigration === undefined || databaseMigration === undefined) {
    return `Cannot confirm this database works with t3@${input.targetVersion}. Switch tracks from Settings → Maintenance & about → Update track, which checks it first.`;
  }
  return input.targetDatabaseMigration < databaseMigration
    ? `This database has changes t3@${input.targetVersion} does not support yet; it stays on this release.`
    : null;
}

export const make = Effect.fn("cloud.server_self_update.make")(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const desktopAppUpdate = yield* DesktopAppUpdate.DesktopAppUpdate;
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const httpClient = yield* HttpClient.HttpClient;
  const releaseBaseUrl = Option.getOrUndefined(
    yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option),
  );
  const serviceScope = yield* Effect.scope;
  const updateDrain = yield* UpdateDrain.UpdateDrain;
  const inFlight = yield* Ref.make(false);
  const staged = yield* Ref.make<{
    readonly prepared: PreparedServerSelfUpdate;
    readonly databaseMigration: number | undefined;
  } | null>(null);

  const pruneOnStart = pruneRuntimesOnStart({
    baseDir: serverConfig.baseDir,
    managed: launcher.managed,
  });
  const capability: ServerSelfUpdateCapability | null =
    serverConfig.mode === "desktop" ? "desktop-managed" : launcher.managed ? "boot-service" : null;
  if (capability === "boot-service") {
    // Parked until the launcher commits this version, so a trial that rolls back moves nothing.
    // Prune follows, so the runtimes the moved launchers named can go on this start.
    yield* ServerActivation.forkParked(
      repointPinnedRuntimeLaunchers({
        baseDir: serverConfig.baseDir,
        version: packageJson.version,
      }).pipe(
        Effect.tap((launchers) =>
          launchers.length === 0
            ? Effect.void
            : Effect.logInfo("Moved t3 launchers to the running runtime.", {
                launchers,
                version: packageJson.version,
              }),
        ),
        Effect.andThen(pruneOnStart),
      ),
    );
  } else {
    yield* pruneOnStart.pipe(Effect.forkScoped);
  }
  const failWith = (reason: string, cause?: unknown) =>
    cause === undefined
      ? new ServerSelfUpdateError({ reason })
      : new ServerSelfUpdateError({ reason, cause });

  const holdDrainAfterHandoff = (targetVersion?: string) =>
    UpdateDrain.holdInBackgroundRef(
      updateDrain,
      serviceScope,
      SELF_UPDATE_HANDOFF_DRAIN_LIMIT,
      Effect.logWarning(
        "Server update handoff did not stop this server.",
        targetVersion === undefined ? {} : { targetVersion },
      ),
    );

  const commitDesktopWithDrainHold = (
    requestId: string,
    targetVersion?: string,
    onHandoffAccepted?: () => Effect.Effect<void>,
  ) =>
    Effect.suspend(() => {
      let held = false;
      let releaseHold: Effect.Effect<void> | undefined;
      const holdOnce = () =>
        held
          ? Effect.void
          : Effect.uninterruptible(
              Effect.gen(function* () {
                held = true;
                releaseHold = yield* holdDrainAfterHandoff(targetVersion);
              }),
            );
      const releaseIfHeld = () => (releaseHold === undefined ? Effect.void : releaseHold);
      return desktopAppUpdate
        .commit(requestId, () =>
          holdOnce().pipe(
            Effect.andThen(onHandoffAccepted === undefined ? Effect.void : onHandoffAccepted()),
          ),
        )
        .pipe(
          Effect.tap(holdOnce),
          // Release immediately on explicit desktop install failure/timeout; keep the bounded
          // hold across fiber interruption (e.g. WS disconnect while Electron is restarting).
          Effect.tapError(() => releaseIfHeld()),
        );
    });

  const crossesTrackUnsafely = (input: ServerSelfUpdateInput) =>
    trackSwitchBlockReason({
      serverVersion: packageJson.version,
      targetVersion: input.targetVersion,
      targetDatabaseMigration: input.targetDatabaseMigration,
      databaseMigration: () => databaseMigrationHead(serverConfig.dbPath),
    });

  const cachedPreparedFor = Effect.fn("cloud.server_self_update.cached_prepared")(function* (
    targetVersion: string,
  ) {
    const entry = yield* Ref.get(staged);
    if (entry === null || entry.prepared.targetVersion !== targetVersion) return undefined;
    if (entry.databaseMigration !== databaseMigrationHead(serverConfig.dbPath)) return undefined;
    const exists = yield* fs
      .exists(entry.prepared.runtimePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) return undefined;
    return entry.prepared;
  });

  const stageBootServiceRuntime = Effect.fn("cloud.server_self_update.stage_runtime")(function* (
    targetVersion: string,
    reportProgress: (
      stage: ServerSelfUpdateProgressStage,
    ) => Effect.Effect<void, ServerSelfUpdateError>,
  ) {
    const cached = yield* cachedPreparedFor(targetVersion);
    if (cached !== undefined) return cached;

    yield* reportProgress("downloading");
    const migratesDatabase = yield* Ref.make(true);
    const paths = yield* ensurePinnedRuntimeInstalled({
      baseDir: serverConfig.baseDir,
      version: targetVersion,
      fs,
      path,
      runner,
      httpClient,
      platform,
      arch,
      releaseBaseUrl,
      validate: (runtime) =>
        runner
          .run({
            command: pinnedRuntimeCommand(runtime).command,
            env: { T3CODE_VERIFY_INSTALL: "1" },
            args: [
              ...pinnedRuntimeCommand(runtime).args,
              "__service-preflight",
              "--database-path",
              serverConfig.dbPath,
              "--launcher-protocol",
              String(SERVICE_LAUNCHER_PROTOCOL),
            ],
            timeout: PREFLIGHT_TIMEOUT,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PinnedRuntimeInstallError({
                  step: "running the staged service preflight",
                  cause,
                }),
            ),
            Effect.flatMap(
              (
                result,
              ): Effect.Effect<
                void,
                PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError
              > => {
                if (result.code !== 0) {
                  return Effect.fail(
                    new PinnedRuntimeInstallError({
                      step: "running the staged service preflight",
                      exitCode: Number(result.code),
                      stdoutLength: result.stdout.length,
                      stderrLength: result.stderr.length,
                    }),
                  );
                }
                let parsed: unknown;
                try {
                  parsed = JSON.parse(result.stdout.trim());
                } catch (cause) {
                  return Effect.fail(
                    new PinnedRuntimeInstallError({
                      step: "decoding the staged service preflight",
                      cause,
                    }),
                  );
                }
                const preflight = decodeServicePreflightResult(parsed);
                if (preflight === undefined || preflight.version !== targetVersion) {
                  return Effect.fail(
                    new PinnedRuntimeInstallError({
                      step: "verifying the staged service preflight",
                    }),
                  );
                }
                return preflight.status === "ready"
                  ? Ref.set(migratesDatabase, preflight.migratesDatabase)
                  : Effect.fail(
                      new PinnedRuntimePreflightBlockedError({
                        version: targetVersion,
                        reason: preflight.reason,
                      }),
                    );
              },
            ),
          ),
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "PinnedRuntimePreflightBlockedError"
          ? failWith(error.reason, error)
          : failWith(`Could not prepare t3@${targetVersion}.`, error),
      ),
    );

    const prepared: PreparedServerSelfUpdate = {
      targetVersion,
      runtimePath: paths.entryPath,
      migratesDatabase: yield* Ref.get(migratesDatabase),
    };
    yield* Ref.set(staged, {
      prepared,
      databaseMigration: databaseMigrationHead(serverConfig.dbPath),
    });
    return prepared;
  });

  const handoffBootServiceRuntime = Effect.fn("cloud.server_self_update.handoff_runtime")(
    function* (
      prepared: PreparedServerSelfUpdate,
      reportProgress: (
        stage: ServerSelfUpdateProgressStage,
      ) => Effect.Effect<void, ServerSelfUpdateError>,
      onHandoffAccepted: () => Effect.Effect<void>,
      beforeHandoff: (() => Effect.Effect<void, ServerSelfUpdateError>) | undefined,
    ) {
      if (beforeHandoff !== undefined) {
        yield* beforeHandoff();
      }
      yield* reportProgress("installing");
      const updateId = yield* Effect.uninterruptible(
        launcher
          .requestUpdate({
            targetVersion: prepared.targetVersion,
            dbPath: serverConfig.dbPath,
            migratesDatabase: prepared.migratesDatabase,
          })
          .pipe(
            Effect.mapError((error) =>
              failWith(
                error._tag === "ServiceLauncherRejectedError"
                  ? error.reason
                  : "Could not ask the service launcher to activate the prepared update.",
                error,
              ),
            ),
            Effect.tap(() =>
              holdDrainAfterHandoff(prepared.targetVersion).pipe(
                Effect.andThen(onHandoffAccepted()),
              ),
            ),
          ),
      );

      yield* Effect.logInfo("Server update prepared; handing off to the service launcher.", {
        updateId,
        targetVersion: prepared.targetVersion,
        runtimePath: prepared.runtimePath,
      });
      return { targetVersion: prepared.targetVersion, method: "boot-service" as const, updateId };
    },
  );

  const validateBootServiceInput = Effect.fn("cloud.server_self_update.validate_boot_service")(
    function* (input: ServerSelfUpdateInput) {
      const policyRefusal = managedUpdateRefusal(
        policy.document,
        capability === "boot-service" ? cliReleaseChannelOf(input.targetVersion.trim()) : undefined,
      );
      if (policyRefusal !== undefined) {
        return yield* failWith(policyRefusal);
      }
      if (capability === "desktop-managed") {
        return yield* failWith(
          "This server is managed by the T3.CodeShip desktop app on its machine; update the desktop app to update it.",
        );
      }
      if (capability === null) {
        return yield* failWith(
          "Remote updates require the T3.CodeShip background service. Run `t3 service install` on the server machine.",
        );
      }
      const unsafeCrossing = crossesTrackUnsafely(input);
      if (unsafeCrossing !== null) return yield* failWith(unsafeCrossing);
      const targetVersion = input.targetVersion.trim();
      if (!isExactServiceVersion(targetVersion)) {
        return yield* failWith(`'${targetVersion}' is not an exact t3 version.`);
      }
      return targetVersion;
    },
  );

  const prepare: ServerSelfUpdate["Service"]["prepare"] = Effect.fn(
    "cloud.server_self_update.prepare",
  )(function* (input, reportProgress = () => Effect.void) {
    const targetVersion = yield* validateBootServiceInput(input);
    if (yield* Ref.getAndSet(inFlight, true)) {
      return yield* failWith("A server update is already in progress.");
    }
    return yield* Effect.gen(function* () {
      const cached = yield* cachedPreparedFor(targetVersion);
      if (cached !== undefined) return cached;
      return yield* stageBootServiceRuntime(targetVersion, reportProgress);
    }).pipe(Effect.ensuring(Ref.set(inFlight, false)));
  });

  const activatePrepared: ServerSelfUpdate["Service"]["activatePrepared"] = Effect.fn(
    "cloud.server_self_update.activate_prepared",
  )(function* (
    prepared,
    reportProgress = () => Effect.void,
    onHandoffAccepted = () => Effect.void,
    beforeHandoff = () => Effect.void,
  ) {
    const policyRefusal = managedUpdateRefusal(
      policy.document,
      capability === "boot-service" ? cliReleaseChannelOf(prepared.targetVersion) : undefined,
    );
    if (policyRefusal !== undefined) {
      return yield* failWith(policyRefusal);
    }
    if (capability !== "boot-service") {
      return yield* failWith(
        capability === "desktop-managed"
          ? "This server is managed by the T3.CodeShip desktop app on its machine; update the desktop app to update it."
          : "Remote updates require the T3.CodeShip background service. Run `t3 service install` on the server machine.",
      );
    }
    if (yield* Ref.getAndSet(inFlight, true)) {
      return yield* failWith("A server update is already in progress.");
    }
    return yield* Effect.gen(function* () {
      const cached = yield* cachedPreparedFor(prepared.targetVersion);
      const ready =
        cached ?? (yield* stageBootServiceRuntime(prepared.targetVersion, reportProgress));
      return yield* handoffBootServiceRuntime(
        ready,
        reportProgress,
        onHandoffAccepted,
        beforeHandoff,
      );
    }).pipe(Effect.onError(() => Ref.set(inFlight, false)));
  });

  const update: ServerSelfUpdate["Service"]["update"] = Effect.fn(
    "cloud.server_self_update.update",
  )(function* (
    input,
    reportProgress = () => Effect.void,
    onHandoffAccepted = () => Effect.void,
    beforeHandoff,
  ) {
    const policyRefusal = managedUpdateRefusal(
      policy.document,
      capability === "boot-service" ? cliReleaseChannelOf(input.targetVersion.trim()) : undefined,
    );
    if (policyRefusal !== undefined) {
      return yield* failWith(policyRefusal);
    }
    if (capability === "desktop-managed") {
      const unsafeCrossing = input.channel === undefined ? null : crossesTrackUnsafely(input);
      if (unsafeCrossing !== null) return yield* failWith(unsafeCrossing);
      if (desktopAppUpdate.available) {
        const prepared = yield* desktopAppUpdate.run(
          reportProgress,
          input.channel !== undefined
            ? { channel: input.channel, targetVersion: input.targetVersion }
            : beforeHandoff !== undefined
              ? { minimumVersion: input.targetVersion }
              : undefined,
        );
        if (beforeHandoff === undefined || prepared.desktopUpdateToken === undefined) {
          return prepared;
        }
        const token = prepared.desktopUpdateToken;
        return yield* beforeHandoff().pipe(
          Effect.andThen(
            commitDesktopWithDrainHold(token, prepared.targetVersion, onHandoffAccepted),
          ),
          Effect.onError(() => desktopAppUpdate.cancel(token)),
        );
      }
      return yield* failWith(
        "This server is managed by the T3.CodeShip desktop app on its machine; update the desktop app to update it.",
      );
    }
    if (capability === null) {
      return yield* failWith(
        "Remote updates require the T3.CodeShip background service. Run `t3 service install` on the server machine.",
      );
    }

    const unsafeCrossing = crossesTrackUnsafely(input);
    if (unsafeCrossing !== null) return yield* failWith(unsafeCrossing);
    const targetVersion = input.targetVersion.trim();
    if (!isExactServiceVersion(targetVersion)) {
      return yield* failWith(`'${targetVersion}' is not an exact t3 version.`);
    }
    if (yield* Ref.getAndSet(inFlight, true)) {
      return yield* failWith("A server update is already in progress.");
    }

    return yield* Effect.gen(function* () {
      const prepared = yield* stageBootServiceRuntime(targetVersion, reportProgress);
      return yield* handoffBootServiceRuntime(
        prepared,
        reportProgress,
        onHandoffAccepted,
        beforeHandoff,
      );
    }).pipe(Effect.onError(() => Ref.set(inFlight, false)));
  });

  return ServerSelfUpdate.of({
    prepare,
    activatePrepared,
    update,
    notAppliedDesktopVersion: desktopAppUpdate.available
      ? desktopAppUpdate.notAppliedVersion
      : Effect.undefined,
    commitDesktopUpdate: Effect.fn("ServerSelfUpdate.commitDesktopUpdate")(
      function (requestId, onHandoffAccepted) {
        return commitDesktopWithDrainHold(requestId, undefined, onHandoffAccepted);
      },
    ),
  });
});

export const layer = Layer.effect(ServerSelfUpdate, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);

// The update outlives client sockets; progress offers to a closed queue are ignored.
export const updateProgressStream = (
  selfUpdate: ServerSelfUpdate["Service"],
  input: ServerSelfUpdateInput,
) =>
  Stream.callback<ServerSelfUpdateProgressEvent, ServerSelfUpdateError>((queue) => {
    const offer = (event: ServerSelfUpdateProgressEvent) =>
      Queue.offer(queue, event).pipe(Effect.ignore);

    return selfUpdate
      .update(input, (stage) => offer({ type: "progress", stage }))
      .pipe(
        Effect.flatMap((result) => offer({ type: "complete", result })),
        Effect.catchTags({
          ServerSelfUpdateError: (error) => Queue.fail(queue, error).pipe(Effect.ignore),
        }),
        Effect.andThen(Queue.end(queue).pipe(Effect.ignore)),
        Effect.forkDetach,
      );
  });
