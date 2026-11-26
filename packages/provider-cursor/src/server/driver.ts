import {
  ProviderDriverKind,
  ProviderSetupError,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
} from "@t3tools/contracts";
import { CursorSettings } from "../settings.ts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import { readCursorUsageLimits } from "./usageLimits.ts";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makeCursorTextGeneration } from "./textGeneration.ts";
import { makeCursorAdapterV2, type CursorAdapterV2DriverEnv } from "./adapter.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { buildInitialCursorProviderSnapshot, checkCursorProviderStatus } from "./status.ts";
import * as CursorSdkCatalog from "./CursorSdkCatalog.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { haveProviderSnapshotSettingsChanged } from "@t3tools/provider-core/server/snapshotSettings";
import { probeCursorSkills } from "./skills.ts";
import { makeCursorAuth } from "./auth.ts";
import * as CursorCredentialStore from "./credentialStore.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";
import * as CursorKeychain from "./CursorKeychain.ts";
import * as CursorUsageAccounts from "./CursorUsageAccounts.ts";
import { CURSOR_ACCOUNT_TTL_MS, type CursorCredentialSource } from "./accountCache.ts";
import { checkCursorHistoryAccess } from "./accountUsage.ts";

const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const isSdkRunnerError = Schema.is(CursorAgentSdk.CursorAgentSdkRunnerError);

const DRIVER_KIND = ProviderDriverKind.make("cursor");
const HISTORY_ACCESS_TTL_NANOS = BigInt(CURSOR_ACCOUNT_TTL_MS) * 1_000_000n;
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type CursorDriverEnv =
  | CursorAdapterV2DriverEnv
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | CursorSdk.CursorSdk
  | ProviderHost.ProviderHost
  | CursorKeychain.CursorKeychain;

