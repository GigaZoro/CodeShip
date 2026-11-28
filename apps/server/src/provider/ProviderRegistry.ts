import { isProviderWorkspaceSnapshotCurrent } from "@t3tools/contracts/provider";
import {
  ProviderInstanceId as ProviderId,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts/providerInstance";
import type { ServerProvider, ServerProviderUpdateState } from "@t3tools/contracts/server";
import { ClaudeSettings } from "@t3tools/contracts/settings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import { isAccountReady } from "@t3tools/shared/serverSettings";
import * as Schema from "effect/Schema";
import * as ServerSettings from "../serverSettings.ts";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ModelManifest from "./ModelManifest.ts";
import { applyProviderCompatibility } from "./providerCompatibility.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import {
  hydrateCachedProvider,
  isCachedProviderCorrelated,
  orderProviderSnapshots,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "./providerStatusCache.ts";
import { withSameAccountMarks } from "./providerAccounts.ts";
import * as ApiCreditBalance from "./ApiCreditBalance.ts";
import type {
  ProviderInstance,
  ProviderWorkspaceSnapshot,
} from "@t3tools/provider-core/server/driver";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
  latestProviderVersionCacheKeys,
} from "@t3tools/provider-core/server/maintenanceResolver";
import type { ProviderSnapshotSource } from "./builtInProviderCatalog.ts";

export type ProviderMaintenanceActionKind = "update";

