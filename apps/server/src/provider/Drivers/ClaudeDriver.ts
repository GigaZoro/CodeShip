import {
  ClaudeSettings,
  ProviderDriverKind,
  ProviderSkillError,
  ProviderSetupError,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Option from "effect/Option";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  claudeFlagSettings,
  createClaudeAdapterV2,
  type ClaudeAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  claudeProjectConfigRoot,
  claudeSettingSources,
  readClaudeLaunchArgSettings,
  readClaudeSettingsEnvironment,
} from "./ClaudeSettingsCascade.ts";
import { ProviderDriverError } from "../Errors.ts";
import { claudeUsageReader } from "./claudeUsage.ts";
import { makeClaudeScopedLimitNames } from "../claudeUsageLimits.ts";
import * as ClaudeResetCredits from "../claudeResetCredits.ts";
import { readClaudeAutoUpdatesChannel, setClaudeSkillOverride } from "./ClaudeSkills.ts";
import {
  claudeKeychainService,
  readClaudeCredentials,
  readClaudeLoginExpiry,
} from "../claudeLoginExpiry.ts";
import { makeClaudeAuthenticationFailure } from "../claudeSignedOut.ts";
import { saveClaudeOAuthToken, withClaudeOAuthToken } from "../claudeOAuthToken.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import {
  checkClaudeProviderStatus,
  claudeWorkspaceFunding,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
  probeClaudeWorkspaceSnapshot,
  type ClaudeCapabilitiesProbe,
} from "../ClaudeProvider.ts";
import { makeCliVersionMemory } from "@t3tools/provider-core/server/cliVersionMemory";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import { resolveClaudeModelCatalog } from "../ClaudeModelCatalog.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderConfigFolder,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { findProviderInstanceEnvironmentVariable } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import {
  materializeClaudeAccountHome,
  readClaudeMcpServers,
  shareClaudeMcpServers,
} from "./ClaudeAccountHome.ts";
import * as ProviderLoginHome from "../providerLoginHome.ts";
import { makeClaudeAuth } from "./ClaudeAuth.ts";
import { runClaudeCli } from "./ClaudeExecutable.ts";
import {
  claudeRemoteMcpServerUrls,
  makeClaudeMcpSignInRenewal,
  parseClaudeMcpSignIns,
} from "./ClaudeMcpSignInRenewal.ts";
import { makeClaudeMcpManagement } from "./ClaudeMcp.ts";
import { makeClaudePluginManagement } from "./ClaudePlugins.ts";
import {
  isClaudeTermsReviewRequiredError,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  mergeClaudeInstanceEnvironment,
  mergeClaudeProcessEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { overrideEnvironment } from "@t3tools/shared/shell";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);
const MCP_SIGN_IN_RENEW_TIMEOUT = Duration.minutes(2);

const withoutUsage = (capabilities: ClaudeCapabilitiesProbe): ClaudeCapabilitiesProbe => {
  const result = { ...capabilities };
  delete result.usage;
  return result;
};

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

const CLAUDE_RELEASES_URL = "https://downloads.claude.ai/claude-code-releases";
const CLAUDE_RELEASE_LOOKUP_TIMEOUT = Duration.seconds(4);
const CLAUDE_CHANNEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CLAUDE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// `claude update` follows the autoUpdatesChannel in Claude's settings, not npm's latest tag.
const lookupClaudeChannelVersion = Effect.fn("ClaudeDriver.lookupChannelVersion")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const channel = yield* readClaudeAutoUpdatesChannel(environment);
  if (Option.isNone(channel) || !CLAUDE_CHANNEL_PATTERN.test(channel.value)) return null;
  const client = yield* HttpClient.HttpClient;
  const body = yield* client
    .execute(HttpClientRequest.get(`${CLAUDE_RELEASES_URL}/${channel.value}`))
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.timeout(CLAUDE_RELEASE_LOOKUP_TIMEOUT),
      Effect.orElseSucceed(() => ""),
    );
  const version = body.trim();
  return CLAUDE_VERSION_PATTERN.test(version) ? version : null;
});