export const CursorDriver: ProviderDriver<
  CursorSettings,
  CursorDriverEnv,
  CursorUsageAccounts.CursorUsageAccounts
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Cursor",
    supportsMultipleInstances: true,
    // Every instance keeps its sign-in in its own credential store, keyed by instance id.
    privateAccountHomes: true,
  },
  configSchema: CursorSettings,
  defaultConfig: (): CursorSettings => decodeCursorSettings({}),
  usage: {
    kind: "scan",
    provider: "cursor",
    scan: ({ settings, windowStartMs, retentionCutoffMs, awaitRefresh }) =>
      CursorUsageAccounts.CursorUsageAccounts.pipe(
        Effect.flatMap((accounts) =>
          accounts.scan({
            keychainUsageEnabled: settings.cursorKeychainUsageEnabled,
            windowStartMs,
            retentionCutoffMs,
            awaitRefresh,
          }),
        ),
      ),
  },
  create: Effect.fn("CursorDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const host = yield* ProviderHost.ProviderHost;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const keychain = yield* CursorKeychain.CursorKeychain;
    const sdkRunner = yield* CursorAgentSdk.CursorAgentSdkRunner;
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const platform = yield* HostProcess.Platform;
    const hostEnvironment = yield* HostProcess.Environment;
    const home = yield* HostProcess.HomeDirectory;
    const resolveHistorySource = (keychainUsageEnabled: boolean) =>
      CursorUsageAccounts.resolveCursorHistorySource({
        platform,
        environment: hostEnvironment,
        home,
        keychainUsageEnabled,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    const historyCredentialKey = (credential: CursorCredentialSource) =>
      typeof credential === "string" ? credential : "keychain";
    // The last verdict cursor.com gave, kept apart from the status check so a status publish
    // never waits on cursor.com and a transient failure does not withdraw verified access.
    let historyAccess:
      | {
          readonly credentialKey: string;
          readonly reading: boolean;
          readonly checkedAtNanos: bigint;
        }
      | undefined;
    const historyState = (source: CursorUsageAccounts.CursorHistorySource) => {
      if (source.state === "keychainOff") return "keychainOff" as const;
      if (source.state !== "source") return "unavailable" as const;
      return historyAccess?.credentialKey === historyCredentialKey(source.credential) &&
        historyAccess.reading
        ? ("reading" as const)
        : ("unavailable" as const);
    };
    const readHistoryState = Effect.fn("CursorDriver.readHistoryState")(function* (
      keychainUsageEnabled: boolean,
    ) {
      if (!enabled) return "unavailable" as const;
      return historyState(yield* resolveHistorySource(keychainUsageEnabled));
    });
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: displayName ?? "Cursor",
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies CursorSettings;
    const credentials = yield* CursorCredentialStore.makeCursorCredentialStore(
      instanceId,
      path.join(
        host.paths.stateDir,
        "provider-auth",
        encodeURIComponent(instanceId),
        "cursor.json",
      ),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Could not open the Cursor credential store.",
            cause,
          }),
      ),
    );
    const auth = yield* makeCursorAuth({
      instanceId,
      displayName: displayName ?? "Cursor",
      enabled,
      ...(processEnv.CURSOR_API_KEY ? { apiKey: processEnv.CURSOR_API_KEY } : {}),
      store: credentials.store,
      credentialBinding: credentials.binding,
      verify: (apiKey) =>
        checkCursorProviderStatus(
          effectiveConfig,
          { ...processEnv, CURSOR_API_KEY: apiKey },
          "browser",
        ).pipe(
          Effect.provide(CursorSdkCatalog.layer),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.flatMap((provider) =>
            provider.auth.status === "authenticated"
              ? Effect.void
              : Effect.fail(
                  new ProviderSetupError({
                    instanceId,
                    operation: "start",
                    detail: provider.message ?? "Could not verify the Cursor sign-in. Try again.",
                  }),
                ),
          ),
        ),
      onChanged: (): Effect.Effect<void> => snapshot.refresh.pipe(Effect.asVoid),
    });
    const stampSnapshot = (
      draft: Parameters<typeof stampIdentity>[0],
      cursorAccountHistory: NonNullable<ServerProvider["cursorAccountHistory"]>,
    ) =>
      stampIdentity({
        ...draft,
        cursorAccountHistory,
        setup: { canAuthenticate: !auth.usesApiKey, canInstall: false },
        auth: {
          ...draft.auth,
          canLogout: !auth.usesApiKey,
        },
      });

    let catalogModels: ReadonlyArray<ServerProviderModel> = [];
    const orchestrationAdapter = yield* makeCursorAdapterV2({
      instanceId,
      environment: processEnv,
      getModels: () => catalogModels,
    }).pipe(
      Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
        ...sdkRunner,
        open: (input) =>
          auth.requireApiKey.pipe(
            Effect.flatMap((apiKey) =>
              Effect.acquireRelease(
                sdkRunner
                  .open({ ...input, options: { ...input.options, apiKey } })
                  .pipe(
                    Effect.flatMap((session) =>
                      Effect.cached(session.close).pipe(
                        Effect.map((close) => ({ ...session, close })),
                      ),
                    ),
                  ),
                (session) => session.close.pipe(Effect.ignore),
              ),
            ),
            auth.withAccess,
            Effect.mapError((cause) =>
              isSdkRunnerError(cause)
                ? cause
                : new CursorAgentSdk.CursorAgentSdkRunnerError({ method: "open", cause }),
            ),
          ),
      }),
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Cursor orchestration adapter.",
            cause,
          }),
      ),
    );
    const textGeneration = yield* makeCursorTextGeneration(
      effectiveConfig,
      processEnv,
      auth.requireApiKey,
      auth.withAccess,
    );

    const checkProvider = host.settings.get.pipe(
      Effect.flatMap((settings) =>
        auth.readApiKey.pipe(
          Effect.orElseSucceed(() => undefined),
          Effect.flatMap((apiKey) =>
            checkCursorProviderStatus(
              effectiveConfig,
              {
                ...processEnv,
                CURSOR_API_KEY: apiKey,
              },
              auth.usesApiKey ? "api-key" : "browser",
            ).pipe(
              Effect.filterOrElse(
                (snapshot) =>
                  !(
                    effectiveConfig.enabled &&
                    snapshot.installed &&
                    snapshot.auth.status === "authenticated"
                  ),
                (snapshot) =>
                  readCursorUsageLimits(
                    effectiveConfig,
                    { ...processEnv, CURSOR_API_KEY: apiKey },
                    settings.cursorKeychainUsageEnabled,
                  ).pipe(Effect.map((usageLimits) => ({ ...snapshot, usageLimits }))),
              ),
            ),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(CursorKeychain.CursorKeychain, keychain),
          Effect.flatMap((draft) =>
            readHistoryState(settings.cursorKeychainUsageEnabled).pipe(
              Effect.map((history) => stampSnapshot(draft, history)),
            ),
          ),
          Effect.tap((provider) =>
            Effect.sync(() => {
              // A failed check lists only custom models, so keep the last loaded catalog.
              if (provider.models.some((model) => !model.isCustom)) {
                catalogModels = provider.models;
              }
            }),
          ),
          Effect.provide(CursorSdkCatalog.layer),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
      ),
    );

    const snapshotSettings = (settings: ServerSettings) => ({
      provider: effectiveConfig,
      enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
      cursorKeychainUsageEnabled: settings.cursorKeychainUsageEnabled,
    });
    const snapshot = yield* makeManagedServerProvider<ReturnType<typeof snapshotSettings>>({
      readsUsageOnRefresh: true,
      resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
      getSettings: host.settings.get.pipe(Effect.map(snapshotSettings)),
      streamSettings: host.settings.changes.pipe(Stream.map(snapshotSettings)),
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialCursorProviderSnapshot(settings.provider).pipe(
          Effect.map((draft) => stampSnapshot(draft, "unavailable")),
        ),
      checkProvider,
      enrichSnapshot: Effect.fn("CursorDriver.checkHistoryAccess")(function* ({
        settings,
        snapshot,
        publishSnapshot,
      }) {
        const source = yield* resolveHistorySource(settings.cursorKeychainUsageEnabled);
        if (source.state === "source") {
          const credentialKey = historyCredentialKey(source.credential);
          const nowNanos = yield* Clock.monotonicTimeNanos;
          if (
            historyAccess?.credentialKey !== credentialKey ||
            nowNanos - historyAccess.checkedAtNanos >= HISTORY_ACCESS_TTL_NANOS
          ) {
            yield* checkCursorHistoryAccess(
              typeof source.credential === "string" ? source.credential : keychain,
            ).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.matchEffect({
                onSuccess: (reading) =>
                  Effect.sync(() => {
                    historyAccess = { credentialKey, reading, checkedAtNanos: nowNanos };
                  }),
                onFailure: (error) =>
                  Effect.logWarning(
                    "Cursor account history check failed; keeping the last result.",
                    {
                      reason: error.reason,
                    },
                  ),
              }),
            );
          }
        }
        const cursorAccountHistory = historyState(source);
        if (cursorAccountHistory !== snapshot.cursorAccountHistory) {
          yield* publishSnapshot({ ...snapshot, cursorAccountHistory });
        }
      }),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Cursor snapshot.",
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      auth: auth.controller,
      snapshot,
      snapshotForCwd: (cwd) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              probeCursorSkills(cwd, processEnv).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: `Failed to discover Cursor skills for '${cwd}'`,
                      cause,
                    }),
                ),
              ),
            ]).pipe(Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills }))),
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
