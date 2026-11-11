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
import {
  exhaustedUsageWindow,
  isSubscriptionAccount,
  usageHoldMs,
  usageScopeCoversModel,
  usageWindowLimitEnd,
} from "@t3tools/shared/usageLimits";
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
    | "fallbackModelSelection"
  >;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** Accounts with an uncleared usage refusal, including unknown resets. */
  readonly recordedLimits: ReadonlyMap<
    ProviderInstanceId,
    ReadonlyArray<ProjectionStore.RecordedUsageLimit>
  >;
  readonly nowMs: number;
}

const canonicalModel = (provider: ServerProvider, slug: string) =>
  resolveSelectableModel(provider.driver, slug, provider.models) ?? slug;

/**
 * Whether a later completed run lifts a model-scoped refusal: its model, aliases resolved, is in
 * the scope. No snapshot lifts one: partial updates refresh `checkedAt` without the window they
 * omit, so a stale bar under 100% could end the hold early.
 */
export function completedRunLiftsScope(
  providers: ReadonlyArray<ServerProvider>,
): ProjectionStore.UsageScopeMatcher {
  return (instanceId, scope, model) => {
    const provider = providers.find((entry) => entry.instanceId === instanceId);
    return usageScopeCoversModel(
      scope,
      provider === undefined ? model : canonicalModel(provider, model),
    );
  };
}

/**
 * ChatGPT's connected-app cap resets with the week, but the owner or ChatGPT can lift it any time,
 * and nothing says when. The account is held an hour, then its next turn tries it again.
 */
const APP_CAP_RETRY_MS = 60 * 60_000;

/** When a limit stops holding, and whether that time is a guess rather than one the provider read. */
interface LimitEnd {
  readonly end: number;
  readonly estimated: boolean;
}

/** When a refusal stops holding: its reset, else the hold from the refusal. */
function recordedUsageLimitEnd(
  provider: ServerProvider,
  refusal: ProjectionStore.RecordedUsageLimit,
): LimitEnd {
  const refusedAt = Date.parse(refusal.refusedAt);
  if (refusal.appCap === true) {
    const reset = refusal.resetAt === null ? Infinity : Date.parse(refusal.resetAt);
    return { end: Math.min(reset, refusedAt + APP_CAP_RETRY_MS), estimated: true };
  }
  return refusal.resetAt === null
    ? { end: refusedAt + usageHoldMs(provider.usageLimits), estimated: true }
    : { end: Date.parse(refusal.resetAt), estimated: false };
}

/** Future ends of the refusals that hold `model`; a null model counts only account-wide ones. */
function refusalEnds(
  provider: ServerProvider,
  refusals: ReadonlyArray<ProjectionStore.RecordedUsageLimit>,
  nowMs: number,
  model: string | null,
): Array<LimitEnd> {
  return refusals.flatMap((refusal) => {
    if (refusal.modelScope !== undefined && !usageScopeCoversModel(refusal.modelScope, model))
      return [];
    const end = recordedUsageLimitEnd(provider, refusal);
    return end.end > nowMs ? [end] : [];
  });
}

/** When the used-up usage windows stop limiting `model` (null: account-wide), or null if none does. */
function windowLimitEnd(provider: ServerProvider, nowMs: number, model: string | null) {
  const window = exhaustedUsageWindow(provider, nowMs, model);
  return window === undefined || provider.usageLimits === undefined
    ? null
    : {
        end: usageWindowLimitEnd(provider.usageLimits, window),
        estimated: window.resetsAt === undefined,
      };
}

/** The last refusal or used-up window holding `model` (omitted: account-wide), or null if none does. */
function accountLimitDetail(
  provider: ServerProvider,
  recorded: AccountRoutingContext["recordedLimits"],
  nowMs: number,
  model?: string,
): LimitEnd | null {
  if (!isSubscriptionAccount(provider)) return null;
  const canonical = model === undefined ? null : canonicalModel(provider, model);
  const ends = refusalEnds(provider, recorded.get(provider.instanceId) ?? [], nowMs, canonical);
  const windowEnd = windowLimitEnd(provider, nowMs, canonical);
  if (windowEnd !== null) ends.push(windowEnd);
  return ends.length === 0 ? null : ends.reduce((last, end) => (end.end > last.end ? end : last));
}

/** When the last refusal or used-up window holding `model` (omitted: account-wide) ends, or null if none does. */
function accountLimitEnd(
  provider: ServerProvider,
  recorded: AccountRoutingContext["recordedLimits"],
  nowMs: number,
  model?: string,
): number | null {
  return accountLimitDetail(provider, recorded, nowMs, model)?.end ?? null;
}