const makeUpdateResolver = (services: {
  readonly httpClient: HttpClient.HttpClient;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) =>
  makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: "@anthropic-ai/claude-code",
    nativeUpdate: {
      args: ["update"],
      isCommandPath: isClaudeNativeCommandPath,
      lookupLatestVersion: (context) =>
        lookupClaudeChannelVersion(context.env).pipe(
          Effect.provideService(HttpClient.HttpClient, services.httpClient),
          Effect.provideService(FileSystem.FileSystem, services.fileSystem),
          Effect.provideService(Path.Path, services.path),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, services.spawner),
        ),
    },
  });

export type ClaudeDriverEnv =
  | ClaudeAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | ResetCreditCoordinator.ResetCreditCoordinator
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig
  | ServerSettingsService;

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
    // An added account without a home of its own signs in under claudeAccountHomePath.
    privateAccountHomes: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  usage: claudeUsageReader,
  create: Effect.fn("ClaudeDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverSettings = yield* ServerSettingsService;
    // The server cwd is $HOME in packaged desktop builds, and `claude`
    // wrappers that scope themselves to their cwd refuse to run there.
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const catalogService = yield* ModelCatalog.ModelCatalog;
    const modelCatalog = catalogService
      .current(DRIVER_KIND)
      .pipe(Effect.map(resolveClaudeModelCatalog));
    // An added account drops the machine's sign-in token; re-applying only the instance's own
    // entrypoint keeps it ahead of T3.CodeShip's label.
    const instanceEnv = yield* mergeClaudeInstanceEnvironment(
      instanceId,
      environment,
      yield* HostProcess.Environment,
    );
    const processEnv = yield* mergeClaudeProcessEnvironment(config, environment, instanceEnv);
    const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    // An added account signs in to its own folder unless it names one; the rest of that folder
    // links to the shared Claude folder, so every account keeps the same files and sessions.
    const configDirVariable = yield* findProviderInstanceEnvironmentVariable(
      environment,
      "CLAUDE_CONFIG_DIR",
    );
    const { sharedHome, accountHome, bindingHome, configuredHome, bindingKey } =
      yield* ProviderLoginHome.claudeBinding(
        config,
        instanceId,
        stateDir,
        processEnv,
        configDirVariable !== undefined,
      );
    const sharedConfigPath = yield* ClaudeResetCredits.claudeAccountConfigPath(
      processEnv.CLAUDE_CONFIG_DIR?.trim() ? sharedHome : undefined,
    );
    // Runs before each Claude process too, so servers added in a terminal reach every account.
    const copyMcpServers =
      accountHome === undefined
        ? Effect.void
        : shareClaudeMcpServers({ sharedConfigPath, accountHome }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );
    const prepareAccountHome =
      accountHome === undefined
        ? Effect.void
        : materializeClaudeAccountHome({ sharedHome, accountHome }).pipe(
            Effect.andThen(copyMcpServers),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );
    yield* prepareAccountHome;
    const platform = yield* HostProcess.Platform;
    const loginHomes = yield* ProviderLoginHome.make({
      driver: DRIVER_KIND,
      instanceId,
      generation: config.loginGeneration,
      bindingKey,
      select: (instance) => withClaudeOAuthToken(instance),
      discard: (home) =>
        platform !== "darwin"
          ? Effect.void
          : Effect.scoped(
              spawner
                .exitCode(
                  ChildProcess.make("security", [
                    "delete-generic-password",
                    "-s",
                    claudeKeychainService(home),
                  ]),
                )
                .pipe(
                  Effect.flatMap((code) =>
                    Number(code) === 0 || Number(code) === 44
                      ? Effect.void
                      : Effect.logWarning("Could not remove a staged Claude Keychain login."),
                  ),
                  Effect.timeout("5 seconds"),
                  Effect.ignoreCause({ log: true }),
                ),
            ),
    });
    const loginHome = loginHomes.activeHome;
    const baseConfigPath = yield* ClaudeResetCredits.claudeAccountConfigPath(configuredHome);
    const prepareLoginHome = (home: string) =>
      materializeClaudeAccountHome({ sharedHome: bindingHome, accountHome: home }).pipe(
        Effect.andThen(
          shareClaudeMcpServers({ sharedConfigPath: baseConfigPath, accountHome: home }),
        ),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    if (loginHome) yield* prepareLoginHome(loginHome);
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
      homePath: loginHome ?? accountHome ?? config.homePath,
    } satisfies ClaudeSettings;
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(
        makeUpdateResolver({ httpClient, fileSystem, path, spawner }),
        {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        },
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    );
    // Threads continue across accounts because every account shares the sessions folder.
    const continuationGroupKey = yield* makeClaudeContinuationGroupKey(config, processEnv);
    const configDir = yield* resolveClaudeHomePath(effectiveConfig, processEnv);
    // Claude's own default keeps its account config beside the folder, in ~/.claude.json.
    const ownConfigDir =
      effectiveConfig.homePath.trim() || processEnv.CLAUDE_CONFIG_DIR?.trim()
        ? configDir
        : undefined;
    const configFolder: ProviderConfigFolder =
      ownConfigDir === undefined
        ? { kind: "default" }
        : config.homePath.trim().length === 0 && configDirVariable?.sensitive
          ? { kind: "secret" }
          : { kind: "path", path: ownConfigDir };
    const accountConfigPath = yield* ClaudeResetCredits.claudeAccountConfigPath(ownConfigDir);
    const claudeEnvironment = yield* makeClaudeEnvironment(effectiveConfig, processEnv);
    // The snapshot below does not exist yet; a read finishes only once it does.
    const limitResets: ClaudeResetCredits.ClaudeLimitResets =
      yield* ClaudeResetCredits.makeClaudeLimitResets({
        accountConfigPath,
        loginKey: configDir,
        terminal: {
          binaryPath: effectiveConfig.binaryPath,
          environment: claudeEnvironment,
          cwd: path.join(stateDir, "limit-reset"),
        },
        onRead: Effect.suspend(() => snapshot.refresh).pipe(Effect.asVoid),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    const { CLAUDE_CODE_OAUTH_TOKEN: _existingToken, ...regularLoginEnvironment } = processEnv;
    const readLoginExpiry = readClaudeLoginExpiry({
      configDir,
      claudeConfigDirEnv: claudeEnvironment.CLAUDE_CONFIG_DIR,
      environment: claudeEnvironment,
      tokenMetadata: config.oauthToken,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const canLogout =
      (loginHome !== undefined || accountHome !== undefined) && config.billingKind !== "payPerUse";
    const auth = yield* makeClaudeAuth({
      instanceId,
      billingKind: config.billingKind,
      binaryPath: effectiveConfig.binaryPath,
      cwd: stateDir,
      environment: claudeEnvironment,
      configDir: bindingKey,
      prepare: loginHome ? prepareLoginHome(loginHome) : prepareAccountHome,
      canLogout,
      stageLogin: (id, instances) =>
        loginHomes.stage(id, instances).pipe(Effect.tap(({ home }) => prepareLoginHome(home))),
      saveToken: (token) =>
        saveClaudeOAuthToken(instanceId, token).pipe(
          Effect.asVoid,
          Effect.provideService(ServerSettingsService, serverSettings),
          Effect.mapError(
            () =>
              new ProviderSetupError({
                instanceId,
                operation: "save-token",
                detail: "Could not save this account's sign-in. Start sign-in again.",
              }),
          ),
        ),
      // Any other failure is left to the status check that ends every sign-in.
      needsTermsReview: (home) =>
        probeClaudeCapabilities(
          { ...effectiveConfig, homePath: home },
          { ...regularLoginEnvironment, CLAUDE_CONFIG_DIR: home },
          stateDir,
          false,
        ).pipe(
          Effect.as(false),
          Effect.catch((error) => Effect.succeed(isClaudeTermsReviewRequiredError(error))),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
    });
    const plugins = yield* makeClaudePluginManagement({
      instanceId,
      binaryPath: effectiveConfig.binaryPath,
      environment: claudeEnvironment,
      cwd: stateDir,
    });
    const mcpSignInRenewal = enabled
      ? yield* makeClaudeMcpSignInRenewal({
          storeKey: configDir,
          readSignIns: readClaudeCredentials({
            configDir,
            claudeConfigDirEnv: claudeEnvironment.CLAUDE_CONFIG_DIR,
          }).pipe(
            Effect.map((document) =>
              Option.match(document, {
                onNone: () => [],
                onSome: parseClaudeMcpSignIns,
              }),
            ),
          ),
          readConfigured: readClaudeMcpServers(accountConfigPath).pipe(
            Effect.map(claudeRemoteMcpServerUrls),
          ),
          // `claude mcp get` connects to the server, which renews its sign-in under Claude's own lock.
          renew: (serverName) =>
            runClaudeCli({
              binaryPath: effectiveConfig.binaryPath,
              args: ["mcp", "get", serverName],
              environment: claudeEnvironment,
              cwd: stateDir,
            }).pipe(
              Effect.timeout(MCP_SIGN_IN_RENEW_TIMEOUT),
              Effect.flatMap((result) =>
                result.code === 0 ? Effect.void : Effect.fail({ exitCode: result.code }),
              ),
              Effect.catch((error) =>
                Effect.logWarning("Claude could not renew an MCP sign-in.", {
                  instanceId,
                  serverName,
                  error,
                }),
              ),
            ),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        )
      : undefined;
    const ensureMcpSignInsFresh = mcpSignInRenewal?.ensureFresh ?? Effect.void;
    const mcp = yield* makeClaudeMcpManagement({
      instanceId,
      beforeSession: ensureMcpSignInsFresh,
      binaryPath: effectiveConfig.binaryPath,
      environment: claudeEnvironment,
      cwd: stateDir,
      configPath: accountConfigPath,
      // An added account's settings.json links to the shared one.
      settingsPath: path.join(sharedHome, "settings.json"),
      ...(accountHome === undefined
        ? {}
        : {
            sharedConfig: {
              // Without the account's CLAUDE_CONFIG_DIR, `claude mcp` edits the shared config.
              environment: processEnv,
              configPath: sharedConfigPath,
              copyServers: copyMcpServers,
            },
          }),
    });
    const stampBaseIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey,
    });
    const stampIdentity: typeof stampBaseIdentity = (draft) => ({
      ...stampBaseIdentity({
        ...draft,
        setup: { canInstall: false, ...draft.setup, canAuthenticate: auth.canAuthenticate },
        // The first Claude provider uses the Claude CLI's own login, which other apps share.
        auth: {
          ...draft.auth,
          canLogout,
        },
      }),
      billingKind: config.billingKind,
    });

    const scopedLimitNames = yield* makeClaudeScopedLimitNames;
    const authenticationFailure = yield* makeClaudeAuthenticationFailure(readLoginExpiry);
    // The cache and snapshot below do not exist yet; the hooks run only once they do.
    const republishAuth = Effect.suspend(() =>
      Cache.invalidateAll(capabilitiesProbeCache).pipe(
        Effect.andThen(snapshot.refresh),
        Effect.ignoreCause({ log: true }),
      ),
    );
    const orchestrationAdapter = yield* createClaudeAdapterV2(
      {
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config: { ...config, homePath: effectiveConfig.homePath },
      },
      {
        scopedLimitNames,
        // A newly reached limit is when Claude's resets matter, so it starts a read of them.
        bindUsageLimits: Effect.suspend(() => snapshot.bindUsageLimits).pipe(
          Effect.map(
            (publish) => (update) =>
              publish(update).pipe(
                Effect.andThen(snapshot.getSnapshot),
                Effect.flatMap(({ usageLimits }) =>
                  usageLimits && !usageLimits.unavailable
                    ? limitResets.current(usageLimits)
                    : Effect.void,
                ),
                Effect.asVoid,
              ),
          ),
        ),
        onAuthenticationFailed: authenticationFailure.record.pipe(Effect.andThen(republishAuth)),
        onAuthenticated: authenticationFailure.clear.pipe(
          Effect.flatMap((hadFailure) => (hadFailure ? republishAuth : Effect.void)),
        ),
        prepareHome: copyMcpServers.pipe(
          Effect.andThen(loginHome ? prepareLoginHome(loginHome) : Effect.void),
          Effect.andThen(ensureMcpSignInsFresh),
        ),
      },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Claude orchestration adapter.",
            cause,
          }),
      ),
    );
    const textGeneration = yield* makeClaudeTextGeneration(
      effectiveConfig,
      processEnv,
      modelCatalog,
    );

    // Per-instance capabilities cache: keyed on binary + resolved HOME so
    // account-specific probes never share auth metadata across instances.
    // A transient miss may reuse the last account once, but its usage windows keep their age.
    const lastGoodCapabilities = yield* Ref.make<ClaudeCapabilitiesProbe | undefined>(undefined);
    const capabilitiesProbeCache = yield* Cache.makeWith(
      () =>
        probeClaudeCapabilities(effectiveConfig, processEnv, stateDir).pipe(
          Effect.flatMap((capabilities) =>
            ClaudeResetCredits.readClaudeAccountIdentity(accountConfigPath).pipe(
              Effect.map((identity) => ({
                _tag: "fresh" as const,
                capabilities: { ...capabilities, ...identity },
              })),
            ),
          ),
          Effect.tap(({ capabilities }) => Ref.set(lastGoodCapabilities, capabilities)),
          // Pending terms are not a transient miss: every session fails until they are reviewed.
          Effect.catchIf(
            (error) => !isClaudeTermsReviewRequiredError(error),
            (error) =>
              Ref.getAndSet(lastGoodCapabilities, undefined).pipe(
                Effect.flatMap((capabilities) =>
                  capabilities === undefined
                    ? Effect.fail(error)
                    : ClaudeResetCredits.readClaudeAccountIdentity(accountConfigPath).pipe(
                        Effect.flatMap((identity) =>
                          identity.workspaceId === capabilities.workspaceId &&
                          identity.accountKey === capabilities.accountKey
                            ? Effect.succeed({
                                _tag: "fallback" as const,
                                capabilities: withoutUsage(capabilities),
                              })
                            : Effect.fail(error),
                        ),
                      ),
                ),
              ),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      {
        capacity: 1,
        timeToLive: (exit) =>
          // Only fresh usage earns the TTL; failures, fallbacks and usage-less probes retry.
          Exit.isSuccess(exit) &&
          exit.value._tag === "fresh" &&
          exit.value.capabilities.usage !== undefined
            ? CAPABILITIES_PROBE_TTL
            : Duration.zero,
      },
    );
    const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(
      effectiveConfig,
      stateDir,
      processEnv,
    );
    const resolveCapabilities = Cache.get(capabilitiesProbeCache, capabilitiesCacheKey).pipe(
      Effect.map((result) => result.capabilities),
    );

    const versionMemory = yield* makeCliVersionMemory({ instanceId, driver: DRIVER_KIND });
    const checkProvider = catalogService.refreshInBackground.pipe(
      Effect.andThen(
        modelCatalog.pipe(
          Effect.flatMap((catalog) =>
            versionMemory.check((lastKnownVersion) =>
              checkClaudeProviderStatus(
                effectiveConfig,
                () => resolveCapabilities,
                processEnv,
                stateDir,
                catalog,
                scopedLimitNames,
                limitResets.current,
                readLoginExpiry,
                lastKnownVersion,
              ),
            ),
          ),
          Effect.tap((provider) =>
            provider.auth.status === "unauthenticated"
              ? Cache.invalidateAll(capabilitiesProbeCache)
              : Effect.void,
          ),
          Effect.map(stampIdentity),
          Effect.flatMap(authenticationFailure.apply),
        ),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClaudeSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        modelCatalog.pipe(
          Effect.flatMap((catalog) => makePendingClaudeProvider(settings.provider, catalog)),
          Effect.map(stampIdentity),
        ),
      checkProvider,
      invalidateUsageCache: Cache.invalidateAll(capabilitiesProbeCache),
      enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
            cause,
          }),
      ),
    );

    yield* auth.controller.subscribe("claude-account-snapshot").pipe(
      Stream.filter((state) => ["idle", "succeeded", "failed", "cancelled"].includes(state.phase)),
      Stream.runForEach((state) =>
        // A sign-in through T3.CodeShip ends the failure; one that failed or was cancelled leaves it.
        (state.phase === "succeeded" ? authenticationFailure.clear : Effect.void).pipe(
          Effect.andThen(Cache.invalidateAll(capabilitiesProbeCache)),
          Effect.andThen(snapshot.refresh),
          Effect.ignoreCause({ log: true }),
        ),
      ),
      Effect.forkScoped,
    );

    const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = Effect.fn(
      "ClaudeDriver.consumeResetCredit",
    )(
      function* (request) {
        const forAccount =
          request?.accountKey ?? (yield* snapshot.getSnapshot).usageLimits?.accountKey;
        return yield* ResetCreditCoordinator.redeemThenReadUsage({
          redeem: limitResets.claim(forAccount, request?.kind),
          readUsage: snapshot.refreshAfterRedemption,
          usedNothing: (error) =>
            error._tag === "ClaudeLimitResetError" &&
            (error.reason === "unavailable" || error.reason === "accountChanged"),
          provider: "Claude",
        });
      },
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail:
              cause._tag === "ClaudeLimitResetError"
                ? cause.message
                : "Claude could not use the reset.",
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity: {
        ...fallbackContinuationIdentity,
        continuationKey: continuationGroupKey,
      },
      displayName,
      accentColor,
      enabled,
      auth: auth.controller,
      plugins,
      configFolder,
      personalSkillsDirectory: path.join(configDir, "skills"),
      setSkillEnabled: ({ name, enabled }) =>
        // Plugin skills (`plugin:name`) follow their plugin, which has no per-skill override.
        name.includes(":")
          ? Effect.fail(
              new ProviderSkillError({
                operation: "setEnabled",
                instanceId,
                reason: "unsupported",
              }),
            )
          : setClaudeSkillOverride({ configDir, name, enabled }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.tapError((cause) =>
                Effect.logWarning("Claude skill override write failed", { instanceId, cause }),
              ),
              Effect.mapError(
                () =>
                  new ProviderSkillError({ operation: "setEnabled", instanceId, reason: "failed" }),
              ),
            ),
      mcp,
      // Claude Code starts with this account's variables and sets its settings' `env` in its own
      // environment, which its shell commands inherit.
      shellEnvironment: (cwd, inherited, modelSelection) =>
        readClaudeLaunchArgSettings({ settings: effectiveConfig, cwd, fileSystem, path }).pipe(
          Effect.flatMap((launchArgSettings) =>
            readClaudeSettingsEnvironment({
              homePath: configDir,
              environment: processEnv,
              cwd,
              settingSources: claudeSettingSources(effectiveConfig),
              projectConfigRoot: claudeProjectConfigRoot(effectiveConfig),
              flagSettings: claudeFlagSettings({
                launchArgSettings,
                modelSelection,
                settings: effectiveConfig,
              }),
              fileSystem,
              path,
            }),
          ),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: cause.message,
                cause,
              }),
          ),
          Effect.flatMap(({ environment: settingsEnvironment, unreadablePolicy }) =>
            unreadablePolicy !== undefined
              ? Effect.fail(
                  new ProviderDriverError({
                    driver: DRIVER_KIND,
                    instanceId,
                    detail: unreadablePolicy,
                  }),
                )
              : Effect.all([
                  mergeClaudeInstanceEnvironment(instanceId, environment, inherited),
                  HostProcess.Platform,
                ]).pipe(
                  Effect.map(([launched, platform]) =>
                    overrideEnvironment(launched, settingsEnvironment, platform),
                  ),
                ),
          ),
        ),
      snapshot,
      invalidateCaches: Cache.invalidateAll(capabilitiesProbeCache),
      fundingForWorkspace: Effect.fn("ClaudeDriver.fundingForWorkspace")(
        function* (input) {
          const readIdentity = ClaudeResetCredits.readClaudeAccountIdentity(accountConfigPath);
          const identity = yield* readIdentity;
          if (
            identity.workspaceId !== input.provider.auth.workspaceId ||
            identity.accountKey !== input.provider.usageLimits?.accountKey
          )
            return "unknown" as const;
          const funding = yield* claudeWorkspaceFunding(effectiveConfig, processEnv, input);
          const after = yield* readIdentity;
          return after.workspaceId === identity.workspaceId &&
            after.accountKey === identity.accountKey
            ? funding
            : ("unknown" as const);
        },
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
      snapshotForCwd: (cwd: string) =>
        snapshot.getSnapshot.pipe(
          Effect.flatMap((machineSnapshot) =>
            probeClaudeWorkspaceSnapshot(effectiveConfig, machineSnapshot, cwd, processEnv),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      orchestrationAdapter,
      textGeneration,
      consumeResetCredit,
    } satisfies ProviderInstance;
  }),
};
