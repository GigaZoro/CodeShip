import {
  CodexSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderSkillError,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import type * as CodexUsageHistory from "../../usage/CodexUsageHistory.ts";
import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  createCodexAdapterV2,
  type CodexAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ProviderDriverError } from "../Errors.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import { makeCodexConsumeResetCredit } from "../codexResetCredit.ts";
import {
  checkCodexProviderStatus,
  makePendingCodexProvider,
  probeCodexSkillsForCwd,
  runCodexCli,
  withCodexAppServerClient,
} from "../CodexProvider.ts";
import {
  privateMcpSignInArgs,
  resolveCodexLaunchArgs,
  withPrivateMcpSignIns,
} from "../codexLaunchArgs.ts";
import { makeCodexMcpManagement } from "../CodexMcp.ts";
import { makeCodexPluginManagement } from "../CodexPlugins.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import { applyCodexModelCatalog } from "../codexModelCatalog.ts";
import type { ProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import {
  codexContinuationIdentity,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
import { makeCodexCliAuth } from "./CodexCliAuth.ts";
import { codexAccountShadowHomePath } from "../CodexManagedHome.ts";
import { makeManagedCodexProvider } from "./CodexManagedProvider.ts";
import { codexUsageReader } from "./codexUsage.ts";
import * as CodexInstallation from "../CodexInstallation.ts";
import * as CodexManagedTokenBroker from "../CodexManagedTokenBroker.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const DRIVER_KIND = ProviderDriverKind.make("codex");
const CODEX_STANDALONE_HOME_PATTERN = /^(.*)\/packages\/standalone\//is;

function codexStandaloneHome(commandPath: string): string | null {
  // Slash replacement preserves indices; Unicode lowercasing can change the path length.
  const match = CODEX_STANDALONE_HOME_PATTERN.exec(commandPath.replaceAll("\\", "/"));
  if (!match) {
    return null;
  }
  const home = match[1]!;
  // Keep root separators: `C:` is drive-relative, and an empty home is not `/`.
  const isRoot = home === "" || /^[a-z]:$/i.test(home);
  return commandPath.slice(0, home.length + (isRoot ? 1 : 0));
}

// Standalone updates locate their install through CODEX_HOME. Account and auth-overlay
// homes can share an executable, so only the updater uses the executable's owning home.
function makeCodexMaintenanceResolver(sharedHomePath: string) {
  return makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: "@openai/codex",
    nativeUpdate: {
      args: ["update"],
      isCommandPath: (commandPath) => codexStandaloneHome(commandPath) !== null,
      requiresCommandPath: true,
      env: (context) => ({
        CODEX_HOME:
          codexStandaloneHome(context.realCommandPath) ??
          codexStandaloneHome(context.resolvedCommandPath) ??
          sharedHomePath,
      }),
    },
  });
}

export type CodexDriverEnv =
  | CodexAdapterV2DriverEnv
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
  | ServerSecretStore.ServerSecretStore
  | ServerEnvironment.ServerEnvironmentIdentity
  | CodexInstallation.CodexInstallation
  | CodexManagedTokenBroker.CodexManagedTokenBroker;

