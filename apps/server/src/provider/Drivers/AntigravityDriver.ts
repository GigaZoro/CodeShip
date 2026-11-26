import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  AntigravitySettings,
  ProviderDriverKind,
  ProviderSetupError,
  ServerProviderUpdateError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  NodeRuntimeUnavailableError,
  nodeRuntimeUnavailableMessage,
} from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { AcpError } from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  isAntigravityTextGenerationAvailable,
  makeAntigravityTextGeneration,
} from "../../textGeneration/AntigravityTextGeneration.ts";
import { makeAntigravityAuth, type AntigravityAuth } from "../AntigravityAuth.ts";
import * as AntigravityInstallation from "../AntigravityInstallation.ts";
import * as AntigravityUsage from "./AntigravityUsage.ts";
import {
  antigravityAuthConfigIssue,
  antigravityAuthLabel,
  antigravityAuthUsesBrowser,
  buildAntigravityAcpSpawnInput,
  isAntigravitySignInRequiredError,
  makeAntigravityLoginProfiles,
  prepareAntigravityProfile,
  resolveAntigravityInstanceDirectories,
  type AntigravityAuthConfig,
} from "../antigravityAuthSupport.ts";
import {
  antigravityModelOptions,
  makeAntigravityAcpRuntime,
  type AntigravityAcpRuntimeInput,
} from "../acp/AntigravityAcpSupport.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import {
  removeAntigravitySessionFiles,
  retireAntigravityRuntimeTempDirs,
} from "../acp/AntigravitySessionFiles.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { makeAntigravityAdapterV2 } from "../../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { ProviderDriverError } from "../Errors.ts";
import { makeAntigravityProvider } from "../AntigravityProvider.ts";
import {
  readAntigravityAcpQuota,
  supportsAntigravityAcpQuota,
  unavailableAntigravityLimits,
} from "../antigravityUsageLimits.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { discoverAntigravitySkills, resolveAntigravityUserHome } from "./AntigravitySkills.ts";

const DRIVER = ProviderDriverKind.make("antigravity");
const decodeSettings = Schema.decodeSync(AntigravitySettings);
const isNodeRuntimeUnavailableError = Schema.is(NodeRuntimeUnavailableError);

export type AntigravityDriverEnv =
  | AntigravityInstallation.AntigravityInstallation
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderLatestVersions.ProviderLatestVersions
  | ProviderEventLoggers.ProviderEventLoggers;

export const AntigravityDriver: ProviderDriver<
  AntigravitySettings,
  AntigravityDriverEnv,
  AntigravityUsage.AntigravityUsage
