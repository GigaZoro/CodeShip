import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  AntigravitySettings,
  ProviderDriverKind,
  ProviderSetupError,
  RuntimeMode,
  ServerProviderUpdateError,
  settingsSecretLiteral,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  NodeRuntimeUnavailableError,
  nodeRuntimeUnavailableMessage,
} from "@t3tools/shared/nodeRuntime";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  isAntigravityTextGenerationAvailable,
  makeAntigravityTextGeneration,
} from "../../textGeneration/AntigravityTextGeneration.ts";
import { makeAntigravityAuth, type AntigravityAuth } from "../AntigravityAuth.ts";
import * as AntigravityInstallation from "../AntigravityInstallation.ts";
import { brokenRuntimeError } from "../providerCompatibility.ts";
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
  isQualifiedAntigravityRelease,
  makeAntigravityAcpRuntime,
  type AntigravityAcpRuntimeInput,
  antigravityServesT3Code,
  antigravitySessionMode,
  OPEN_MODEL_ACCESS_RELEASE,
} from "../acp/AntigravityAcpSupport.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import {
  removeAntigravitySessionFiles,
  retireAntigravityRuntimeTempDirs,
} from "../acp/AntigravitySessionFiles.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  makeAntigravityAdapterV2,
  type AntigravityAdapterV2RuntimeInput,
} from "../../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { ProviderDriverError } from "../Errors.ts";
import { makeAntigravityProvider } from "../AntigravityProvider.ts";
import {
  readAntigravityAcpQuota,
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
const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);
const isProviderSetupError = Schema.is(ProviderSetupError);
const isAcpErrorDetails = Schema.is(Schema.Struct({ details: Schema.String }));
const RememberedRuntimeModes = Schema.fromJsonString(
  Schema.Struct({ authMethod: Schema.String, modes: Schema.Array(RuntimeMode) }),
);
const decodeRememberedRuntimeModes = Schema.decodeUnknownOption(RememberedRuntimeModes);
const encodeRememberedRuntimeModes = Schema.encodeSync(RememberedRuntimeModes);
const REFRESH_FAILED =
  "Could not refresh Antigravity models. The previous model list is unchanged.";
const PYTHON_SOCKS_REQUIRED = "python-socks is required to use a SOCKS proxy";

// Keep upstream diagnostics in cause; only recognized, fixed text reaches clients.
function refreshFailureDetail(cause: unknown) {
  return isAcpRequestError(cause) &&
    cause.operation === "receive-response" &&
    isAcpErrorDetails(cause.data) &&
    cause.data.details.includes(PYTHON_SOCKS_REQUIRED)
    ? `${REFRESH_FAILED} Antigravity reported: ${PYTHON_SOCKS_REQUIRED}`
    : REFRESH_FAILED;
}