function accountLimit(
  provider: ServerProvider,
  recorded: AccountRoutingContext["recordedLimits"],
  nowMs: number,
  model?: string,
): LaunchLimit | null {
  const end = accountLimitEnd(provider, recorded, nowMs, model);
  return end === null
    ? null
    : {
        instanceId: provider.instanceId,
        limitedUntil: DateTime.formatIso(DateTime.makeUnsafe(end)),
      };
}

/** Whether a model-scoped refusal still holds `model` on this subscription account. */
export function modelScopeHolds(
  provider: ServerProvider,
  input: Pick<AccountRoutingContext, "recordedLimits" | "nowMs">,
  model: string,
): boolean {
  if (!isSubscriptionAccount(provider)) return false;
  const scoped = (input.recordedLimits.get(provider.instanceId) ?? []).filter(
    (refusal) => refusal.modelScope !== undefined,
  );
  return refusalEnds(provider, scoped, input.nowMs, canonicalModel(provider, model)).length > 0;
}

/** The model this account would run for `model`, usage limits aside, or null when it cannot. */
function runnableModel(
  provider: ServerProvider,
  input: Pick<AccountRoutingContext, "settings"> & {
    readonly projectId: ProjectId;
    readonly model: string;
  },
): string | null {
  if (
    !provider.enabled ||
    !provider.installed ||
    provider.status === "error" ||
    provider.auth.status === "unauthenticated" ||
    !isProviderAvailable(provider) ||
    !resolveProjectProviderInstanceEnabled(input.settings, input.projectId, provider.instanceId)
  )
    return null;
  return resolveSelectableModel(provider.driver, input.model, provider.models);
}

/** The model this subscription account would run for `model`, usage limits aside, or null when it cannot. */
function usableModel(
  provider: ServerProvider,
  input: Pick<AccountRoutingContext, "settings"> & {
    readonly projectId: ProjectId;
    readonly model: string;
  },
): string | null {
  return isSubscriptionAccount(provider) ? runnableModel(provider, input) : null;
}

/** The model this subscription account would run for `model` now, or null when it cannot take the turn. */
export function modelWithRoom(
  provider: ServerProvider,
  input: AccountRoutingContext & { readonly projectId: ProjectId; readonly model: string },
): string | null {
  const model = usableModel(provider, input);
  return model === null ||
    accountLimitEnd(provider, input.recordedLimits, input.nowMs, model) !== null
    ? null
    : model;
}

interface AccountSearch extends AccountRoutingContext {
  readonly driver: ProviderDriverKind;
  readonly projectId: ProjectId;
  readonly model: string;
}