export class ProviderRegistry extends Context.Service<
  ProviderRegistry,
  {
    readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
    readonly fundingForWorkspace?: NonNullable<ProviderInstance["fundingForWorkspace"]>;

    readonly refresh: (
      provider?: ProviderDriverKind,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /** Unknown instance ids return the cached list without error. */
    readonly refreshInstance: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /** Reads only requested, runnable accounts that still need a decisive quota observation. */
    readonly refreshUsageIfStale: (input: {
      readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
      /** Stable keys for the stale account fields or meters that would affect this decision. */
      readonly staleObservations: (provider: ServerProvider) => ReadonlyArray<string>;
      readonly waitMs: number;
    }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /** Re-reads secret-backed environments first, so a fixed secret applies without a restart. */
    readonly reloadSecretsAndRefresh: (
      instanceId?: ProviderInstanceId,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /** Only refreshed instances can verify an update; the published list still includes every row. */
    readonly refreshAfterUpdate: (
      provider: ProviderDriverKind,
      selectedInstanceId: ProviderInstanceId,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    readonly refreshWorkspaceSnapshot: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly cwd: string;
      readonly fresh?: boolean;
    }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    readonly getProviderMaintenanceCapabilitiesForInstance: (
      instanceId: ProviderInstanceId,
      provider: ProviderDriverKind,
      options?: { readonly fresh?: boolean },
    ) => Effect.Effect<ProviderMaintenanceCapabilities>;

    readonly setProviderMaintenanceActionState: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly action: ProviderMaintenanceActionKind;
      readonly state: ServerProviderUpdateState | null;
    }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;
  }
>()("t3/provider/ProviderRegistry") {}

const loadProviders = (
  providerSources: ReadonlyArray<ProviderSnapshotSource>,
): Effect.Effect<ReadonlyArray<ServerProvider>> =>
  Effect.forEach(
    providerSources,
    (providerSource) =>
      providerSource.getSnapshot.pipe(
        Effect.flatMap((snapshot) => correlateSnapshotWithSource(providerSource, snapshot)),
      ),
    {
      concurrency: "unbounded",
    },
  );

const makeManualProviderMaintenanceCapabilities = (provider: ProviderDriverKind) =>
  makeManualOnlyProviderMaintenanceCapabilities({
    provider,
    packageName: null,
  });

const hasModelCapabilities = (model: ServerProvider["models"][number]): boolean =>
  (model.capabilities?.optionDescriptors?.length ?? 0) > 0;

const MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER = 16;

function dropProviderWorkspaceSnapshot(provider: ServerProvider, cwd: string): ServerProvider {
  return provider.workspaceSnapshots?.some((snapshot) => snapshot.cwd === cwd)
    ? {
        ...provider,
        workspaceSnapshots: provider.workspaceSnapshots.filter((snapshot) => snapshot.cwd !== cwd),
      }
    : provider;
}

export function upsertProviderWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string,
  scopedSnapshot: ProviderWorkspaceSnapshot,
): ServerProvider {
  const previousSnapshot = provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
  const optionDescriptors = scopedSnapshot.optionDescriptors ?? previousSnapshot?.optionDescriptors;
  const workspaceSnapshot = {
    cwd,
    checkedAt: scopedSnapshot.checkedAt,
    slashCommands: scopedSnapshot.slashCommandsPending
      ? (previousSnapshot?.slashCommands ?? scopedSnapshot.slashCommands)
      : scopedSnapshot.slashCommands,
    ...(scopedSnapshot.slashCommandsPending ? { slashCommandsPending: true } : {}),
    skills: scopedSnapshot.skills,
    ...(optionDescriptors === undefined ? {} : { optionDescriptors }),
  } satisfies NonNullable<ServerProvider["workspaceSnapshots"]>[number];
  return {
    ...provider,
    workspaceSnapshots: [
      ...(provider.workspaceSnapshots ?? []).filter((snapshot) => snapshot.cwd !== cwd),
      workspaceSnapshot,
    ].slice(-MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER),
  };
}

const shouldRetainMissingProviderModels = (provider: ServerProvider): boolean => {
  if (provider.driver === ProviderDriverKind.make("pi")) {
    // Pi auth becomes known only after inventory discovery: empty means unauthenticated; failed/interactive discovery preserves unknown auth and cached models.
    return !(
      provider.installed &&
      (provider.status === "ready" || provider.status === "warning") &&
      provider.auth.status !== "unknown"
    );
  }

  if (provider.driver === ProviderDriverKind.make("acpRegistry")) {
    // Only completed ACP discovery provides nativeSessions and inventory; placeholder probes cannot establish auth for agents without sign-in.
    return !(
      provider.installed &&
      provider.status === "ready" &&
      provider.nativeSessions !== undefined
    );
  }

  if (provider.driver === ProviderDriverKind.make("grok")) {
    // Grok reports ready only after it discovers a model list; the pending,
    // ACP-failed, empty-inventory, and logged-out probes are warning/error.
    return !(provider.installed && provider.status === "ready");
  }

  const isAntigravity = provider.driver === ProviderDriverKind.make("antigravity");
  const isCodex = provider.driver === ProviderDriverKind.make("codex");
  if (!isAntigravity && !isCodex && provider.driver !== ProviderDriverKind.make("opencode")) {
    return true;
  }

  if (
    (isAntigravity || isCodex) &&
    (!provider.enabled || provider.auth.status === "unauthenticated")
  ) {
    return false;
  }

  // Antigravity's local health check does not authenticate or discover models.
  const isPendingAntigravityAuthentication =
    isAntigravity && provider.status === "warning" && provider.auth.status === "unknown";
  const isPendingInitialProbe =
    provider.enabled && !provider.installed && provider.status === "warning";
  const isIncompleteInstalledProbe =
    provider.installed &&
    (provider.status === "error" || (isCodex && provider.status === "warning"));
  return isPendingAntigravityAuthentication || isPendingInitialProbe || isIncompleteInstalledProbe;
};

const shouldRetainMissingOpenCodeMetadata = (provider: ServerProvider): boolean =>
  provider.driver === ProviderDriverKind.make("opencode") &&
  shouldRetainMissingProviderModels(provider);

const usageAccountIdentity = (provider: ServerProvider) => [
  provider.auth.profileId,
  provider.auth.workspaceId,
  provider.auth.email,
  provider.auth.type,
  provider.usageLimits?.accountKey,
  provider.usageLimits?.credentialFingerprint,
  provider.usageLimits?.plan,
];

const mergeProviderModels = (
  provider: ServerProvider,
  previousModels: ReadonlyArray<ServerProvider["models"][number]>,
  nextModels: ReadonlyArray<ServerProvider["models"][number]>,
  sameAccount: boolean,
): ReadonlyArray<ServerProvider["models"][number]> => {
  const shouldRetainMissingModels = shouldRetainMissingProviderModels(provider);
  const updateRequiredSlugs = new Set(provider.updateRequiredModels?.map((model) => model.slug));
  const retainablePreviousModels = previousModels
    .filter((model) => !model.isCustom && !updateRequiredSlugs.has(model.slug))
    .map((model) =>
      model.funding !== undefined ||
      provider.auth.funding === "included" ||
      provider.auth.fundingScope === "workspace"
        ? { ...model, funding: "unknown" as const }
        : model,
    );

  if (shouldRetainMissingModels && nextModels.length === 0 && retainablePreviousModels.length > 0) {
    return retainablePreviousModels;
  }

  const previousBySlug = new Map(previousModels.map((model) => [model.slug, model] as const));
  const mergedModels = nextModels.map((model) => {
    const previousModel = previousBySlug.get(model.slug);
    if (
      !sameAccount ||
      !previousModel ||
      // Antigravity returns null for an unobserved model and an empty set after observing no options.
      (provider.driver === "antigravity" && model.capabilities !== null) ||
      hasModelCapabilities(model) ||
      !hasModelCapabilities(previousModel)
    ) {
      return model;
    }
    return {
      ...model,
      capabilities: previousModel.capabilities,
    };
  });
  const nextSlugs = new Set(nextModels.map((model) => model.slug));
  return shouldRetainMissingModels
    ? [...mergedModels, ...retainablePreviousModels.filter((model) => !nextSlugs.has(model.slug))]
    : mergedModels;
};

/** Antigravity health checks only initialize; preserve previously verified Google auth across restarts. */
const carrySavedAntigravityAccount = (
  previousProvider: ServerProvider,
  nextProvider: ServerProvider,
): Pick<ServerProvider, "auth" | "status"> | undefined => {
  const antigravity = ProviderDriverKind.make("antigravity");
  if (
    nextProvider.driver !== antigravity ||
    previousProvider.driver !== antigravity ||
    !nextProvider.enabled ||
    nextProvider.auth.status !== "unknown" ||
    previousProvider.auth.status !== "authenticated" ||
    (nextProvider.auth.type !== undefined &&
      nextProvider.auth.type !== previousProvider.auth.type) ||
    (!nextProvider.installed && nextProvider.status !== "warning")
  ) {
    return undefined;
  }
  const status =
    nextProvider.installed && nextProvider.status === "warning" ? "ready" : nextProvider.status;
  const { funding: _funding, fundingScope: _scope, ...auth } = previousProvider.auth;
  return { auth, status };
};

export const mergeProviderSnapshot = (
  previousProvider: ServerProvider | undefined,
  nextProvider: ServerProvider,
): ServerProvider => {
  if (!previousProvider) {
    return nextProvider;
  }
  const savedAccount = carrySavedAntigravityAccount(previousProvider, nextProvider);
  const sameAccount = Equal.equals(
    usageAccountIdentity(previousProvider),
    usageAccountIdentity(nextProvider),
  );
  const { message: _uncheckedMessage, ...nextWithoutMessage } = nextProvider;
  return {
    ...(savedAccount?.status === "ready" ? nextWithoutMessage : nextProvider),
    ...savedAccount,
    models: mergeProviderModels(
      nextProvider,
      previousProvider.models,
      nextProvider.models,
      sameAccount,
    ),
    ...(nextProvider.workspaceSnapshots !== undefined
      ? { workspaceSnapshots: nextProvider.workspaceSnapshots }
      : sameAccount && previousProvider.workspaceSnapshots !== undefined
        ? { workspaceSnapshots: previousProvider.workspaceSnapshots }
        : {}),
    ...(shouldRetainMissingOpenCodeMetadata(nextProvider)
      ? {
          slashCommands:
            nextProvider.slashCommands.length === 0
              ? previousProvider.slashCommands
              : nextProvider.slashCommands,
          skills: nextProvider.skills.length === 0 ? previousProvider.skills : nextProvider.skills,
        }
      : {}),
  };
};

const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

const correlateSnapshotWithSource = (
  source: ProviderSnapshotSource,
  snapshot: ServerProvider,
): Effect.Effect<ServerProvider> => {
  if (snapshot.instanceId !== source.instanceId) {
    return Effect.die(
      new Error(
        `Provider snapshot instance mismatch: source '${source.instanceId}' emitted '${snapshot.instanceId}'.`,
      ),
    );
  }
  if (snapshot.driver !== source.driverKind) {
    return Effect.die(
      new Error(
        `Provider snapshot driver mismatch for instance '${source.instanceId}': source '${source.driverKind}' emitted '${snapshot.driver}'.`,
      ),
    );
  }
  if (
    !source.supportsPlugins &&
    !source.supportsMcpServers &&
    !source.supportsSkillInstall &&
    !source.supportsSkillToggle &&
    !source.sharesAddedAccounts
  ) {
    return Effect.succeed(snapshot);
  }
  return Effect.succeed({
    ...snapshot,
    ...(source.supportsPlugins ? { supportsPlugins: true } : {}),
    ...(source.supportsMcpServers ? { supportsMcpServers: true } : {}),
    ...(source.supportsSkillInstall ? { supportsSkillInstall: true } : {}),
    ...(source.supportsSkillToggle ? { supportsSkillToggle: true } : {}),
    ...(source.sharesAddedAccounts ? { sharesAddedAccounts: true } : {}),
  });
};

const snapshotInstanceKey = (provider: ServerProvider): ProviderInstanceId => {
  return provider.instanceId;
};

// Rebuilt instances have new PubSubs; capture their fresh closures instead of a closed source.
const buildSnapshotSource = (instance: ProviderInstance): ProviderSnapshotSource => ({
  instanceId: instance.instanceId,
  driverKind: instance.driverKind,
  getSnapshot: instance.snapshot.getSnapshot,
  refresh: instance.snapshot.refresh,
  streamChanges: instance.snapshot.streamChanges,
  supportsPlugins: instance.plugins !== undefined,
  supportsMcpServers: instance.mcp !== undefined,
  supportsSkillInstall: instance.personalSkillsDirectory !== undefined,
  supportsSkillToggle: instance.setSkillEnabled !== undefined,
  sharesAddedAccounts: instance.sharesAddedAccounts === true,
});

const decodeClaudeSettings = Schema.decodeOption(ClaudeSettings);

export const layer = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const instanceRegistryMutator =
      yield* ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator;
    const manifestService = yield* ModelManifest.ModelManifest;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const serviceScope = yield* Effect.scope;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const apiCredit = yield* Effect.serviceOption(ApiCreditBalance.ApiCreditBalance);
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const withBilling = Effect.fn("ProviderRegistry.withBilling")(function* (
      providers: ReadonlyArray<ServerProvider>,
    ) {
      const settings = yield* settingsService.getSettings.pipe(Effect.option);
      return yield* Effect.forEach(providers, (provider) =>
        Effect.gen(function* () {
          if (provider.driver !== "claudeAgent" || provider.billingKind !== "payPerUse")
            return provider;
          const config = Option.isSome(settings)
            ? decodeClaudeSettings(
                settings.value.providerInstances[provider.instanceId]?.config ?? {},
              )
            : Option.none();
          let reason: string | undefined;
          if (Option.isNone(config))
            reason = "Could not read this Claude API credit configuration.";
          else {
            const value = config.value;
            const linked = providers.find(
              (candidate) => candidate.instanceId === value.linkedPlanInstanceId,
            );
            const hasKey =
              typeof value.apiKey === "string"
                ? value.apiKey.trim().length > 0
                : value.apiKey.reference.trim().length > 0;
            if (!hasKey) reason = "Configure an API key for this Claude API credit account.";
            else if (
              !linked ||
              linked.instanceId === provider.instanceId ||
              linked.driver !== "claudeAgent" ||
              linked.billingKind === "payPerUse"
            )
              reason = "Link this API credit account to a different Claude subscription account.";
            else if (
              providers.some((candidate) => {
                if (
                  candidate.instanceId === provider.instanceId ||
                  candidate.driver !== "claudeAgent" ||
                  candidate.billingKind !== "payPerUse" ||
                  Option.isNone(settings)
                )
                  return false;
                const other = decodeClaudeSettings(
                  settings.value.providerInstances[candidate.instanceId]?.config ?? {},
                );
                return (
                  Option.isSome(other) &&
                  other.value.linkedPlanInstanceId === value.linkedPlanInstanceId
                );
              })
            )
              reason =
                "Only one Claude API credit account may be linked to each subscription account.";
            else if (
              !(value.apiCreditGrantUsd > 0) ||
              !/^\d{4}-\d{2}-\d{2}T/.test(value.apiCreditCycleEnd) ||
              !Number.isFinite(Date.parse(value.apiCreditCycleEnd))
            )
              reason = "Set a positive API credit grant and a valid cycle end date.";
            else if (Option.isNone(apiCredit))
              reason = "API credit balance tracking is unavailable.";
            else {
              yield* apiCredit.value.configure(provider.instanceId, {
                linkedPlanInstanceId: ProviderId.make(value.linkedPlanInstanceId),
                grantUsd: value.apiCreditGrantUsd,
                cycleEnd: value.apiCreditCycleEnd,
              });
              const payPerUse = yield* apiCredit.value.snapshot(provider.instanceId);
              return { ...provider, ...(payPerUse ? { payPerUse } : {}) };
            }
          }
          const { payPerUse: _payPerUse, ...withoutCredit } = provider;
          return {
            ...withoutCredit,
            status: "error" as const,
            availability: "unavailable" as const,
            auth: { ...provider.auth, status: "unauthenticated" as const },
            message: reason,
            unavailableReason: reason,
          };
        }),
      );
    });

    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );

    const bootInstances = yield* instanceRegistry.listInstances;
    const bootSources = bootInstances.map(buildSnapshotSource);
    const fallbackProviders = yield* loadProviders(bootSources);
    const fallbackByInstance = new Map<ProviderInstanceId, ServerProvider>();
    for (let index = 0; index < fallbackProviders.length; index++) {
      const provider = fallbackProviders[index];
      const source = bootSources[index];
      if (provider === undefined || source === undefined) {
        continue;
      }
      fallbackByInstance.set(source.instanceId, provider);
    }

    const cachedProviders = yield* Effect.forEach(
      bootSources,
      (source) =>
        Effect.gen(function* () {
          const filePath = yield* resolveProviderStatusCachePath({
            cacheDir: config.providerStatusCacheDir,
            instanceId: source.instanceId,
          }).pipe(Effect.provideService(Path.Path, path));
          const fallbackProvider = fallbackByInstance.get(source.instanceId);
          if (fallbackProvider === undefined) {
            return undefined;
          }
          return yield* readProviderStatusCache(filePath).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.flatMap((cachedProvider) => {
              if (cachedProvider === undefined) {
                return Effect.void.pipe(Effect.as(undefined as ServerProvider | undefined));
              }
              const correlation = {
                cachedProvider,
                fallbackProvider,
              } as const;
              if (!isCachedProviderCorrelated(correlation)) {
                return Effect.logWarning("provider status cache identity mismatch, ignoring", {
                  path: filePath,
                  instanceId: source.instanceId,
                  cachedInstanceId: cachedProvider.instanceId ?? null,
                  driver: source.driverKind,
                  cachedDriver: cachedProvider.driver ?? null,
                }).pipe(Effect.as(undefined as ServerProvider | undefined));
              }
              return Effect.succeed(hydrateCachedProvider(correlation));
            }),
          );
        }),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((providers) =>
        orderProviderSnapshots(
          providers.filter((provider): provider is ServerProvider => provider !== undefined),
        ),
      ),
    );
    const initialManifest = yield* manifestService.current;
    const classifyCompatibility = (
      provider: ServerProvider,
      manifest: ModelManifest.ModelManifestData,
    ) =>
      applyProviderCompatibility(
        provider,
        manifest.compatibility,
        ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
      );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      withSameAccountMarks(
        cachedProviders.map((provider) => classifyCompatibility(provider, initialManifest)),
      ),
    );
    const workspaceRefreshesRef = yield* Ref.make<
      ReadonlyMap<ProviderInstance, ReadonlyMap<string, Deferred.Deferred<void>>>
    >(new Map());
    const maintenanceActionStatesRef = yield* Ref.make<
      ReadonlyMap<ProviderInstanceId, { readonly update?: ServerProviderUpdateState | undefined }>
    >(new Map());

    const liveSubsRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ProviderInstance>>(
      new Map(),
    );
    const syncSemaphore = yield* Semaphore.make(1);

    const getLiveSources: Effect.Effect<ReadonlyArray<ProviderSnapshotSource>> = Ref.get(
      liveSubsRef,
    ).pipe(Effect.map((map) => Array.from(map.values(), buildSnapshotSource)));

    const persistProvider = Effect.fn("ProviderRegistry.persistProvider")(function* (
      provider: ServerProvider,
    ) {
      const key = snapshotInstanceKey(provider);
      const filePath = yield* resolveProviderStatusCachePath({
        cacheDir: config.providerStatusCacheDir,
        instanceId: key,
      }).pipe(Effect.provideService(Path.Path, path));
      const { workspaceSnapshots: _workspaceSnapshots, ...machineProvider } = provider;
      yield* writeProviderStatusCache({ filePath, provider: machineProvider }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.tapError(Effect.logError),
        Effect.ignore,
      );
    });

    const applyProviderUpdateState = Effect.fn("applyProviderUpdateState")(function* (
      provider: ServerProvider,
    ) {
      const maintenanceActionStates = yield* Ref.get(maintenanceActionStatesRef);
      const updateState = maintenanceActionStates.get(provider.instanceId)?.update;
      if (!updateState) {
        const { updateState: _updateState, ...providerWithoutUpdateState } = provider;
        return providerWithoutUpdateState;
      }
      return {
        ...provider,
        updateState,
      };
    });

    const upsertProviders = Effect.fn("upsertProviders")(function* (
      nextProviders: ReadonlyArray<ServerProvider>,
      options?: {
        readonly publish?: boolean;
        readonly persist?: boolean;
        readonly replace?: boolean;
      },
    ) {
      const manifest = yield* manifestService.current;
      const nextProvidersWithUpdateState = yield* Effect.forEach(
        nextProviders,
        applyProviderUpdateState,
        {
          concurrency: "unbounded",
        },
      );
      const [previousProviders, providers, providersToPersist] = yield* Ref.modify(
        providersRef,
        (previousProviders) => {
          const mergedProviders = new Map(
            previousProviders.map((provider) => [snapshotInstanceKey(provider), provider] as const),
          );
          const updatedKeys = new Set<ProviderInstanceId>();

          for (const provider of nextProvidersWithUpdateState) {
            const key = snapshotInstanceKey(provider);
            updatedKeys.add(key);
            mergedProviders.set(
              key,
              options?.replace === true
                ? provider
                : mergeProviderSnapshot(mergedProviders.get(key), provider),
            );
          }

          const providers = withSameAccountMarks(
            orderProviderSnapshots(
              [...mergedProviders.values()].map((provider) =>
                classifyCompatibility(provider, manifest),
              ),
            ),
          );
          const providersToPersist = providers.filter((provider) =>
            updatedKeys.has(snapshotInstanceKey(provider)),
          );
          return [[previousProviders, providers, providersToPersist] as const, providers];
        },
      );

      if (haveProvidersChanged(previousProviders, providers)) {
        if (options?.persist !== false) {
          yield* Effect.forEach(providersToPersist, persistProvider, {
            concurrency: "unbounded",
            discard: true,
          });
        }
        if (options?.publish !== false) {
          // A newer upsert may have committed and published during the cache write; never republish an older array.
          yield* PubSub.publish(changesPubSub, yield* Ref.get(providersRef));
        }
      }

      return providers;
    });

    const compatibilityRefreshRunning = yield* Ref.make(false);
    const syncProvider = Effect.fn("syncProvider")(function* (
      provider: ServerProvider,
      options?: {
        readonly publish?: boolean;
      },
    ) {
      const providers = yield* upsertProviders([provider], options);
      // Reclassify the current model after fetch; republishing the old probe could overwrite newer health results.
      if (!(yield* Ref.getAndSet(compatibilityRefreshRunning, true))) {
        yield* manifestService.refresh.pipe(
          Effect.andThen(upsertProviders([], { persist: false })),
          Effect.ensuring(Ref.set(compatibilityRefreshRunning, false)),
          Effect.forkIn(serviceScope),
        );
      }
      return providers;
    });

    const setProviderMaintenanceActionState = Effect.fn("setProviderMaintenanceActionState")(
      function* (input: {
        readonly instanceId: ProviderInstanceId;
        readonly action: "update";
        readonly state: ServerProviderUpdateState | null;
      }) {
        yield* Ref.update(maintenanceActionStatesRef, (previous) => {
          const previousActions = previous.get(input.instanceId);
          const nextActions = { ...previousActions };
          if (input.state === null || input.state.status === "idle") {
            delete nextActions[input.action];
          } else {
            nextActions[input.action] = input.state;
          }

          const next = new Map(previous);
          if (Object.keys(nextActions).length === 0) {
            next.delete(input.instanceId);
          } else {
            next.set(input.instanceId, nextActions);
          }
          return next;
        });

        const existingProviders = yield* Ref.get(providersRef);
        const matchingProvider = existingProviders.find(
          (candidate) => candidate.instanceId === input.instanceId,
        );
        if (!matchingProvider) {
          return existingProviders;
        }

        const nextProvider = yield* applyProviderUpdateState(matchingProvider);
        return yield* upsertProviders([nextProvider], {
          persist: false,
        });
      },
    );

    const refreshOneSource = Effect.fn("refreshOneSource")(function* (
      providerSource: ProviderSnapshotSource,
    ) {
      return yield* providerSource.refresh.pipe(
        Effect.flatMap((nextProvider) =>
          correlateSnapshotWithSource(providerSource, nextProvider).pipe(
            Effect.flatMap(syncProvider),
          ),
        ),
      );
    });

    type RefreshAllCompletion = Deferred.Deferred<ReadonlyArray<ServerProvider>>;
    const refreshAllInFlightRef = yield* Ref.make<Option.Option<RefreshAllCompletion>>(
      Option.none(),
    );

    const refreshAll = Effect.fn("refreshAll")(function* () {
      const claimed = yield* Ref.modify(
        refreshAllInFlightRef,
        (
          inFlight,
        ): readonly [
          { readonly owner: boolean; readonly completion: RefreshAllCompletion },
          Option.Option<RefreshAllCompletion>,
        ] => {
          if (Option.isSome(inFlight)) {
            return [{ owner: false, completion: inFlight.value }, inFlight];
          }
          const completion = Deferred.makeUnsafe<ReadonlyArray<ServerProvider>>();
          return [{ owner: true, completion }, Option.some(completion)];
        },
      );
      if (claimed.owner) {
        // Detach shared passes so the first caller's interruption cannot cancel other callers' work.
        // Syncing first keeps a refresh right after a rebuild from probing the replaced instance.
        yield* syncLiveSourcesAndContinue.pipe(
          Effect.andThen(getLiveSources),
          Effect.flatMap((sources) =>
            Effect.forEach(sources, (source) => refreshOneSource(source), {
              concurrency: "unbounded",
              discard: true,
            }),
          ),
          Effect.andThen(Ref.get(providersRef)),
          Effect.onExit((exit) =>
            Ref.set(refreshAllInFlightRef, Option.none()).pipe(
              Effect.andThen(Deferred.done(claimed.completion, exit)),
            ),
          ),
          Effect.forkDetach,
        );
      }
      return yield* Deferred.await(claimed.completion);
    });

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderDriverKind) {
      if (provider === undefined) {
        return yield* refreshAll();
      }
      const defaultInstanceId = defaultInstanceIdForDriver(provider);
      const sources = yield* getLiveSources;
      const providerSource = sources.find(
        (candidate) => candidate.instanceId === defaultInstanceId,
      );
      if (!providerSource) {
        return yield* Ref.get(providersRef);
      }
      return yield* refreshOneSource(providerSource);
    });

    const refreshInstance = Effect.fn("refreshInstance")(function* (
      instanceId: ProviderInstanceId,
    ) {
      yield* syncLiveSourcesAndContinue;
      const sources = yield* getLiveSources;
      const providerSource = sources.find((candidate) => candidate.instanceId === instanceId);
      if (!providerSource) {
        return yield* Ref.get(providersRef);
      }
      return yield* refreshOneSource(providerSource);
    });

    const reloadSecretsAndRefresh = Effect.fn("reloadSecretsAndRefresh")(function* (
      instanceId?: ProviderInstanceId,
    ) {
      yield* instanceRegistryMutator.reloadSecrets(instanceId);
      return yield* instanceId === undefined ? refresh() : refreshInstance(instanceId);
    });

    const refreshAfterUpdate = Effect.fn("refreshAfterUpdate")(function* (
      provider: ProviderDriverKind,
      selectedInstanceId: ProviderInstanceId,
    ) {
      yield* manifestService.forceRefresh;
      const instances = (yield* instanceRegistry.listInstances).filter(
        (instance) =>
          instance.driverKind === provider &&
          (instance.enabled || instance.instanceId === selectedInstanceId),
      );
      const failedInstances = new Set<ProviderInstanceId>();
      const recoverInstanceFailure = Effect.fn("recoverPostUpdateRefreshFailure")(function* (
        instanceId: ProviderInstanceId,
        cause: Cause.Cause<unknown>,
      ) {
        if (Cause.hasInterruptsOnly(cause)) {
          return yield* Effect.interrupt;
        }
        yield* Effect.logError("provider post-update refresh failed", {
          instanceId,
          cause: Cause.pretty(cause),
        });
        failedInstances.add(instanceId);
        // A cached ready snapshot cannot verify a successful update.
        return yield* updateProviders((providers) =>
          providers.map((candidate) =>
            candidate.instanceId === instanceId
              ? { ...candidate, status: "error", message: "Provider refresh failed after update." }
              : candidate,
          ),
        );
      });
      // Accounts can share an installation, but discovery must use each
      // instance's own executable, environment, and credentials.
      yield* Effect.forEach(
        instances,
        (instance) =>
          Effect.gen(function* () {
            yield* instance.invalidateCaches ?? Effect.void;
            const maintenance = yield* instance.snapshot.resolveMaintenance({ fresh: true });
            yield* Effect.forEach(
              latestProviderVersionCacheKeys(maintenance),
              latestVersions.invalidate,
              { discard: true },
            );
          }).pipe(Effect.catchCause((cause) => recoverInstanceFailure(instance.instanceId, cause))),
        { concurrency: "unbounded", discard: true },
      );
      yield* Effect.forEach(
        instances.filter((instance) => !failedInstances.has(instance.instanceId)),
        (instance) =>
          refreshOneSource(buildSnapshotSource(instance)).pipe(
            Effect.catchCause((cause) => recoverInstanceFailure(instance.instanceId, cause)),
          ),
        { concurrency: "unbounded", discard: true },
      );
      const refreshedInstanceIds = new Set(
        instances
          .filter((instance) => !failedInstances.has(instance.instanceId))
          .map((instance) => instance.instanceId),
      );
      return (yield* Ref.get(providersRef)).filter((candidate) =>
        refreshedInstanceIds.has(candidate.instanceId),
      );
    });

    const getProviderMaintenanceCapabilitiesForInstance = Effect.fn(
      "getProviderMaintenanceCapabilitiesForInstance",
    )(function* (
      instanceId: ProviderInstanceId,
      provider: ProviderDriverKind,
      options?: { readonly fresh?: boolean },
    ) {
      // liveSubsRef trails reconciliation and could run a retired instance's command; read the registry.
      const instance = yield* instanceRegistry.getInstance(instanceId);
      if (!instance || instance.driverKind !== provider) {
        return makeManualProviderMaintenanceCapabilities(provider);
      }
      return yield* instance.snapshot.resolveMaintenance(options);
    });

    const syncLiveSources = syncSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const instances = yield* instanceRegistry.listInstances;
        const unavailableProviders = yield* instanceRegistry.listUnavailable;
        const nextByInstance = new Map<ProviderInstanceId, ProviderInstance>(
          instances.map((instance) => [instance.instanceId, instance] as const),
        );
        const knownInstanceIds = new Set<ProviderInstanceId>(nextByInstance.keys());
        for (const provider of unavailableProviders) {
          knownInstanceIds.add(snapshotInstanceKey(provider));
        }
        const previousSubs = yield* Ref.get(liveSubsRef);

        const carriedOver = new Map<ProviderInstanceId, ProviderInstance>();
        for (const [instanceId, previousInstance] of previousSubs) {
          const nextInstance = nextByInstance.get(instanceId);
          if (nextInstance !== undefined && nextInstance === previousInstance) {
            carriedOver.set(instanceId, previousInstance);
          }
        }

        const newlyAdded: Array<readonly [ProviderInstanceId, ProviderInstance]> = [];
        for (const [instanceId, instance] of nextByInstance) {
          if (carriedOver.has(instanceId)) {
            continue;
          }
          newlyAdded.push([instanceId, instance] as const);
        }

        const rebuiltInstanceIds = new Set(
          newlyAdded
            .map(([instanceId]) => instanceId)
            .filter((instanceId) => previousSubs.has(instanceId)),
        );
        if (rebuiltInstanceIds.size > 0) {
          const [previousProviders, providers] = yield* Ref.modify(
            providersRef,
            (previousProviders) => {
              const providers = previousProviders.map((provider) => {
                if (!rebuiltInstanceIds.has(provider.instanceId)) return provider;
                const { workspaceSnapshots: _workspaceSnapshots, ...machineSnapshot } = provider;
                return machineSnapshot;
              });
              return [[previousProviders, providers] as const, providers];
            },
          );
          if (haveProvidersChanged(previousProviders, providers)) {
            yield* PubSub.publish(changesPubSub, providers);
          }
        }

        // Subscribe before reading so a probe completing mid-sync is observed by at least one path.
        for (const [, instance] of newlyAdded) {
          const source = buildSnapshotSource(instance);
          yield* Stream.runForEach(source.streamChanges, (provider) =>
            correlateSnapshotWithSource(source, provider).pipe(Effect.flatMap(syncProvider)),
          ).pipe(Effect.forkScoped);
        }
        yield* Effect.yieldNow;

        yield* Effect.forEach(
          newlyAdded,
          ([, instance]) =>
            Effect.gen(function* () {
              const source = buildSnapshotSource(instance);
              const provider = yield* source.getSnapshot;
              yield* correlateSnapshotWithSource(source, provider).pipe(
                Effect.flatMap(syncProvider),
              );
            }).pipe(Effect.ignoreCause({ log: true })),
          { concurrency: "unbounded", discard: true },
        );
        yield* upsertProviders(unavailableProviders, {
          persist: false,
          replace: true,
        });

        const nextSubs = new Map(carriedOver);
        for (const [instanceId, instance] of newlyAdded) {
          nextSubs.set(instanceId, instance);
        }
        yield* Ref.set(liveSubsRef, nextSubs);

        const [previousProviders, providers] = yield* Ref.modify(
          providersRef,
          (previousProviders) => {
            const providers = withSameAccountMarks(
              orderProviderSnapshots(
                previousProviders.filter((provider) =>
                  knownInstanceIds.has(snapshotInstanceKey(provider)),
                ),
              ),
            );
            return [[previousProviders, providers] as const, providers];
          },
        );
        if (haveProvidersChanged(previousProviders, providers)) {
          yield* PubSub.publish(changesPubSub, providers);
        }
        yield* Ref.update(maintenanceActionStatesRef, (previous) => {
          const next = new Map(previous);
          for (const instanceId of previous.keys()) {
            if (!knownInstanceIds.has(instanceId)) {
              next.delete(instanceId);
            }
          }
          return next;
        });
      }),
    );
    const syncLiveSourcesAndContinue = syncLiveSources.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logError(
          "provider registry instance sync failed; keeping subscription alive",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
      Scope.provide(serviceScope),
    );

    yield* upsertProviders(fallbackProviders, { publish: false });
    const instanceChanges = yield* instanceRegistry.subscribeChanges;
    yield* syncLiveSources;
    yield* Stream.runForEach(
      Stream.fromSubscription(instanceChanges),
      () => syncLiveSourcesAndContinue,
    ).pipe(Effect.forkScoped);

    const recoverRefreshFailure = Effect.fn("recoverRefreshFailure")(function* (
      cause: Cause.Cause<unknown>,
    ) {
      if (Cause.hasInterruptsOnly(cause)) {
        return yield* Effect.interrupt;
      }
      yield* Effect.logError("provider registry refresh failed; preserving cached providers", {
        cause: Cause.pretty(cause),
      });
      return yield* Ref.get(providersRef);
    });

    type UsageInquiry = {
      keys: ReadonlyArray<string>;
      staleObservations: (provider: ServerProvider) => ReadonlyArray<string>;
    };
    type UsageRead = {
      account: ReadonlyArray<string | undefined>;
      done: Deferred.Deferred<void>;
      inquiries: UsageInquiry[];
    };
    const usageReads = new Map<ProviderInstance, UsageRead>();
    const unresolvedUsageReads = new WeakMap<
      ProviderInstance,
      { account: ReadonlyArray<string | undefined>; attempts: Map<string, number> }
    >();
    const usageRetryDelayMs = 10 * 60_000;
    const sharedUsageRead = Effect.fn("ProviderRegistry.sharedUsageRead")(function* (
      instance: ProviderInstance,
      staleObservations: (provider: ServerProvider) => ReadonlyArray<string>,
    ) {
      const providers = yield* Ref.get(providersRef);
      const provider = providers.find((entry) => entry.instanceId === instance.instanceId);
      if (provider === undefined || !isAccountReady(provider)) {
        return Option.none();
      }
      const stale = staleObservations(provider);
      if (stale.length === 0) return Option.none();
      const limits = provider.usageLimits;
      // Unsupported limits may be external; they have no local meter to re-read.
      if (limits?.unavailable?.reason === "unsupported") return Option.none();
      const source = buildSnapshotSource(instance);
      const dedicatedRead = instance.snapshot.refreshUsage;
      if (dedicatedRead === undefined && limits === undefined) return Option.none();

      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const account = usageAccountIdentity(provider);
      const running = usageReads.get(instance);
      const inquiry = { keys: stale, staleObservations };
      if (running && Equal.equals(running.account, account)) {
        running.inquiries.push(inquiry);
        return Option.some(running.done);
      }
      const last = unresolvedUsageReads.get(instance);
      const attempts =
        last && Equal.equals(last.account, account) ? last.attempts : new Map<string, number>();
      for (const [key, at] of attempts) {
        if (now - at >= usageRetryDelayMs) attempts.delete(key);
      }
      if (stale.every((key) => attempts.has(key))) return Option.none();
      const done = Deferred.makeUnsafe<void>();
      const inquiries = [inquiry];
      usageReads.set(instance, { account, done, inquiries });
      unresolvedUsageReads.set(instance, { account, attempts });
      let updated: ServerProvider | undefined;
      const read = dedicatedRead
        ? dedicatedRead.pipe(Effect.andThen(source.getSnapshot))
        : source.refresh;
      yield* Effect.gen(function* () {
        const next = yield* read.pipe(Effect.timeoutOption("60 seconds"));
        if (Option.isNone(next) || usageReads.get(instance)?.done !== done) return;
        if ((yield* instanceRegistry.getInstance(instance.instanceId)) !== instance) return;
        const current = (yield* Ref.get(providersRef)).find(
          (row) => row.instanceId === instance.instanceId,
        );
        if (!current || !isAccountReady(current)) return;
        const currentAccount = usageAccountIdentity(current);
        if (
          !Equal.equals(currentAccount, account) &&
          !Equal.equals(currentAccount, usageAccountIdentity(next.value))
        )
          return;
        const snapshots = yield* syncProvider(
          yield* correlateSnapshotWithSource(source, next.value),
        );
        updated = snapshots.find((row) => row.instanceId === instance.instanceId);
      }).pipe(
        Effect.catchCause(recoverRefreshFailure),
        Effect.ensuring(
          Effect.sync(() => {
            if (usageReads.get(instance)?.done !== done) return;
            usageReads.delete(instance);
            const unresolved = new Set<string>();
            for (const { keys, staleObservations } of inquiries) {
              const after = updated && new Set(staleObservations(updated));
              for (const key of keys) {
                attempts.delete(key);
                if (!after || after.has(key)) unresolved.add(key);
              }
            }
            for (const key of unresolved) attempts.set(key, now);
          }).pipe(Effect.ensuring(Deferred.succeed(done, undefined))),
        ),
        Effect.interruptible,
        Effect.forkIn(serviceScope),
      );
      return Option.some(done);
    }, Effect.uninterruptible);

    const refreshUsageIfStale = Effect.fn("ProviderRegistry.refreshUsageIfStale")(function* ({
      instanceIds,
      staleObservations,
      waitMs,
    }: Parameters<ProviderRegistry["Service"]["refreshUsageIfStale"]>[0]) {
      yield* Effect.forEach(
        new Set(instanceIds),
        (instanceId) =>
          instanceRegistry.getInstance(instanceId).pipe(
            Effect.flatMap((instance) =>
              instance?.enabled ? sharedUsageRead(instance, staleObservations) : Effect.succeedNone,
            ),
            Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: Deferred.await })),
          ),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.timeoutOption(Math.max(0, waitMs)));
      return yield* Ref.get(providersRef);
    });

    const updateProviders = (
      update: (providers: ReadonlyArray<ServerProvider>) => ReadonlyArray<ServerProvider>,
    ) =>
      Ref.modify(providersRef, (currentProviders) => {
        const nextProviders = update(currentProviders);
        return [[currentProviders, nextProviders] as const, nextProviders];
      }).pipe(
        Effect.tap(([previousProviders, nextProviders]) =>
          haveProvidersChanged(previousProviders, nextProviders)
            ? PubSub.publish(changesPubSub, nextProviders)
            : Effect.void,
        ),
        Effect.map(([, nextProviders]) => nextProviders),
      );

    const refreshWorkspaceSnapshot = Effect.fn("refreshWorkspaceSnapshot")(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly cwd: string;
      readonly fresh?: boolean;
    }) {
      if (input.fresh) {
        yield* updateProviders((providers) =>
          providers.map((candidate) =>
            candidate.instanceId === input.instanceId
              ? candidate
              : dropProviderWorkspaceSnapshot(candidate, input.cwd),
          ),
        );
      }
      const providers = yield* Ref.get(providersRef);
      const provider = providers.find((candidate) => candidate.instanceId === input.instanceId);
      const workspaceSnapshotOf = (candidate: ServerProvider | undefined) =>
        candidate?.workspaceSnapshots?.find((s) => s.cwd === input.cwd);
      const scannedFrom = workspaceSnapshotOf(provider);
      const now = yield* DateTime.now;
      if (
        !provider ||
        !provider.enabled ||
        (!input.fresh &&
          scannedFrom &&
          !scannedFrom.slashCommandsPending &&
          isProviderWorkspaceSnapshotCurrent(scannedFrom, DateTime.toEpochMillis(now)))
      ) {
        return providers;
      }
      // Use scan start for TTL, not checkedAt inherited from the machine health check.
      const scannedAt = DateTime.formatIso(now);
      const instance = yield* instanceRegistry.getInstance(input.instanceId);
      if (!instance?.snapshotForCwd) return providers;
      const token = yield* Deferred.make<void>();
      const refreshMachineSnapshot = input.fresh
        ? (instance.invalidateCaches ?? Effect.void).pipe(
            Effect.andThen(refreshInstance(input.instanceId)),
          )
        : Effect.void;
      const runScan = refreshMachineSnapshot.pipe(
        Effect.andThen(instance.snapshotForCwd(input.cwd)),
        // Scans fail on error; returned inventory remains valid even when provider health reports an error.
        Effect.flatMap((scopedSnapshot) =>
          instanceRegistry.getInstance(input.instanceId).pipe(
            Effect.flatMap((currentInstance) => {
              if (currentInstance !== instance) return Ref.get(providersRef);
              return updateProviders((currentProviders) => {
                // Read ownership inside the update so a newer claim cannot race publication.
                if (Ref.getUnsafe(workspaceRefreshesRef).get(instance)?.get(input.cwd) !== token) {
                  return currentProviders;
                }
                return currentProviders.map((candidate) =>
                  candidate.instanceId === input.instanceId &&
                  Equal.equals(workspaceSnapshotOf(candidate), scannedFrom)
                    ? upsertProviderWorkspaceSnapshot(candidate, input.cwd, {
                        ...scopedSnapshot,
                        checkedAt: scannedAt,
                        // Without driver command discovery, retain previous commands after failed health checks and retry.
                        slashCommandsPending:
                          scopedSnapshot.slashCommandsPending ?? scopedSnapshot.status === "error",
                      })
                    : candidate,
                );
              });
            }),
          ),
        ),
        Effect.ensuring(
          Ref.update(workspaceRefreshesRef, (refreshes) => {
            const current = refreshes.get(instance);
            if (current?.get(input.cwd) !== token) return refreshes;
            const next = new Map(refreshes);
            const nextCwds = new Map(current);
            nextCwds.delete(input.cwd);
            if (nextCwds.size) next.set(instance, nextCwds);
            else next.delete(instance);
            return next;
          }).pipe(Effect.andThen(Deferred.succeed(token, undefined))),
        ),
      );
      // The claim and the fork happen together, so the token is always completed. The scan is
      // detached so a disconnecting owner cannot cancel the result its waiters depend on.
      const claim = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const inFlight = yield* Ref.modify(workspaceRefreshesRef, (refreshes) => {
            const current = refreshes.get(instance);
            const running = current?.get(input.cwd);
            if (!input.fresh && running) return [running, refreshes] as const;
            const next = new Map(refreshes);
            next.set(instance, new Map(current).set(input.cwd, token));
            return [undefined, next] as const;
          });
          if (inFlight) return { inFlight } as const;
          return {
            // Starting now attaches the scan's `ensuring` before anything can close the scope.
            scan: yield* Effect.forkIn(runScan, serviceScope, { startImmediately: true }),
          } as const;
        }),
      );
      // Wait for the running scan: on-demand clients get its result only in this reply.
      if ("inFlight" in claim) {
        return yield* Deferred.await(claim.inFlight).pipe(Effect.andThen(Ref.get(providersRef)));
      }
      return yield* Fiber.join(claim.scan);
    });

    return {
      getProviders: Ref.get(providersRef).pipe(Effect.flatMap(withBilling)),
      fundingForWorkspace: Effect.fn("ProviderRegistry.fundingForWorkspace")(function* (input) {
        const instance = yield* instanceRegistry.getInstance(input.provider.instanceId);
        if (!instance?.enabled || !instance.fundingForWorkspace) return "unknown";
        const funding = yield* instance.fundingForWorkspace(input).pipe(
          Effect.timeout("8 seconds"),
          Effect.catchCause(() => Effect.succeed("unknown" as const)),
        );
        const current = (yield* Ref.get(providersRef)).find(
          (row) => row.instanceId === input.provider.instanceId,
        );
        return instance === (yield* instanceRegistry.getInstance(input.provider.instanceId)) &&
          current?.enabled &&
          current.status === "ready" &&
          Equal.equals(current.auth, input.provider.auth) &&
          Equal.equals(usageAccountIdentity(current), usageAccountIdentity(input.provider)) &&
          Equal.equals(
            current.models.find((model) => model.slug === input.model),
            input.provider.models.find((model) => model.slug === input.model),
          )
          ? funding
          : "unknown";
      }),
      refresh: (provider?: ProviderDriverKind) =>
        refresh(provider).pipe(
          Effect.catchCause(recoverRefreshFailure),
          Effect.flatMap(withBilling),
        ),
      refreshInstance: (instanceId: ProviderInstanceId) =>
        refreshInstance(instanceId).pipe(
          Effect.catchCause(recoverRefreshFailure),
          Effect.flatMap(withBilling),
        ),
      refreshUsageIfStale,
      reloadSecretsAndRefresh: (instanceId?: ProviderInstanceId) =>
        reloadSecretsAndRefresh(instanceId).pipe(
          Effect.catchCause(recoverRefreshFailure),
          Effect.flatMap(withBilling),
        ),
      refreshWorkspaceSnapshot: (input) =>
        refreshWorkspaceSnapshot(input).pipe(
          Effect.catchCause(recoverRefreshFailure),
          Effect.flatMap(withBilling),
        ),
      refreshAfterUpdate: (...args) =>
        refreshAfterUpdate(...args).pipe(Effect.flatMap(withBilling)),
      getProviderMaintenanceCapabilitiesForInstance,
      setProviderMaintenanceActionState,
      get streamChanges() {
        const snapshots = Stream.fromPubSub(changesPubSub);
        return (
          Option.isSome(apiCredit)
            ? Stream.merge(
                snapshots,
                apiCredit.value.changes.pipe(Stream.mapEffect(() => Ref.get(providersRef))),
              )
            : snapshots
        ).pipe(Stream.mapEffect(withBilling));
      },
    } satisfies ProviderRegistry["Service"];
  }),
);
