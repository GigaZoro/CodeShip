import {
  isProviderAvailable,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import { modelPicksEqual, resolveSelectableModel } from "@t3tools/shared/model";
import {
  orderProviderInstancesForFailover,
  resolveAutoModelSelection,
  supportsAccountFailover,
} from "@t3tools/shared/serverSettings";
import { exhaustedUsageWindow, isSubscriptionAccount } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export interface AccountRoutingContext {
  readonly settings: Pick<
    ServerSettingsValue,
    | "providerInstanceFailoverOrder"
    | "providerInstances"
    | "projectSettingsOverrides"
    | "failoverLimitedThreads"
    | "autoModeProvider"
    | "autoModeModels"
  >;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** Accounts with an uncleared usage refusal, including unknown resets. */
  readonly recordedLimits: ReadonlyMap<ProviderInstanceId, ProjectionStore.RecordedUsageLimit>;
  readonly nowMs: number;
}

function accountLimit(
  provider: ServerProvider,
  recorded: AccountRoutingContext["recordedLimits"],
  nowMs: number,
  model?: string,
  explicitLaunch = false,
): LaunchLimit | null {
  if (!isSubscriptionAccount(provider)) return null;
  const canonicalModel =
    model === undefined
      ? null
      : (resolveSelectableModel(provider.driver, model, provider.models) ?? model);
  const window = exhaustedUsageWindow(provider, nowMs, canonicalModel);
  const refusal = recorded.get(provider.instanceId);
  const snapshot = provider.usageLimits;
  const clearedBySnapshot =
    snapshot !== undefined &&
    snapshot.unavailable === undefined &&
    refusal !== undefined &&
    Date.parse(snapshot.checkedAt) > Date.parse(refusal.refusedAt) &&
    window === undefined;
  if (
    refusal !== undefined &&
    (refusal.resetAt !== null
      ? Date.parse(refusal.resetAt) > nowMs
      : !clearedBySnapshot && !explicitLaunch)
  ) {
    return { instanceId: provider.instanceId, limitedUntil: refusal.resetAt };
  }
  return window === undefined
    ? null
    : {
        instanceId: provider.instanceId,
        limitedUntil:
          window.resetsAt && Number.isFinite(Date.parse(window.resetsAt)) ? window.resetsAt : null,
      };
}

/** The model this subscription account would run for `model` now, or null when it cannot take the turn. */
export function modelWithRoom(
  provider: ServerProvider,
  input: AccountRoutingContext & { readonly projectId: ProjectId; readonly model: string },
): string | null {
  if (
    !provider.enabled ||
    !provider.installed ||
    provider.status === "error" ||
    provider.auth.status === "unauthenticated" ||
    !isSubscriptionAccount(provider) ||
    !isProviderAvailable(provider) ||
    !resolveProjectProviderInstanceEnabled(input.settings, input.projectId, provider.instanceId)
  )
    return null;
  const model = resolveSelectableModel(provider.driver, input.model, provider.models);
  return model === null || accountLimit(provider, input.recordedLimits, input.nowMs, model) !== null
    ? null
    : model;
}

/** Accounts of `driver` that can run `model` now, highest in the saved account order first. */
export function accountsWithRoom(
  input: AccountRoutingContext & {
    readonly driver: ProviderDriverKind;
    readonly projectId: ProjectId;
    readonly model: string;
  },
): ReadonlyArray<{ readonly instanceId: ProviderInstanceId; readonly model: string }> {
  if (!supportsAccountFailover(input.driver)) return [];
  const eligible = input.providers.flatMap((provider) => {
    if (provider.driver !== input.driver) return [];
    const model = modelWithRoom(provider, input);
    return model === null ? [] : [{ instanceId: provider.instanceId, model }];
  });
  return orderProviderInstancesForFailover(input.settings.providerInstanceFailoverOrder, eligible);
}

/**
 * Where an Auto selection runs: its provider's Auto model. With account switching on, a thread
 * keeps its account while it has room, so its session never restarts needlessly; otherwise it
 * takes the highest account in the order with room, else stays put. Auto off runs it as named.
 */
export function routeAutoAccount(
  input: AccountRoutingContext & {
    readonly selection: ModelSelection;
    readonly projectId: ProjectId;
    /** The account the thread already runs on; null for a thread with no run yet. */
    readonly currentInstanceId: ProviderInstanceId | null;
    /** A thread that already ran keeps its provider. */
    readonly started: boolean;
  },
): ModelSelection {
  if (input.selection.autoAccount !== true) return input.selection;
  const selection = resolveAutoModelSelection({
    selection: input.selection,
    settings: input.settings,
    accounts: input.providers,
    started: input.started,
  });
  if (selection === input.selection) return selection;
  const driver = input.providers.find(
    (provider) => provider.instanceId === selection.instanceId,
  )?.driver;
  if (driver === undefined) return selection;
  const current = input.providers.find(
    (provider) => provider.instanceId === input.currentInstanceId && provider.driver === driver,
  );
  const pickTarget = () => {
    if (current !== undefined) {
      const model = modelWithRoom(current, { ...input, model: selection.model });
      if (model !== null) return { instanceId: current.instanceId, model };
    }
    const withRoom = accountsWithRoom({ ...input, driver, model: selection.model })[0];
    if (withRoom !== undefined) return withRoom;
    return current === undefined
      ? undefined
      : { instanceId: current.instanceId, model: selection.model };
  };
  const target = input.settings.failoverLimitedThreads ? pickTarget() : undefined;
  const routed =
    target === undefined ||
    (target.instanceId === selection.instanceId && target.model === selection.model)
      ? selection
      : { ...selection, instanceId: target.instanceId, model: target.model };
  return modelPicksEqual(routed, input.selection) ? input.selection : routed;
}

/**
 * A new thread whose named account is out of usage starts on the first other account of its
 * provider with room. Only while account switching is on, like a thread that hits its limit;
 * Auto picks are routed when their message is sent.
 */
export function failoverLimitedLaunch(
  input: AccountRoutingContext & {
    readonly selection: ModelSelection;
    readonly projectId: ProjectId;
  },
): ModelSelection {
  if (!input.settings.failoverLimitedThreads || input.selection.autoAccount === true) {
    return input.selection;
  }
  const current = input.providers.find(
    (provider) => provider.instanceId === input.selection.instanceId,
  );
  if (
    current === undefined ||
    accountLimit(current, input.recordedLimits, input.nowMs, input.selection.model) === null
  ) {
    return input.selection;
  }
  const target = accountsWithRoom({
    ...input,
    driver: current.driver,
    model: input.selection.model,
  }).find((account) => account.instanceId !== current.instanceId);
  return target === undefined
    ? input.selection
    : { ...input.selection, instanceId: target.instanceId, model: target.model };
}

export interface LaunchLimit {
  readonly instanceId: ProviderInstanceId;
  /** The account's reported reset as an ISO time, or null when unknown. */
  readonly limitedUntil: string | null;
}

export class AccountRouting extends Context.Service<
  AccountRouting,
  {
    /** Resolves an Auto selection to the model and account its next turn runs on. */
    readonly route: (input: {
      readonly selection: ModelSelection;
      readonly projectId: ProjectId;
      readonly currentInstanceId: ProviderInstanceId | null;
      readonly started: boolean;
    }) => Effect.Effect<ModelSelection>;
    /** Subscription accounts that can run this model, in failover order. */
    readonly accountsWithRoom: (input: {
      readonly driver: ProviderDriverKind;
      readonly projectId: ProjectId;
      readonly model: string;
    }) => Effect.Effect<
      ReadonlyArray<{ readonly instanceId: ProviderInstanceId; readonly model: string }>
    >;
    /** Account-wide usage limits from refusals and usage windows; null means an unknown reset. */
    readonly limitedAccounts: Effect.Effect<ReadonlyMap<ProviderInstanceId, string | null>>;
    /** The usage-limited account a new thread on `selection` would start on, or null if it has room. */
    readonly launchLimit: (input: {
      readonly explicitAccount: boolean;
      readonly selection: ModelSelection;
      readonly projectId: ProjectId;
    }) => Effect.Effect<LaunchLimit | null>;
    /** The account a new thread starts on when its named one is out of usage. */
    readonly failoverLaunch: (input: {
      readonly selection: ModelSelection;
      readonly projectId: ProjectId;
    }) => Effect.Effect<ModelSelection>;
  }
>()("t3/orchestration-v2/AccountRouting") {}

export const layer = Layer.effect(
  AccountRouting,
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    // Limits only steer and warn; a failed read leaves every account usable.
    const readLimits = (now: DateTime.Utc) =>
      projections.getUsageLimitedProviderInstances(now).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.account-routing.limits-unavailable", {
            cause,
          }).pipe(Effect.as(new Map<ProviderInstanceId, ProjectionStore.RecordedUsageLimit>())),
        ),
      );
    return {
      accountsWithRoom: Effect.fn("AccountRouting.accountsWithRoom")(
        function* (input) {
          const now = yield* DateTime.now;
          return accountsWithRoom({
            ...input,
            settings: yield* serverSettings.getSettings,
            providers: yield* providerRegistry.getProviders,
            recordedLimits: yield* readLimits(now),
            nowMs: DateTime.toEpochMillis(now),
          });
        },
        (effect) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.account-routing.accounts-unavailable", {
                cause,
              }).pipe(Effect.as([])),
            ),
          ),
      ),
      limitedAccounts: Effect.gen(function* () {
        const now = yield* DateTime.now;
        const recorded = yield* readLimits(now);
        const limited = new Map<ProviderInstanceId, string | null>();
        for (const provider of yield* providerRegistry.getProviders) {
          const limit = accountLimit(provider, recorded, DateTime.toEpochMillis(now));
          if (limit !== null) limited.set(provider.instanceId, limit.limitedUntil);
        }
        return limited;
      }),
      launchLimit: Effect.fn("AccountRouting.launchLimit")(
        function* (input) {
          const now = yield* DateTime.now;
          const limited = yield* readLimits(now);
          const providers = yield* providerRegistry.getProviders;
          // A new thread's first turn routes like this, so Auto is judged where it would start.
          const selection =
            input.selection.autoAccount === true
              ? routeAutoAccount({
                  selection: input.selection,
                  projectId: input.projectId,
                  currentInstanceId: null,
                  started: false,
                  settings: yield* serverSettings.getSettings,
                  providers,
                  recordedLimits: limited,
                  nowMs: DateTime.toEpochMillis(now),
                })
              : input.selection;
          const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
          return provider === undefined
            ? null
            : accountLimit(
                provider,
                limited,
                DateTime.toEpochMillis(now),
                selection.model,
                input.explicitAccount,
              );
        },
        (effect) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.account-routing.launch-limit-failed", {
                cause,
              }).pipe(Effect.as(null)),
            ),
          ),
      ),
      failoverLaunch: Effect.fn("AccountRouting.failoverLaunch")(
        function* (input) {
          const settings = yield* serverSettings.getSettings;
          if (!settings.failoverLimitedThreads || input.selection.autoAccount === true) {
            return input.selection;
          }
          const now = yield* DateTime.now;
          return failoverLimitedLaunch({
            ...input,
            settings,
            providers: yield* providerRegistry.getProviders,
            recordedLimits: yield* readLimits(now),
            nowMs: DateTime.toEpochMillis(now),
          });
        },
        // Without routing the launch still runs on its own account.
        (effect, input) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.account-routing.launch-failed", { cause }).pipe(
                Effect.as(input.selection),
              ),
            ),
          ),
      ),
      route: Effect.fn("AccountRouting.route")(
        function* (input) {
          if (input.selection.autoAccount !== true) return input.selection;
          const now = yield* DateTime.now;
          return routeAutoAccount({
            ...input,
            settings: yield* serverSettings.getSettings,
            providers: yield* providerRegistry.getProviders,
            recordedLimits: yield* readLimits(now),
            nowMs: DateTime.toEpochMillis(now),
          });
        },
        // Routing only improves where a turn starts; the selected account still runs without it.
        (effect, input) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.account-routing.failed", { cause }).pipe(
                Effect.as(input.selection),
              ),
            ),
          ),
      ),
    };
  }),
);