/** Accounts of `driver` that can run `model` now, highest in the saved account order first. */
export function accountsWithRoom(
  input: AccountSearch,
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
 * When the first account of `driver` other than `exceptInstanceId` that a usage limit keeps from
 * running `model` gets room back: the end of its last refusal or used-up window. Null when none waits.
 */
export function nextAccountRoomAt(
  input: AccountSearch & { readonly exceptInstanceId: ProviderInstanceId },
): number | null {
  if (!supportsAccountFailover(input.driver)) return null;
  const ends = input.providers.flatMap((provider) => {
    if (provider.driver !== input.driver || provider.instanceId === input.exceptInstanceId)
      return [];
    const model = usableModel(provider, input);
    const end =
      model === null ? null : accountLimitEnd(provider, input.recordedLimits, input.nowMs, model);
    return end === null ? [] : [end];
  });
  return ends.length === 0 ? null : Math.min(...ends);
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
 * A new thread whose named account is out of usage or signed out starts on the first other account
 * of its provider with room. A signed-out account with no such account hands the thread to the
 * fallback model when that can run it. Only while account switching is on, like a thread that
 * hits its limit; Auto picks are routed when their message is sent.
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
  if (current === undefined) return input.selection;
  const signedOut = current.enabled && current.auth.status === "unauthenticated";
  if (
    !signedOut &&
    accountLimitEnd(current, input.recordedLimits, input.nowMs, input.selection.model) === null
  ) {
    return input.selection;
  }
  const target = accountsWithRoom({
    ...input,
    driver: current.driver,
    model: input.selection.model,
  }).find((account) => account.instanceId !== current.instanceId);
  if (target !== undefined) {
    return { ...input.selection, instanceId: target.instanceId, model: target.model };
  }
  return signedOut ? (fallbackLaunch(input, current) ?? input.selection) : input.selection;
}

/** The fallback model selection, when it is another account that can take the launch now. */
function fallbackLaunch(
  input: AccountRoutingContext & { readonly projectId: ProjectId },
  signedOut: ServerProvider,
): ModelSelection | null {
  const fallback = input.settings.fallbackModelSelection;
  const provider = fallback
    ? input.providers.find((candidate) => candidate.instanceId === fallback.instanceId)
    : undefined;
  if (!fallback || provider === undefined || provider.instanceId === signedOut.instanceId) {
    return null;
  }
  const model = runnableModel(provider, { ...input, model: fallback.model });
  return model === null ||
    accountLimitEnd(provider, input.recordedLimits, input.nowMs, model) !== null
    ? null
    : { ...fallback, model };
}

export interface LaunchLimit {
  readonly instanceId: ProviderInstanceId;
  /** The provider's reset or T3's bounded hold end, as an ISO time. */
  readonly limitedUntil: string;
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
    /** Account-wide usage limits, ending at the provider reset or T3 hold end. */
    readonly limits: Effect.Effect<{
      readonly accounts: ReadonlyMap<ProviderInstanceId, string>;
      /** Accounts in `accounts` whose end is T3's guess, not a reset the provider read. */
      readonly estimated: ReadonlySet<ProviderInstanceId>;
      readonly models: ReadonlyMap<ProviderInstanceId, ReadonlySet<string>>;
    }>;
    /**
     * Ends the recorded holds of an account, so its next turn tries it again. A refusal after this
     * holds it again.
     */
    readonly retryAccount: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
    /** The usage-limited account a new thread on `selection` would start on, or null if it has room. */
    readonly launchLimit: (input: {
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
    const readLimits = (now: DateTime.Utc, providers: ReadonlyArray<ServerProvider>) =>
      projections.getUsageLimitedProviderInstances(now, completedRunLiftsScope(providers)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.account-routing.limits-unavailable", {
            cause,
          }).pipe(
            Effect.as(
              new Map<ProviderInstanceId, ReadonlyArray<ProjectionStore.RecordedUsageLimit>>(),
            ),
          ),
        ),
      );
    return {
      accountsWithRoom: Effect.fn("AccountRouting.accountsWithRoom")(
        function* (input) {
          const now = yield* DateTime.now;
          const providers = yield* providerRegistry.getProviders;
          return accountsWithRoom({
            ...input,
            settings: yield* serverSettings.getSettings,
            providers,
            recordedLimits: yield* readLimits(now, providers),
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
      limits: Effect.gen(function* () {
        const now = yield* DateTime.now;
        const providers = yield* providerRegistry.getProviders;
        const recorded = yield* readLimits(now, providers);
        const limited = new Map<ProviderInstanceId, string>();
        const estimated = new Set<ProviderInstanceId>();
        const models = new Map<ProviderInstanceId, ReadonlySet<string>>();
        for (const provider of providers) {
          const detail = accountLimitDetail(provider, recorded, DateTime.toEpochMillis(now));
          if (detail !== null) {
            limited.set(provider.instanceId, DateTime.formatIso(DateTime.makeUnsafe(detail.end)));
            if (detail.estimated) estimated.add(provider.instanceId);
          } else
            models.set(
              provider.instanceId,
              new Set(
                provider.models
                  .filter(
                    (model) =>
                      accountLimitEnd(
                        provider,
                        recorded,
                        DateTime.toEpochMillis(now),
                        model.slug,
                      ) !== null,
                  )
                  .map((model) => model.slug),
              ),
            );
        }
        return { accounts: limited, estimated, models };
      }),
      retryAccount: Effect.fn("AccountRouting.retryAccount")(function* (instanceId) {
        yield* projections.liftUsageLimitHolds(instanceId, yield* DateTime.now).pipe(Effect.orDie);
      }),
      launchLimit: Effect.fn("AccountRouting.launchLimit")(
        function* (input) {
          const now = yield* DateTime.now;
          const providers = yield* providerRegistry.getProviders;
          const limited = yield* readLimits(now, providers);
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
            : accountLimit(provider, limited, DateTime.toEpochMillis(now), selection.model);
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
          const providers = yield* providerRegistry.getProviders;
          return failoverLimitedLaunch({
            ...input,
            settings,
            providers,
            recordedLimits: yield* readLimits(now, providers),
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
          const providers = yield* providerRegistry.getProviders;
          return routeAutoAccount({
            ...input,
            settings: yield* serverSettings.getSettings,
            providers,
            recordedLimits: yield* readLimits(now, providers),
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