export type AntigravityDriverEnv =
  | AntigravityInstallation.AntigravityInstallation
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Digest.Digest
  | SecureRandom.SecureRandom
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
    const digest = yield* Digest.Digest;
    const random = yield* SecureRandom.SecureRandom;
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
      // The instance registry has already read a referenced key from its secret provider.
      apiKey: settingsSecretLiteral(settings.apiKey),
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
      Effect.provideService(Digest.Digest, digest),
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
    // Only a session reports whether agy offers Auto, so keep the last answer across restarts.
    const runtimeModesPath = path.join(directories.profile, "t3-runtime-modes.json");
    const rememberedRuntimeModes = yield* fileSystem.readFileString(runtimeModesPath).pipe(
      Effect.map((contents) =>
        decodeRememberedRuntimeModes(contents).pipe(
          Option.filter((saved) => saved.authMethod === auth.authMethod),
          Option.map((saved) => saved.modes),
          Option.getOrUndefined,
        ),
      ),
      Effect.orElseSucceed(() => undefined),
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

    const prepareSpawn = Effect.fn("AntigravityDriver.prepareSpawn")(function* (
      cwd: string,
      baseEnv: NodeJS.ProcessEnv,
      profileDirectory = profiles.active,
      quotaOnly = false,
    ): Effect.fn.Return<
      {
        readonly executable: AntigravityInstallation.AntigravityExecutable;
        readonly spawn: AcpSessionRuntime.AcpSpawnInput;
      },
      AcpErrors.AcpError | ProviderSetupError,
      Scope.Scope
    > {
      if (authConfigIssue !== null) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "configure",
          detail: authConfigIssue,
          retryable: false,
        });
      }
      const executable = yield* installation.acquire(settings.binaryPath, processEnvironment).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderSetupError({
              instanceId,
              operation: "resolve",
              detail: cause.detail,
              retryable: false,
              cause,
            }),
        ),
      );
      if (
        quotaOnly &&
        (executable.source !== "managed" || !isQualifiedAntigravityRelease(executable.version))
      ) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "resolve",
          detail: "This Antigravity runtime does not support quota checks.",
          retryable: false,
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
                retryable: false,
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
      return {
        executable,
        spawn: buildAntigravityAcpSpawnInput({
          installation: executable,
          profile,
          cwd,
          baseEnv,
          auth,
          runtimeTempDirectory,
        }),
      };
    });

    const makeRuntime = Effect.fn("AntigravityDriver.makeRuntime")(function* (
      input: AntigravityAdapterV2RuntimeInput,
      profileDirectory = profiles.active,
      quotaOnly = false,
    ): Effect.fn.Return<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      AcpErrors.AcpError | ProviderSetupError,
      Scope.Scope
    > {
      // `buildAntigravityAcpSpawnInput` sets `extendEnv: false`, so thread variables only reach the
      // agent's shell through `baseEnv`.
      const { processEnvironment: threadEnvironment, ...runtimeInput } = input;
      const { executable, spawn } = yield* prepareSpawn(
        runtimeInput.cwd,
        threadEnvironment === undefined
          ? processEnvironment
          : { ...processEnvironment, ...threadEnvironment },
        profileDirectory,
        quotaOnly,
      );
      const runtime = yield* makeAntigravityAcpRuntime({
        ...runtimeInput,
        authMethod: auth.authMethod,
        childProcessSpawner: spawner,
        spawn,
      }).pipe(Effect.provideService(SecureRandom.SecureRandom, random));
      // A custom or PATH executable has no version until it answers initialize.
      const startCompatible = Effect.fn("AntigravityDriver.startCompatible")(function* () {
        const version = (yield* runtime.initialize()).agentInfo?.version;
        const advisory = version ? yield* installation.compatibility(version) : undefined;
        const action =
          executable.source === "managed"
            ? "Update it in Antigravity setup"
            : `Update the Antigravity executable at ${executable.executablePath}`;
        const refused = !version
          ? undefined
          : (brokenRuntimeError({ instanceId, name: "Antigravity", version, advisory, action }) ??
            (antigravityServesT3Code(version)
              ? undefined
              : new ProviderSetupError({
                  instanceId,
                  operation: "runtime",
                  detail: `Antigravity ${version} only serves allowlisted editors, not T3 Code. ${action} to ${OPEN_MODEL_ACCESS_RELEASE.join(".")} or newer, then retry.`,
                })));
        if (refused) {
          return yield* new AcpErrors.AcpTransportError({ detail: refused.detail, cause: refused });
        }
        return yield* runtime.start();
      });
      const notifyAuthRequired = (cause: unknown): Effect.Effect<void> =>
        !quotaOnly &&
        runtimeInput.onAuthorizationUrl === undefined &&
        isAntigravitySignInRequiredError(cause)
          ? provider.onAuthRequired
          : Effect.void;
      return {
        ...runtime,
        setMode: (modeId: string) =>
          runtime.getModeState.pipe(
            Effect.flatMap((modeState) =>
              runtime.setMode(antigravitySessionMode(modeId, modeState)),
            ),
          ),
        start: () => startCompatible().pipe(Effect.tapError(notifyAuthRequired)),
        prompt: (...args) => runtime.prompt(...args).pipe(Effect.tapError(notifyAuthRequired)),
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

    // The agy CLI ignores T3's browser helper during ACP `authenticate`, so Google sign-in runs its
    // remote-friendly `--login`, which stores the sign-in where the ACP process reads it.
    const codeLogin = Effect.fn("AntigravityDriver.codeLogin")(function* (input: {
      readonly profileDirectory?: string;
      readonly onAuthorizationUrl: (url: string) => Effect.Effect<void, AcpErrors.AcpError>;
    }) {
      if (auth.authMethod !== "oauth-personal") return undefined;
      const cwd = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3-antigravity-login-" })
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
      const { spawn } = yield* prepareSpawn(cwd, processEnvironment, input.profileDirectory);
      const failed = (detail: string, cause?: unknown) =>
        new ProviderSetupError({ instanceId, operation: "start", detail, cause });
      // Without a display it prints the link only, instead of opening a browser on this machine.
      const { DISPLAY: _display, WAYLAND_DISPLAY: _wayland, ...env } = spawn.env ?? {};
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawn.command, [...spawn.args, "--login"], {
            cwd,
            env,
            extendEnv: false,
            shell: false,
          }),
        )
        .pipe(Effect.mapError((cause) => failed("Could not start Antigravity sign-in.", cause)));
      const code = yield* Deferred.make<string>();
      yield* Stream.fromEffect(Deferred.await(code)).pipe(
        Stream.map((response) => `${response}\n`),
        Stream.encodeText,
        Stream.run(child.stdin),
        Effect.ignore,
        Effect.forkScoped,
      );
      const output = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.map((line) => line.trim()),
        Stream.runForEach((line) =>
          line.startsWith("https://accounts.google.com/")
            ? input.onAuthorizationUrl(line)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Stream.runDrain(child.stderr).pipe(Effect.ignore, Effect.forkScoped);
      return {
        submit: (response: string) => Deferred.succeed(code, response).pipe(Effect.asVoid),
        completed: Effect.gen(function* () {
          // Stdout closes when the process exits, or this fails first on an unusable link.
          yield* Fiber.join(output).pipe(
            Effect.mapError((cause) =>
              failed("Antigravity returned an invalid Google sign-in link.", cause),
            ),
          );
          const exitCode = yield* child.exitCode.pipe(
            Effect.mapError((cause) => failed("Antigravity sign-in stopped unexpectedly.", cause)),
          );
          if (Number(exitCode) !== 0) {
            return yield* failed(
              "Antigravity could not finish Google sign-in. Start sign-in again.",
            );
          }
        }),
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
      yield* authFlow.onSignedInElsewhere;
      yield* Stream.runForEach(runtime.getEvents(), (event) => {
        if (event._tag === "EventStreamBarrier") {
          return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
        }
        if (event._tag === "ConfigOptionsUpdated") {
          return provider.onConfigOptionsUpdated(event.configOptions, { fromCatalogProbe: true });
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
      codeLogin,
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
      if (installed.source !== "managed" || !isQualifiedAntigravityRelease(installed.version)) {
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
      environment: processEnvironment,
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
      ...(rememberedRuntimeModes ? { rememberedRuntimeModes } : {}),
      rememberRuntimeModes: (modes) =>
        writeFileStringAtomically({
          filePath: runtimeModesPath,
          contents: encodeRememberedRuntimeModes({ authMethod: auth.authMethod, modes }),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.catch(() => Effect.logWarning("Could not save Antigravity permission modes.")),
        ),
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
      supportsNativeGoals: provider.snapshot.getSnapshot.pipe(
        Effect.map(
          (snapshot) => snapshot.slashCommands?.some((command) => command.name === "goal") === true,
        ),
      ),
      profileDirectory: directories.profile,
      onSessionStarted: (started, cwd, session) =>
        provider
          .onSessionStarted(started, cwd, session)
          .pipe(Effect.andThen(authFlow.onSignedInElsewhere)),
      onSessionEvent: (event, cwd) => {
        if (event._tag === "ConfigOptionsUpdated") {
          return provider.onConfigOptionsUpdated(event.configOptions);
        }
        return event._tag === "AvailableCommandsUpdated"
          ? provider.onAvailableCommands(event.availableCommands, cwd)
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
                    (cause.operation === "configure" ||
                      cause.operation === "resolve" ||
                      cause.operation === "start")
                  ? cause.detail
                  : cause._tag === "AcpTransportError" &&
                      isProviderSetupError(cause.cause) &&
                      cause.cause.operation === "runtime"
                    ? cause.cause.detail
                    : refreshFailureDetail(cause),
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
          : discoverAntigravitySkills({ cwd, userHome, profileDirectory: profiles.active }).pipe(
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