export const CodexDriver: ProviderDriver<
  CodexSettings,
  CodexDriverEnv,
  Path.Path | CodexUsageHistory.CodexUsageHistory
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Codex",
    supportsMultipleInstances: true,
    // An added account without a home of its own signs in under codexAccountShadowHomePath.
    privateAccountHomes: true,
  },
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => decodeCodexSettings({}),
  usage: codexUsageReader,
  create: Effect.fn("CodexDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    if (config.setupMode === "managed")
      return yield* makeManagedCodexProvider({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const resetCreditCoordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const installation = yield* CodexInstallation.CodexInstallation;
    const modelCatalog = yield* ModelCatalog.ModelCatalog;
    const currentCatalog = modelCatalog.current(DRIVER_KIND);
    const processEnv = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
    const environmentHome = processEnv.CODEX_HOME;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const hasOwnHome = config.homePath.trim() || config.shadowHomePath.trim();
    // An added account signs in to its own auth folder; the rest links to the shared Codex home.
    const homeLayout = yield* resolveCodexHomeLayout(
      hasOwnHome
        ? config
        : environmentHome?.trim()
          ? { ...config, homePath: environmentHome }
          : instanceId !== defaultInstanceIdForDriver(DRIVER_KIND)
            ? {
                ...config,
                shadowHomePath: codexAccountShadowHomePath(pathService, stateDir, instanceId),
              }
            : config,
    );
    const continuationIdentity = codexContinuationIdentity(homeLayout);
    const stampBaseIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const canLogout = homeLayout.mode === "authOverlay";
    const stampIdentity: typeof stampBaseIdentity = (draft) =>
      stampBaseIdentity({
        ...draft,
        setup: { canInstall: false, ...draft.setup, canAuthenticate: true },
        // The default instance uses the Codex CLI's own login, which a terminal shares.
        auth: { ...draft.auth, canLogout },
      });
    // An added account's MCP sign-ins stay in its own shadow home.
    const privateMcpSignIns = homeLayout.mode === "authOverlay";
    yield* materializeCodexShadowHome(homeLayout).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: cause.message,
            cause,
          }),
      ),
    );
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
      homePath: homeLayout.effectiveHomePath ?? "",
    } satisfies CodexSettings;
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(
        makeCodexMaintenanceResolver(homeLayout.sharedHomePath),
        {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        },
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      ),
    );

    const orchestrationAdapter = yield* createCodexAdapterV2(
      {
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      },
      {
        onUsageLimits: (update) => snapshot.applyUsageLimits(update),
        compatibility: installation.compatibility,
      },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Codex orchestration adapter.",
            cause,
          }),
      ),
    );

    // Kick the TTL-gated manifest refresh in the background and classify with the in-memory
    // manifest, so a slow or hung fetch never delays the provider check.
    const checkProvider = modelCatalog.refreshInBackground.pipe(
      Effect.andThen(
        Effect.zipWith(
          checkCodexProviderStatus(effectiveConfig, undefined, processEnv),
          currentCatalog,
          (draft, catalog) => stampIdentity(applyCodexModelCatalog(draft, catalog)),
          { concurrent: true },
        ),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, pathService),
    );
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CodexSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        Effect.zipWith(
          makePendingCodexProvider(settings.provider),
          currentCatalog,
          (draft, catalog) => stampIdentity(applyCodexModelCatalog(draft, catalog)),
        ),
      checkProvider,
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
            detail: `Failed to build Codex snapshot: ${cause.message ?? String(cause)}`,
            cause,
          }),
      ),
    );
    const textGeneration = yield* makeCodexTextGeneration(
      effectiveConfig,
      processEnv,
      snapshot.getSnapshot.pipe(Effect.map((value) => value.models)),
    );
    const snapshotForCwd = (cwd: string) =>
      !effectiveConfig.enabled
        ? snapshot.getSnapshot
        : Effect.all([
            snapshot.getSnapshot,
            probeCodexSkillsForCwd({
              binaryPath: effectiveConfig.binaryPath,
              homePath: effectiveConfig.homePath,
              launchArgs: resolveCodexLaunchArgs(effectiveConfig.launchArgs, processEnv),
              cwd,
              environment: processEnv,
            }).pipe(
              Effect.scoped,
              Effect.timeout("20 seconds"),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
          ]).pipe(
            Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })),
            Effect.mapError(
              (cause) =>
                new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail: `Failed to probe Codex skills for '${cwd}'`,
                  cause,
                }),
            ),
          );

    const openAppServerClient = withCodexAppServerClient({
      binaryPath: effectiveConfig.binaryPath,
      homePath: effectiveConfig.homePath,
      launchArgs: withPrivateMcpSignIns(
        resolveCodexLaunchArgs(effectiveConfig.launchArgs, processEnv),
        privateMcpSignIns,
      ),
      cwd: process.cwd(),
      environment: processEnv,
    }).pipe(
      Effect.map(({ client }) => client),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const plugins = yield* makeCodexPluginManagement({
      instanceId,
      openClient: openAppServerClient,
    });
    const mcp = yield* makeCodexMcpManagement({
      instanceId,
      openClient: openAppServerClient,
      runCli: (args) =>
        runCodexCli(
          {
            binaryPath: effectiveConfig.binaryPath,
            homePath: effectiveConfig.homePath,
            cwd: process.cwd(),
            environment: processEnv,
          },
          [...privateMcpSignInArgs(privateMcpSignIns), ...args],
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

    const auth = yield* makeCodexCliAuth({
      instanceId,
      credentialKey: `codex:home:${homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath}`,
      openClient: openAppServerClient,
      canLogout,
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    // `subscribe` replays the current state first; skipping that replay when idle keeps a rebuild
    // to one probe without losing a sign-in that settled first. A later idle is a sign-out.
    yield* auth.controller.subscribe("codex-account-snapshot").pipe(
      Stream.zipWithIndex,
      Stream.filter(
        ([state, index]) =>
          !(index === 0 && state.phase === "idle") &&
          ["idle", "succeeded", "failed", "cancelled"].includes(state.phase),
      ),
      Stream.runForEach(() => snapshot.refresh.pipe(Effect.ignoreCause({ log: true }))),
      Effect.forkScoped,
    );

    // Auth overlays use effectiveHomePath; the continuation key would conflate them with shared homes.
    const consumeResetCredit = makeCodexConsumeResetCredit({
      instanceId,
      accountHome: homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath,
      coordinator: resetCreditCoordinator,
      openClient: openAppServerClient,
      snapshot,
    });

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd,
      consumeResetCredit,
      auth: auth.controller,
      plugins,
      personalSkillsDirectory: pathService.join(
        homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath,
        "skills",
      ),
      setSkillEnabled: ({ path: skillPath, enabled }) =>
        openAppServerClient.pipe(
          Effect.flatMap((client) =>
            client.request("skills/config/write", { path: skillPath, enabled }),
          ),
          Effect.scoped,
          Effect.timeout("20 seconds"),
          Effect.asVoid,
          Effect.tapError((cause) =>
            Effect.logWarning("Codex skill toggle failed", { instanceId, cause }),
          ),
          Effect.mapError(
            () => new ProviderSkillError({ operation: "setEnabled", instanceId, reason: "failed" }),
          ),
        ),
      mcp,
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