> = {
  driverKind: DRIVER,
  // Every instance signs in to its own profile under resolveAntigravityInstanceDirectories.
  metadata: {
    displayName: "Antigravity",
    supportsMultipleInstances: true,
    privateAccountHomes: true,
  },
  configSchema: AntigravitySettings,
  defaultConfig: () => decodeSettings({}),
  usage: AntigravityUsage.antigravityUsageReader,
  create: Effect.fn("AntigravityDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const httpClient = yield* HttpClient.HttpClient;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const host = yield* ProviderHost.ProviderHost;
    const selfInvocation = yield* resolveSelfInvocation();
    const installation = yield* AntigravityInstallation.AntigravityInstallation;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const loggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const modelCatalog = yield* ModelCatalog.ModelCatalog;
    const currentCatalog = modelCatalog.current(DRIVER);
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
    const settings = { ...config, enabled } satisfies AntigravitySettings;
    const auth: AntigravityAuthConfig = {
      authMethod: settings.authMethod,
      apiKey: settings.apiKey,
      gcpProject: settings.gcpProject,
      gcpLocation: settings.gcpLocation,
    };
    const authConfigIssue = antigravityAuthConfigIssue(auth);
    const processEnvironment = yield* mergeProviderInstanceEnvironment(environment);
    const manualMaintenance = makeManualOnlyProviderMaintenanceCapabilities({
      provider: DRIVER,
      packageName: null,
    });
    const resolveMaintenance = Effect.fn("AntigravityDriver.resolveMaintenance")(function* () {
      if (!enabled || settings.binaryPath.trim()) return manualMaintenance;
      const executable = yield* installation
        .resolve(undefined, processEnvironment)
        .pipe(Effect.orElseSucceed(() => null));
      if (executable?.source !== "managed") return manualMaintenance;
      return {
        ...manualMaintenance,
        lookupLatestVersion: installation.latestVersion,
        builtInUpdate: {
          lockKey: "managed-antigravity",
          run: (version) =>
            installation.upgrade(version).pipe(
              Effect.mapError(
                (cause) =>
                  new ServerProviderUpdateError({
                    provider: DRIVER,
                    reason: cause.detail,
                    cause,
                  }),
              ),
            ),
        },
      } satisfies ProviderMaintenanceCapabilities;
    });
    const userHome = resolveAntigravityUserHome(
      yield* HostProcess.Platform,
      processEnvironment,
      yield* HostProcess.HomeDirectory,
    );
    const directories = yield* resolveAntigravityInstanceDirectories(
      host.paths.stateDir,
      instanceId,
    ).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId,
            detail: "Could not resolve the Antigravity profile directory.",
            cause,
          }),
      ),
    );
    const profiles = yield* makeAntigravityLoginProfiles(directories.profile, instanceId).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId,
            detail: "Could not read the Antigravity sign-in profile.",
            cause,
          }),
      ),
    );
    for (const directory of [
      directories.runtimeTemp,
      path.join(directories.profile, "antigravity-acp", "tmp"),
    ]) {
      const removeRetired = yield* retireAntigravityRuntimeTempDirs(directory).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      yield* Effect.forkScoped(removeRetired);
    }
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const classifyModels = (draft: ServerProviderDraft) =>
      currentCatalog.pipe(
        Effect.map((catalog) => stampIdentity(ModelCatalog.applyModelCatalog(draft, catalog))),
      );

    const makeRuntime = Effect.fn("AntigravityDriver.makeRuntime")(function* (
      input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner">,
      profileDirectory = profiles.active,
      quotaOnly = false,
    ): Effect.fn.Return<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      AcpError | ProviderSetupError,
      Scope.Scope
    > {
      if (authConfigIssue !== null) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "configure",
          detail: authConfigIssue,
        });
      }
      const executable = yield* installation.acquire(settings.binaryPath, processEnvironment).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderSetupError({
              instanceId,
              operation: "resolve",
              detail: cause.detail,
              cause,
            }),
        ),
      );
      if (
        quotaOnly &&
        (executable.source !== "managed" || !supportsAntigravityAcpQuota(executable.version))
      ) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "resolve",
          detail: "This Antigravity runtime does not support quota checks.",
        });
      }
      const profile = yield* prepareAntigravityProfile({
        profileDirectory,
        baseEnv: processEnvironment,
        auth,
        userHome,
        tempDirectory: directories.runtimeTemp,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((cause) =>
          isNodeRuntimeUnavailableError(cause.cause)
            ? new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: nodeRuntimeUnavailableMessage("Antigravity sign-in"),
                cause,
              })
            : cause,
        ),
      );
      // Use one directory per process; shared cleanup could delete files another session still reads.
      // Remove after the child dies, best-effort on Windows where handles may outlive the kill;
      // the next driver start sweeps leftovers.
      const runtimeTempDirectory = yield* Effect.acquireRelease(
        fileSystem.makeTempDirectory({ directory: profile.tempDirectory, prefix: "run-" }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: "Could not create an Antigravity runtime temp directory.",
                cause,
              }),
          ),
        ),
        (directory) =>
          fileSystem
            .remove(directory, { recursive: true, force: true })
            .pipe(
              Effect.catch(() =>
                Effect.logWarning("Could not remove an Antigravity runtime temp directory."),
              ),
            ),
      );
      const runtime = yield* makeAntigravityAcpRuntime({
        ...input,
        runtimeVersion: executable.version,
        authMethod: auth.authMethod,
        childProcessSpawner: spawner,
        spawn: buildAntigravityAcpSpawnInput({
          installation: executable,
          profile,
          cwd: input.cwd,
          baseEnv: processEnvironment,
          auth,
          runtimeTempDirectory,
        }),
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      return {
        ...runtime,
        start: () =>
          runtime
            .start()
            .pipe(
              Effect.tapError((cause): Effect.Effect<void> =>
                !quotaOnly &&
                input.onAuthorizationUrl === undefined &&
                isAntigravitySignInRequiredError(cause)
                  ? provider.onAuthRequired
                  : Effect.void,
              ),
            ),
      };
    });

    const makeDisposableRuntime = Effect.fn("AntigravityDriver.makeDisposableRuntime")(function* (
      input: Pick<AntigravityAcpRuntimeInput, "onAuthorizationUrl"> & {
        readonly profileDirectory?: string;
        readonly quotaOnly?: boolean;
      },
    ) {
      const profileDirectory = input.profileDirectory ?? profiles.active;
      const cwd = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3-antigravity-setup-" })
        .pipe(
          Effect.mapError(
            () =>
              new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: "Could not create an Antigravity setup workspace.",
              }),
          ),
        );
      let sessionId: string | undefined;
      yield* Effect.addFinalizer(() =>
        removeAntigravitySessionFiles({
          profileDirectory,
          sessionId,
          cwd,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const runtime = yield* makeRuntime(
        {
          cwd,
          mcpServers: [],
          ...(input.onAuthorizationUrl ? { onAuthorizationUrl: input.onAuthorizationUrl } : {}),
        },
        profileDirectory,
        input.quotaOnly,
      );
      return {
        ...runtime,
        start: () =>
          runtime.start().pipe(
            Effect.tap((started) =>
              Effect.sync(() => {
                sessionId = started.sessionId;
              }),
            ),
          ),
      };
    });

    const publishCatalog = Effect.fn("AntigravityDriver.publishCatalog")(function* (
      started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
      runtime: Pick<
        AcpSessionRuntime.AcpSessionRuntime["Service"],
        "getEvents" | "drainEvents" | "setModel"
      >,
    ) {
      yield* provider.onSessionStarted(started);
      yield* Stream.runForEach(runtime.getEvents(), (event) => {
        if (event._tag === "EventStreamBarrier") {
          return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
        }
        if (event._tag === "ConfigOptionsUpdated") {
          return provider.onConfigOptionsUpdated(event.configOptions);
        }
        return event._tag === "AvailableCommandsUpdated"
          ? provider.onAvailableCommands(event.availableCommands)
          : Effect.void;
      }).pipe(Effect.forkScoped);
      // Thinking levels differ per model and are reported only for the selected one.
      const configOptions = started.sessionSetupResult.configOptions ?? [];
      const current = configOptions.find((option) => option.id === "model")?.currentValue;
      if (typeof current === "string") {
        const alternatives = antigravityModelOptions(configOptions).filter(
          (entry) => entry.value !== current,
        );
        for (const model of alternatives) yield* runtime.setModel(model.value).pipe(Effect.ignore);
        if (alternatives.length > 0) yield* runtime.setModel(current).pipe(Effect.ignore);
      }
      yield* runtime.drainEvents;
    }, Effect.scoped);

    const authFlow: AntigravityAuth = yield* makeAntigravityAuth({
      instanceId,
      makeRuntime: makeDisposableRuntime,
      stage: antigravityAuthUsesBrowser(auth.authMethod) ? profiles.stage : false,
      // A new sign-in may be another account; drop any in-flight quota read first.
      onAuthenticated: (started, runtime) =>
        Effect.suspend(() => provider.onSignedIn).pipe(
          Effect.andThen(publishCatalog(started, runtime)),
        ),
      onSignedOut: Effect.suspend(() => provider.onSignedOut),
    });

    // The probe must not spawn. The agent is a PyInstaller one-file bundle
    // that unpacks about 1 GB per launch, and the health check runs every
    // minute.
    const probe = Effect.gen(function* () {
      yield* modelCatalog.refreshInBackground;
      if (authConfigIssue !== null) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "configure",
          detail: authConfigIssue,
        });
      }
      const executable = yield* installation.resolve(settings.binaryPath, processEnvironment).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderSetupError({
              instanceId,
              operation: "resolve",
              detail: cause.detail,
              cause,
            }),
        ),
      );
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: true, embeddedContext: true },
          sessionCapabilities: { list: {}, resume: {} },
        },
        authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
        agentInfo: {
          name: "antigravity-acp",
          title: "Google Antigravity",
          version: executable.version ?? "unknown",
        },
      };
    });

    const withDisposableRuntime = Effect.fn("AntigravityDriver.withDisposableRuntime")(function* <
      A,
      E,
    >(
      quotaOnly: boolean,
      use: (runtime: AcpSessionRuntime.AcpSessionRuntime["Service"]) => Effect.Effect<A, E>,
    ) {
      const processScope = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(processScope, exit));
      return yield* authFlow
        .withProcess(
          Scope.close(processScope, Exit.void),
          makeDisposableRuntime({ quotaOnly }).pipe(Effect.flatMap(use)),
        )
        .pipe(Effect.provideService(Scope.Scope, processScope));
    }, Effect.scoped);

    const readUsage = Effect.fn("AntigravityDriver.readUsage")(function* () {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      if (!antigravityAuthUsesBrowser(auth.authMethod))
        return unavailableAntigravityLimits(checkedAt, "unsupported");
      const installed = yield* installation.resolve(settings.binaryPath, processEnvironment);
      if (installed.source !== "managed" || !supportsAntigravityAcpQuota(installed.version)) {
        return unavailableAntigravityLimits(checkedAt, "unsupported");
      }
      // The managed runtime stores the active profile's login here. A probe must never initiate sign-in.
      if (
        !(yield* fileSystem.exists(path.join(profiles.active, "antigravity-acp", "acp_token.json")))
      ) {
        return unavailableAntigravityLimits(checkedAt, "unsupported");
      }
      return yield* withDisposableRuntime(true, readAntigravityAcpQuota);
    });
    // An ACP launch unpacks the runtime; repeated status refreshes share the same recent read.
    const [probeUsage, clearUsage] = yield* Effect.cachedInvalidateWithTTL(
      readUsage().pipe(
        Effect.timeout("30 seconds"),
        Effect.catch(() =>
          DateTime.now.pipe(
            Effect.map((now) =>
              unavailableAntigravityLimits(DateTime.formatIso(now), "probeFailed"),
            ),
          ),
        ),
      ),
      "5 minutes",
    );
    const provider = yield* makeAntigravityProvider(settings, {
      stampIdentity: classifyModels,
      probe,
      probeUsage: authFlow.awaitProfilePublication.pipe(Effect.andThen(probeUsage)),
      clearUsage,
      resolveMaintenance,
      enrichVersionAdvisory: (snapshot, enableProviderUpdateChecks) =>
        resolveMaintenance().pipe(
          Effect.flatMap((capabilities) =>
            enrichProviderSnapshotWithVersionAdvisory(snapshot, capabilities, {
              enableProviderUpdateChecks,
            }),
          ),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
      auth: { type: auth.authMethod, label: antigravityAuthLabel(auth.authMethod) },
      supportsTextGeneration: Effect.suspend(() =>
        isAntigravityTextGenerationAvailable(profiles.active),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.orElseSucceed(() => false),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId,
            detail: "Could not prepare the Antigravity provider status.",
            cause,
          }),
      ),
    );
    const defaultModel = currentCatalog.pipe(Effect.map((catalog) => catalog?.defaultChatModel));
    const orchestrationAdapter = yield* makeAntigravityAdapterV2({
      instanceId,
      selfInvocation,
      makeRuntime,
      withProcess: authFlow.withProcess,
      defaultModel,
      profileDirectory: directories.profile,
      onSessionStarted: provider.onSessionStarted,
      onSessionEvent: (event) => {
        if (event._tag === "ConfigOptionsUpdated") {
          return provider.onConfigOptionsUpdated(event.configOptions);
        }
        return event._tag === "AvailableCommandsUpdated"
          ? provider.onAvailableCommands(event.availableCommands)
          : Effect.void;
      },
      continuationRequests,
      nativeLogging: (threadId) =>
        makeNativeLogger({
          nativeEventLogger: loggers.native,
          provider: DRIVER,
          threadId,
        }),
    });
    const textGeneration = yield* makeAntigravityTextGeneration({
      get profileDirectory() {
        return profiles.active;
      },
      defaultModel,
      withProcess: authFlow.withProcess,
      makeRuntime: (cwd) =>
        makeRuntime({
          cwd,
          mcpServers: [],
        }),
    });

    const refreshModels = Effect.fn("AntigravityDriver.refreshModels")(
      () =>
        withDisposableRuntime(false, (runtime) =>
          runtime.start().pipe(Effect.flatMap((started) => publishCatalog(started, runtime))),
        ),
      Effect.timeoutOrElse({
        duration: "90 seconds",
        orElse: () =>
          Effect.fail(
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: "Antigravity model refresh timed out. Try again or check Google sign-in.",
            }),
          ),
      }),
      Effect.tapError((cause) =>
        isAntigravitySignInRequiredError(cause) ? provider.onAuthRequired : Effect.void,
      ),
      Effect.mapError((cause) =>
        cause._tag === "ProviderDriverError"
          ? cause
          : new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: isAntigravitySignInRequiredError(cause)
                ? "Sign in to Antigravity in provider settings before refreshing models."
                : cause._tag === "ProviderSetupError" &&
                    (cause.operation === "configure" || cause.operation === "start")
                  ? cause.detail
                  : "Could not refresh Antigravity models. The previous model list is unchanged.",
              cause,
            }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot: provider.snapshot,
      snapshotForCwd: (cwd) =>
        !enabled
          ? provider.snapshot.getSnapshot
          : discoverAntigravitySkills({ cwd, userHome }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.flatMap((skills) => provider.snapshotForCwd(cwd, skills)),
              Effect.mapError(
                (cause) =>
                  new ProviderDriverError({
                    driver: DRIVER,
                    instanceId,
                    detail: "Could not read Antigravity workspace skills.",
                    cause,
                  }),
              ),
            ),
      orchestrationAdapter,
      textGeneration,
      auth: authFlow.controller,
      refreshModels,
    } satisfies ProviderInstance;
  }),
};
