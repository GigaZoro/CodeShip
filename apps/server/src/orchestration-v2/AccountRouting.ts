import {
  CodexSettings,
  type ModelSelection,
  type OrchestrationV2Run,
  type ProjectId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  ProviderDriverKind,
  type ProviderCreditGrant,
  type ProviderCreditUse,
  ProviderInstanceId,
  type ProviderRetryUsageLimitResult,
  type ProviderUsageHold,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  type ThreadId,
} from "@t3tools/contracts";
import { mergedProviderInstanceEnvironmentName } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { modelPicksEqual, resolveSelectableModel } from "@t3tools/shared/model";
import {
  autoModeModelFor,
  canAccountRun,
  orderProviderInstancesForFailover,
  resolveAutoModelSelection,
  supportsAccountFailover,
} from "@t3tools/shared/serverSettings";
import {
  codexCreditStanding,
  exhaustedUsageWindow,
  isSubscriptionAccount,
  nextWeeklyResetMs,
  usageHoldMs,
  usageScopeCoversModel,
  usageWindowLimitEnd,
} from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ProviderMcp from "../provider/ProviderMcp.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PrepaidCreditSpend from "./PrepaidCreditSpend.ts";
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
  /** Who asks and what is spent, for the prepaid credits the user allowed; absent: none spend. */
  readonly creditAccess?: PrepaidCreditSpend.CreditAccess;
}

/**
 * The MCP servers each account must sign in to again. An account absent from the map is not known
 * to need any: its servers were not listed, or all of them are signed in.
 */
export type McpSignInsNeeded = ReadonlyMap<ProviderInstanceId, ReadonlyArray<string>>;

/** Required wherever an account is chosen, so every builder of a routing context decides. */
export interface McpSignIns {
  readonly mcpSignInsNeeded: McpSignInsNeeded;
}

const pendingSignIns = (input: McpSignIns, instanceId: ProviderInstanceId) =>
  input.mcpSignInsNeeded.get(instanceId) ?? [];

const canonicalModel = (provider: ServerProvider, slug: string) =>
  resolveSelectableModel(provider.driver, slug, provider.models) ?? slug;

/**
 * Whether later work, completed or answered, lifts a model-scoped refusal: its model, aliases
 * resolved, is in the scope. No snapshot lifts one: partial updates refresh `checkedAt` without the
 * window they omit, so a stale bar under 100% could end the hold early.
 */
export function runLiftsScope(
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

const CODEX_DRIVER = ProviderDriverKind.make("codex");

/** What a usage limit is judged from: refusals, the provider's readings, and each account's settings. */
type LimitInput = Pick<
  AccountRoutingContext,
  "settings" | "recordedLimits" | "nowMs" | "creditAccess"
>;

const grantState = (provider: ServerProvider, input: LimitInput) =>
  PrepaidCreditSpend.creditGrantState(
    input.settings,
    provider.instanceId,
    input.creditAccess ?? PrepaidCreditSpend.NO_CREDIT_ACCESS,
  );

/** How an account's prepaid credits stand for new work; null without credits T3 could spend. */
export function creditUse(provider: ServerProvider, input: LimitInput): ProviderCreditUse | null {
  if (!isSubscriptionAccount(provider)) return null;
  const standing = codexCreditStanding(provider, input.nowMs);
  if (standing === null) return null;
  if (standing === "used_up") return "used_up";
  const grant = grantState(provider, input);
  if (grant !== "granted") return grant;
  return exhaustedUsageWindow(provider, input.nowMs, null) === undefined ? "standby" : "spending";
}

/** Whether new work on this account would spend its prepaid credits rather than its plan. */
function runsOnCredits(provider: ServerProvider, input: LimitInput, model: string | null): boolean {
  return (
    codexCreditStanding(provider, input.nowMs) === "usable" &&
    exhaustedUsageWindow(provider, input.nowMs, model) !== undefined &&
    grantState(provider, input) === "granted"
  );
}

/**
 * When the used-up usage windows stop limiting `model` (null: account-wide), or null if none does,
 * as when the user turned on spending the account's prepaid credits and some are left.
 */
function windowLimitEnd(provider: ServerProvider, input: LimitInput, model: string | null) {
  const window = exhaustedUsageWindow(provider, input.nowMs, model);
  if (window === undefined || provider.usageLimits === undefined) return null;
  if (runsOnCredits(provider, input, model)) return null;
  return {
    end: usageWindowLimitEnd(provider.usageLimits, window),
    estimated: window.resetsAt === undefined,
  };
}

/** The last refusal or used-up window holding `model` (omitted: account-wide), or null if none does. */
function accountLimitDetail(
  provider: ServerProvider,
  input: LimitInput,
  model?: string,
): LimitEnd | null {
  if (!isSubscriptionAccount(provider)) return null;
  const canonical = model === undefined ? null : canonicalModel(provider, model);
  const ends = refusalEnds(
    provider,
    input.recordedLimits.get(provider.instanceId) ?? [],
    input.nowMs,
    canonical,
  );
  const windowEnd = windowLimitEnd(provider, input, canonical);
  if (windowEnd !== null) ends.push(windowEnd);
  return ends.length === 0 ? null : ends.reduce((last, end) => (end.end > last.end ? end : last));
}

/** When the last refusal or used-up window holding `model` (omitted: account-wide) ends, or null if none does. */
function accountLimitEnd(
  provider: ServerProvider,
  input: LimitInput,
  model?: string,
): number | null {
  return accountLimitDetail(provider, input, model)?.end ?? null;
}

function accountLimit(
  provider: ServerProvider,
  input: LimitInput,
  model?: string,
): LaunchLimit | null {
  const end = accountLimitEnd(provider, input, model);
  if (end === null) return null;
  const credits = creditUse(provider, input);
  return {
    instanceId: provider.instanceId,
    limitedUntil: DateTime.formatIso(DateTime.makeUnsafe(end)),
    ...(credits === null ? {} : { credits }),
  };
}

/** Whether new work can start on an account now, judged as every launch and delegation judges it. */
function accountAdmission(
  provider: ServerProvider,
  input: LimitInput,
): ProviderRetryUsageLimitResult {
  const limit = accountLimitDetail(provider, input);
  const credits = creditUse(provider, input);
  return {
    ...(limit === null
      ? {}
      : {
          limitedUntil: DateTime.formatIso(DateTime.makeUnsafe(limit.end)),
          ...(limit.estimated ? { estimated: true as const } : {}),
        }),
    ...(credits === null ? {} : { credits }),
  };
}

/**
 * Subscription accounts an account-wide refusal holds, or that ChatGPT's app cap stopped with no
 * turn run since. A used-up usage window limits an account by itself, so Try again cannot help it.
 */
function usageHolds(
  providers: ReadonlyArray<ServerProvider>,
  input: LimitInput,
): Array<ProviderUsageHold> {
  return providers.flatMap((provider) => {
    if (!isSubscriptionAccount(provider) || windowLimitEnd(provider, input, null) !== null)
      return [];
    const refusals = (input.recordedLimits.get(provider.instanceId) ?? []).filter(
      (refusal) => refusal.modelScope === undefined,
    );
    const appCap = refusals.some((refusal) => refusal.appCap === true);
    const last = refusalEnds(provider, refusals, input.nowMs, null).reduce<LimitEnd | null>(
      (latest, end) => (latest === null || end.end > latest.end ? end : latest),
      null,
    );
    if (last === null && !appCap) return [];
    return [
      {
        instanceId: provider.instanceId,
        ...(last === null
          ? {}
          : {
              heldUntil: DateTime.formatIso(DateTime.makeUnsafe(last.end)),
              ...(last.estimated ? { estimated: true as const } : {}),
            }),
        ...(appCap ? { appCap: true as const } : {}),
      },
    ];
  });
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
  return canAccountRun(provider, input.settings, input.projectId)
    ? resolveSelectableModel(provider.driver, input.model, provider.models)
    : null;
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
  return model === null || accountLimitEnd(provider, input, model) !== null ? null : model;
}

/**
 * When a stopped run's next turn on `selection` can start: now if that account has room for it,
 * else when the last limit holding it ends. Where the run stopped, Infinity while any refusal
 * recorded there holds it, whatever its end: only a lift shows room there, since resuming when a
 * guessed end passes would refuse again every hour. Null when that account cannot run it.
 */
export function recoveryRoomAt(
  input: AccountRoutingContext & {
    readonly selection: ModelSelection;
    readonly projectId: ProjectId;
    readonly stopped: { readonly instanceId: ProviderInstanceId; readonly model: string };
  },
): number | null {
  const provider = input.providers.find(
    (candidate) => candidate.instanceId === input.selection.instanceId,
  );
  if (provider === undefined) return null;
  const model = usableModel(provider, { ...input, model: input.selection.model });
  if (model === null) return null;
  if (
    provider.instanceId === input.stopped.instanceId &&
    model === canonicalModel(provider, input.stopped.model) &&
    (input.recordedLimits.get(provider.instanceId) ?? []).some(
      (refusal) =>
        refusal.modelScope === undefined || usageScopeCoversModel(refusal.modelScope, model),
    )
  )
    return Infinity;
  return accountLimitEnd(provider, input, model) ?? input.nowMs;
}

interface AccountSearch extends AccountRoutingContext {
  readonly driver: ProviderDriverKind;
  readonly projectId: ProjectId;
  readonly model: string;
  /** Order accounts with room by their next weekly reset on `model` first, then the saved order. */
  readonly preferEarliestReset?: boolean;
}

export type ObserveAccount = (id: ProviderInstanceId, reason: AccountEligibility) => void;

export type AccountEligibility =
  | "eligible"
  | "driver_pinned"
  | "unsupported_driver"
  | "account_unavailable"
  | "usage_limited";

/**
 * Accounts of `driver` that can run `model` now, in saved order or, with `preferEarliestReset`,
 * soonest weekly reset first (unused room is lost at it). Plan usage comes before prepaid credits,
 * which cost money; within each, accounts that must sign in to an MCP server again come last.
 */
export function accountsWithRoom(
  input: AccountSearch & McpSignIns,
  observe?: ObserveAccount,
): ReadonlyArray<{
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  /** New work on it spends the prepaid credits the user allowed, not plan usage. */
  readonly onCredits: boolean;
}> {
  if (!supportsAccountFailover(input.driver)) {
    if (observe)
      for (const provider of input.providers) observe(provider.instanceId, "unsupported_driver");
    return [];
  }
  const eligible = input.providers.flatMap((provider) => {
    if (provider.driver !== input.driver) {
      observe?.(provider.instanceId, "driver_pinned");
      return [];
    }
    const model = modelWithRoom(provider, input);
    observe?.(
      provider.instanceId,
      model !== null
        ? "eligible"
        : usableModel(provider, input) === null
          ? "account_unavailable"
          : "usage_limited",
    );
    return model === null
      ? []
      : [
          {
            instanceId: provider.instanceId,
            model,
            onCredits: runsOnCredits(provider, input, canonicalModel(provider, model)),
            resetAt: input.preferEarliestReset
              ? (nextWeeklyResetMs(provider, input.nowMs, model) ?? Infinity)
              : Infinity,
          },
        ];
  });
  const ordered = orderProviderInstancesForFailover(
    input.settings.providerInstanceFailoverOrder,
    eligible,
  ).toSorted((a, b) => (a.resetAt === b.resetAt ? 0 : a.resetAt - b.resetAt));
  const signedIn = (account: { readonly instanceId: ProviderInstanceId }) =>
    pendingSignIns(input, account.instanceId).length === 0;
  return [false, true].flatMap((onCredits) => {
    const tier = ordered.filter((account) => account.onCredits === onCredits);
    return [...tier.filter(signedIn), ...tier.filter((account) => !signedIn(account))].map(
      ({ instanceId, model }) => ({ instanceId, model, onCredits }),
    );
  });
}

/** Accounts of `driver` that could run `model` but for usage, each with when its limits on it end. */
function accountsByLimitEnd(input: AccountSearch) {
  if (!supportsAccountFailover(input.driver)) return [];
  return input.providers.flatMap((provider) => {
    if (provider.driver !== input.driver) return [];
    const model = usableModel(provider, input);
    if (model === null) return [];
    const end = accountLimitEnd(provider, input, model);
    return [{ instanceId: provider.instanceId, model, end }];
  });
}

/**
 * When the first account of `driver` other than `exceptInstanceId` that a usage limit keeps from
 * running `model` gets room back: the end of its last refusal or used-up window. Null when none waits.
 */
export function nextAccountRoomAt(
  input: AccountSearch & { readonly exceptInstanceId: ProviderInstanceId },
): number | null {
  const ends = accountsByLimitEnd(input).flatMap(({ instanceId, end }) =>
    instanceId === input.exceptInstanceId || end === null ? [] : [end],
  );
  return ends.length === 0 ? null : Math.min(...ends);
}

/**
 * Of the accounts of `driver` that could run `model` but for usage, the one whose limits on it end
 * first, the highest in the saved order on a tie. Undefined when none could run it.
 */
function firstAccountWithRoomAgain(input: AccountSearch) {
  const roomAt = (account: { readonly end: number | null }) => account.end ?? input.nowMs;
  return orderProviderInstancesForFailover(
    input.settings.providerInstanceFailoverOrder,
    accountsByLimitEnd(input),
  ).toSorted((a, b) => roomAt(a) - roomAt(b))[0];
}

/**
 * What an Auto selection runs, and the model other accounts are searched for: the saved Auto
 * model, which each account matches against its own catalog, since `selection` names it by the id
 * its own account lists.
 */
export function resolveAutoRoute(
  input: Pick<AccountRoutingContext, "settings" | "providers"> & {
    readonly selection: ModelSelection;
    readonly projectId: ProjectId;
    readonly started: boolean;
  },
) {
  const selection = resolveAutoModelSelection({
    selection: input.selection,
    settings: input.settings,
    accounts: input.providers,
    projectId: input.projectId,
    started: input.started,
  });
  const driver = input.providers.find(
    (provider) => provider.instanceId === selection.instanceId,
  )?.driver;
  const auto =
    selection === input.selection || driver === undefined
      ? null
      : autoModeModelFor(input.settings, driver);
  return { selection, driver, searchModel: auto?.model ?? selection.model };
}

/**
 * Where an Auto selection runs. With account switching on, a thread keeps an account with room
 * unless the top one ranks above it (plan usage over credits, then no MCP sign-in); else the top one
 * with room. With none, it keeps one that can still run, else the one whose limit ends first.
 */
export function routeAutoAccount(
  input: AccountRoutingContext &
    McpSignIns & {
      readonly selection: ModelSelection;
      readonly projectId: ProjectId;
      /** The account the thread already runs on; null for a thread with no run yet. */
      readonly currentInstanceId: ProviderInstanceId | null;
      /** A thread that already ran keeps its provider. */
      readonly started: boolean;
      /** A scheduled task's run, which spends the room that would be lost first. */
      readonly scheduled?: boolean;
      readonly observe?: ObserveAccount;
    },
): ModelSelection {
  if (input.selection.autoAccount !== true) return input.selection;
  const { selection, driver, searchModel } = resolveAutoRoute(input);
  if (selection === input.selection || driver === undefined) return selection;
  const current = input.providers.find(
    (provider) => provider.instanceId === input.currentInstanceId && provider.driver === driver,
  );
  const search = {
    ...input,
    driver,
    model: searchModel,
    preferEarliestReset: input.scheduled === true,
  };
  const observed =
    input.observe && input.settings.failoverLimitedThreads
      ? accountsWithRoom(search, input.observe)
      : undefined;
  const pickTarget = () => {
    if (current !== undefined) {
      const model = modelWithRoom(current, search);
      if (model !== null) {
        const keep = { instanceId: current.instanceId, model };
        const onCredits = runsOnCredits(current, input, canonicalModel(current, model));
        const signedIn = pendingSignIns(input, current.instanceId).length === 0;
        if (!onCredits && signedIn) return keep;
        // Plan usage comes first, then no sign-in, so the top one is the move or there is none.
        const top = (observed ?? accountsWithRoom(search))[0];
        if (top === undefined || top.instanceId === current.instanceId) return keep;
        if (onCredits && !top.onCredits) return top;
        return !signedIn &&
          pendingSignIns(input, top.instanceId).length === 0 &&
          (onCredits || !top.onCredits)
          ? top
          : keep;
      }
    }
    const withRoom = (observed ?? accountsWithRoom(search))[0];
    if (withRoom !== undefined) return withRoom;
    // No subscription account has room. A thread keeps an account that can still run, and a new
    // one starts on its named account when that has no usage limits (an API key).
    const named = input.providers.find((provider) => provider.instanceId === selection.instanceId);
    const keep =
      current ?? (named !== undefined && !isSubscriptionAccount(named) ? named : undefined);
    const kept = keep === undefined ? null : runnableModel(keep, search);
    if (keep !== undefined && kept !== null) return { instanceId: keep.instanceId, model: kept };
    const waitOn = firstAccountWithRoomAgain(search);
    return waitOn !== undefined || current === undefined
      ? waitOn
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

/** Why a launch started on another account than the one it named. */
export type LaunchFailover =
  | { readonly reason: "usageLimit"; readonly crossProviderFrom?: ProviderInstanceId }
  | { readonly reason: "signedOut" }
  | { readonly reason: "mcpSignIn"; readonly mcpServers: ReadonlyArray<string> };

interface LaunchInput {
  readonly selection: ModelSelection;
  readonly projectId: ProjectId;
  readonly scheduled?: boolean;
  readonly fallbackModelSelections?: ReadonlyArray<ModelSelection>;
}

export interface LaunchRoute {
  readonly selection: ModelSelection;
  /** Null when the launch stays on the account it named. */
  readonly failover: LaunchFailover | null;
}

/**
 * Routes a named launch within its provider, or to the saved sign-out fallback.
 */
function routeNamedLaunch(input: AccountRoutingContext & McpSignIns & LaunchInput): LaunchRoute {
  const stay: LaunchRoute = { selection: input.selection, failover: null };
  if (!input.settings.failoverLimitedThreads || input.selection.autoAccount === true) {
    return stay;
  }
  const current = input.providers.find(
    (provider) => provider.instanceId === input.selection.instanceId,
  );
  if (current === undefined) return stay;
  const signedOut = current.enabled && current.auth.status === "unauthenticated";
  const limited = accountLimitEnd(current, input, input.selection.model) !== null;
  const onCredits =
    !limited && runsOnCredits(current, input, canonicalModel(current, input.selection.model));
  const mcpServers = pendingSignIns(input, current.instanceId);
  if (!signedOut && !limited && !onCredits && mcpServers.length === 0) return stay;
  const others = accountsWithRoom({
    ...input,
    driver: current.driver,
    model: input.selection.model,
    preferEarliestReset: input.scheduled === true,
  }).filter((account) => account.instanceId !== current.instanceId);
  const onPlan = (account: (typeof others)[number]) => !account.onCredits;
  const signedIn = (account: (typeof others)[number]) =>
    pendingSignIns(input, account.instanceId).length === 0;
  const target =
    signedOut || limited
      ? others[0]
      : onCredits
        ? (others.find(onPlan) ?? (mcpServers.length > 0 ? others.find(signedIn) : undefined))
        : others.find((account) => signedIn(account) && onPlan(account));
  if (target !== undefined) {
    return {
      selection: { ...input.selection, instanceId: target.instanceId, model: target.model },
      failover: signedOut
        ? { reason: "signedOut" }
        : limited || (onCredits && onPlan(target))
          ? { reason: "usageLimit" }
          : { reason: "mcpSignIn", mcpServers },
    };
  }
  const fallback = signedOut ? fallbackLaunch(input, current) : null;
  return fallback === null ? stay : { selection: fallback, failover: { reason: "signedOut" } };
}

function primaryLaunch(input: AccountRoutingContext & McpSignIns & LaunchInput): LaunchRoute {
  return input.selection.autoAccount === true
    ? {
        selection: routeAutoAccount({ ...input, currentInstanceId: null, started: false }),
        failover: null,
      }
    : routeNamedLaunch(input);
}

function alternateLaunches(
  input: AccountRoutingContext & LaunchInput,
  primaryDriver: ProviderDriverKind,
) {
  if (!input.settings.failoverLimitedThreads) return [];
  const eligible = input.providers.filter(
    (provider) =>
      provider.driver !== primaryDriver && canAccountRun(provider, input.settings, input.projectId),
  );
  const searches = (input.fallbackModelSelections ?? []).flatMap((selection) => {
    const named = eligible.find((provider) => provider.instanceId === selection.instanceId);
    return named === undefined ? [] : [{ selection, driver: named.driver, preferNamed: true }];
  });
  const drivers = new Set<ProviderDriverKind>();
  for (const provider of orderProviderInstancesForFailover(
    input.settings.providerInstanceFailoverOrder,
    eligible,
  )) {
    if (!supportsAccountFailover(provider.driver) || drivers.has(provider.driver)) continue;
    drivers.add(provider.driver);
    const auto = autoModeModelFor(input.settings, provider.driver);
    if (auto !== null) {
      searches.push({
        selection: {
          instanceId: provider.instanceId,
          ...auto,
          ...(input.selection.autoAccount === true ? { autoAccount: true } : {}),
        },
        driver: provider.driver,
        preferNamed: false,
      });
    }
  }
  return searches;
}

/** A fresh launch that must wait on its provider can use a configured or Auto alternative. */
export function failoverLimitedLaunch(
  input: AccountRoutingContext & McpSignIns & LaunchInput,
): LaunchRoute {
  const primary = primaryLaunch(input);
  const unchanged =
    input.selection.autoAccount === true ? { selection: input.selection, failover: null } : primary;
  const wait = selectionWait(input, primary.selection);
  if (wait === null) return unchanged;
  for (const { selection, driver, preferNamed } of alternateLaunches(input, wait.driver)) {
    const accounts = accountsWithRoom({
      ...input,
      driver,
      model: selection.model,
      preferEarliestReset: input.scheduled === true,
    });
    const named = preferNamed
      ? accounts.find(
          (candidate) =>
            candidate.instanceId === selection.instanceId &&
            pendingSignIns(input, candidate.instanceId).length === 0,
        )
      : undefined;
    const account = named ?? accounts[0];
    if (account !== undefined) {
      return {
        selection: { ...selection, instanceId: account.instanceId, model: account.model },
        failover: { reason: "usageLimit", crossProviderFrom: primary.selection.instanceId },
      };
    }
  }
  return unchanged;
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
  return model === null || accountLimitEnd(provider, input, model) !== null
    ? null
    : { ...fallback, model };
}

export interface LaunchLimit {
  readonly instanceId: ProviderInstanceId;
  /** The provider's reset or T3's bounded hold end, as an ISO time. */
  readonly limitedUntil: string;
  /** How the account's prepaid credits stand; omitted when it has none T3 could spend. */
  readonly credits?: ProviderCreditUse;
}

export class UnknownAccountError extends Schema.TaggedError<UnknownAccountError>()(
  "UnknownAccountError",
  { instanceId: ProviderInstanceId },
) {}
interface UsageWait {
  readonly driver: ProviderDriverKind;
  readonly end: number;
  readonly accounts: ReadonlyArray<ProviderInstanceId>;
}

/** When every account is limited, when the first gets room; null when one has room or none can run. */
function waitForRoom(
  driver: ProviderDriverKind,
  accounts: ReadonlyArray<{ readonly instanceId: ProviderInstanceId; readonly end: number | null }>,
): UsageWait | null {
  const ends = accounts.flatMap((account) => (account.end === null ? [] : [account.end]));
  return accounts.length === 0 || ends.length < accounts.length
    ? null
    : { driver, end: Math.min(...ends), accounts: accounts.map((account) => account.instanceId) };
}

/** A new thread on `selection` starts where routing puts it, or with switching on any account of its provider. */
function selectionWait(
  input: AccountRoutingContext & LaunchInput,
  selection: ModelSelection,
): UsageWait | null {
  const own = input.providers.find((provider) => provider.instanceId === selection.instanceId);
  if (own === undefined) return null;
  const switching = input.settings.failoverLimitedThreads && supportsAccountFailover(own.driver);
  const peerModel =
    input.selection.autoAccount === true
      ? resolveAutoRoute({ ...input, started: false }).searchModel
      : selection.model;
  const accounts = input.providers.flatMap((provider) => {
    const model =
      provider.instanceId === own.instanceId
        ? runnableModel(provider, { ...input, model: selection.model })
        : switching && provider.driver === own.driver
          ? usableModel(provider, { ...input, model: peerModel })
          : null;
    return model === null
      ? []
      : [
          {
            instanceId: provider.instanceId,
            end: accountLimitEnd(provider, input, model),
          },
        ];
  });
  return waitForRoom(own.driver, accounts);
}

function launchWait(input: AccountRoutingContext & LaunchInput): UsageWait | null {
  const primary = primaryLaunch({ ...input, mcpSignInsNeeded: new Map() });
  const blocked = selectionWait(input, primary.selection);
  if (blocked === null) return null;
  const waits = [blocked];
  for (const { selection, driver } of alternateLaunches(input, blocked.driver)) {
    const accounts = accountsByLimitEnd({ ...input, driver, model: selection.model });
    if (accounts.length === 0) continue;
    const wait = waitForRoom(driver, accounts);
    if (wait === null) return null;
    waits.push(wait);
  }
  const first = waits.reduce((earliest, wait) => (wait.end < earliest.end ? wait : earliest));
  return { ...first, accounts: waits.flatMap((wait) => wait.accounts) };
}

/** Delegation can use any account of the provider that can run in the project. */
function delegateWait(
  input: AccountRoutingContext & { readonly projectId: ProjectId },
  driver: ProviderDriverKind,
): UsageWait | null {
  return waitForRoom(
    driver,
    input.providers.flatMap((provider) =>
      provider.driver === driver && canAccountRun(provider, input.settings, input.projectId)
        ? [
            {
              instanceId: provider.instanceId,
              end: accountLimitEnd(provider, input),
            },
          ]
        : [],
    ),
  );
}

export interface UsageBlock {
  /** The provider whose accounts are all out of usage; of several, the one that gets room last. */
  readonly driver: ProviderDriverKind;
  /** When the first of that provider's accounts gets room, as an ISO time. */
  readonly until: string;
  /** Every out-of-usage account that keeps the run from starting. */
  readonly accounts: ReadonlyArray<ProviderInstanceId>;
}

/**
 * Why a run should not start now: every account a new thread on `selection` could start on, or
 * every account of a provider it delegates to, is out of usage. Null when it can start, or when
 * no account could run it at all, which is not a usage limit. A null selection judges only the
 * delegates, as for a run sent to an existing thread, which waits for its own account.
 */
export function usageBlock(
  input: AccountRoutingContext & {
    readonly selection: ModelSelection | null;
    readonly projectId: ProjectId;
    readonly delegates: ReadonlyArray<ProviderDriverKind>;
    readonly fallbackModelSelections?: ReadonlyArray<ModelSelection>;
  },
): UsageBlock | null {
  const waits = [
    input.selection === null ? null : launchWait({ ...input, selection: input.selection }),
    ...[...new Set(input.delegates)].map((driver) => delegateWait(input, driver)),
  ].filter((wait) => wait !== null);
  if (waits.length === 0) return null;
  const last = waits.reduce((latest, wait) => (wait.end > latest.end ? wait : latest));
  return {
    driver: last.driver,
    until: DateTime.formatIso(DateTime.makeUnsafe(last.end)),
    accounts: [...new Set(waits.flatMap((wait) => wait.accounts))],
  };
}

/** A limited account's usage is read again at most this often, so a limit that ended early frees it. */
const USAGE_PROBE_INTERVAL_MS = 60 * 60_000;
/**
 * A held Codex account is read this long after its refusal and as often after, since Codex says
 * whether the account may be used again, as after a banked reset.
 */
const ALLOWED_PROBE_INTERVAL_MS = 10 * 60_000;
/** How often the held accounts are listed to find the ones due a read. */
const HOLD_RELEASE_SCAN_MS = 60_000;

/** Whether a fresh reading frees a held account. */
type ReadingFrees = (provider: ServerProvider, nowMs: number) => boolean;
/** The ten-minute Codex path frees only on Codex's explicit yes; silence leaves the hourly path. */
const providerAllows: ReadingFrees = (provider) => provider.usageLimits?.usageAllowed === true;
const usageHasRoom: ReadingFrees = (provider, nowMs) =>
  provider.usageLimits?.usageAllowed !== false &&
  exhaustedUsageWindow(provider, nowMs) === undefined;

/** The thread new work is for, which decides whether the prepaid credits the user allowed apply. */
interface CreditRequest {
  readonly requesterThreadId?: ThreadId | undefined;
}

/** Why a turn may not start on an account: it would spend prepaid credits the user did not allow. */
export interface CreditRefusal {
  readonly credits: Exclude<PrepaidCreditSpend.CreditGrantState, "granted">;
  /** When the plan usage it would run on comes back. */
  readonly limitedUntil: string;
}

/** A turn running on prepaid credits its allowance no longer lets it spend. */
export interface CreditOverrun {
  readonly run: OrchestrationV2Run;
  readonly refusal: CreditRefusal;
}

/** What a turn refused or stopped for a credit refusal tells the user. */
export function creditRefusalMessage(refusal: CreditRefusal): string {
  const used = `This account's plan usage is used up until ${refusal.limitedUntil}, and work on it now would spend its prepaid credits.`;
  switch (refusal.credits) {
    case "not_enabled":
      return `${used} Spending them is off. Only you can turn it on, with Spend prepaid credits in Settings → Providers & models.`;
    case "out_of_scope":
      return `${used} You allowed them only for other threads' work.`;
    case "cap_reached":
      return `${used} The credits you allowed it are spent. Only you can raise the cap, in Settings → Providers & models.`;
  }
}

export class AccountRouting extends Context.Service<
  AccountRouting,
  {
    /** Resolves an Auto selection to the model and account its next turn runs on. */
    readonly route: (
      input: {
        readonly selection: ModelSelection;
        readonly projectId: ProjectId;
        readonly currentInstanceId: ProviderInstanceId | null;
        readonly started: boolean;
        readonly scheduled?: boolean;
        readonly observe?: ObserveAccount;
      } & CreditRequest,
    ) => Effect.Effect<ModelSelection>;
    /**
     * Subscription accounts that can run this model, in failover order, with accounts that would
     * spend prepaid credits after those with plan usage left, and within each the accounts that
     * must sign in to an MCP server again last, with the servers each must sign in to. Lists the
     * MCP servers of the provider's accounts first (bounded wait).
     */
    readonly accountsWithRoom: (
      input: {
        readonly driver: ProviderDriverKind;
        readonly projectId: ProjectId;
        readonly model: string;
      } & CreditRequest,
    ) => Effect.Effect<
      ReadonlyArray<{
        readonly instanceId: ProviderInstanceId;
        readonly model: string;
        readonly mcpSignInsNeeded: ReadonlyArray<string>;
        /** New work on it spends the prepaid credits the user turned on, not plan usage. */
        readonly onCredits: boolean;
      }>
    >;
    /** Account-wide usage limits for the requester's new work, ending at the provider reset or T3 hold end. */
    readonly limits: (input?: CreditRequest) => Effect.Effect<{
      readonly accounts: ReadonlyMap<ProviderInstanceId, string>;
      /** Accounts in `accounts` whose end is T3's guess, not a reset the provider read. */
      readonly estimated: ReadonlySet<ProviderInstanceId>;
      readonly models: ReadonlyMap<ProviderInstanceId, ReadonlySet<string>>;
      /** How each account's prepaid credits stand for this work; absent for accounts without any. */
      readonly credits: ReadonlyMap<ProviderInstanceId, ProviderCreditUse>;
      /** What the user allowed each account to spend of its prepaid credits, and what is left. */
      readonly grants: ReadonlyMap<ProviderInstanceId, ProviderCreditGrant>;
    }>;
    /**
     * Ends the recorded holds of an account, so its next turn tries it again, and says whether the
     * requester's new work can start on it now: a used-up plan still holds it unless the work may
     * spend the prepaid credits the user allowed. A refusal after this holds it again.
     */
    readonly retryAccount: (
      instanceId: ProviderInstanceId,
      request?: CreditRequest,
    ) => Effect.Effect<ProviderRetryUsageLimitResult, UnknownAccountError>;
    /**
     * Why a turn of this thread may not start on the account: its plan usage for `model` is used
     * up, so it would spend prepaid credits the user did not allow it; null when it may start.
     * Judged from a reading of the account no older than CREDIT_READING_MAX_AGE_MS.
     */
    readonly creditRefusal: (input: {
      readonly threadId: ThreadId;
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
    }) => Effect.Effect<CreditRefusal | null>;
    /** What judges the prepaid credits the user allowed for this thread's work, as every launch reads it. */
    readonly creditAccess: (
      requesterThreadId: ThreadId,
    ) => Effect.Effect<PrepaidCreditSpend.CreditAccess>;
    /**
     * The turns running or waiting on accounts whose plan usage is used up that the current
     * readings no longer let spend prepaid credits: spending is off, the allowance leaves their
     * thread out, or the count reached the cap.
     */
    readonly creditOverruns: Effect.Effect<ReadonlyArray<CreditOverrun>>;
    /** The accounts `retryAccount` can release, and the ones ChatGPT's app cap stopped. */
    readonly holds: Effect.Effect<ReadonlyArray<ProviderUsageHold>>;
    /** The usage-limited account a new thread on `selection` would start on, or null if it has room. */
    readonly launchLimit: (
      input: {
        readonly selection: ModelSelection;
        readonly projectId: ProjectId;
        readonly allowFailover?: boolean;
      } & CreditRequest,
    ) => Effect.Effect<LaunchLimit | null>;
    /**
     * The account a new thread starts on when its named one is out of usage, signed out, or must
     * sign in to an MCP server again, and why it moved. Lists the MCP servers of the provider's
     * accounts first (bounded wait), so a machine no client polls still sees fresh sign-in state;
     * Auto routes from those lists on its first turn unless this launch changes providers.
     */
    readonly failoverLaunch: (
      input: LaunchInput &
        CreditRequest & {
          readonly discoverMcpSignIns?: boolean;
        },
    ) => Effect.Effect<LaunchRoute>;
    /**
     * `usageBlock` for a scheduled occurrence. The usage of each account in the way is read again
     * first, at most once an hour per account, and a reading that shows room lifts its recorded
     * holds. A failed check returns null, so it never keeps a task from running.
     */
    readonly scheduledRunBlock: (input: {
      readonly selection: ModelSelection | null;
      readonly projectId: ProjectId;
      readonly delegates: ReadonlyArray<ProviderDriverKind>;
      readonly fallbackModelSelections?: ReadonlyArray<ModelSelection>;
    }) => Effect.Effect<UsageBlock | null>;
    /**
     * Reads the usage of each held Codex account at most every 10 minutes, and lifts its holds as
     * soon as Codex says the account may be used again. True when it lifted one. A failed read
     * leaves the hold to its reset.
     */
    readonly releaseAllowedHolds: Effect.Effect<boolean>;
  }
>()("t3/orchestration-v2/AccountRouting") {}

const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

// The instance's own CODEX_HOME is the login home when no home path is set.
const codexSignIn = (instance: ProviderInstanceConfig | undefined, platform: NodeJS.Platform) =>
  Option.match(decodeCodexSettings(instance?.config ?? {}), {
    onNone: () => "",
    onSome: (codex) =>
      JSON.stringify([
        codex.setupMode === "managed",
        codex.privateLogin === true,
        codex.homePath,
        codex.shadowHomePath,
        instance?.environment?.findLast(
          (variable) =>
            mergedProviderInstanceEnvironmentName(variable.name, platform) === "CODEX_HOME",
        )?.value ?? null,
      ]),
  });

/** Codex accounts whose settings moved them to another login, which no refusal of the old one binds. */
export function codexSignInChanges(
  previous: ProviderInstanceConfigMap,
  current: ProviderInstanceConfigMap,
  platform: NodeJS.Platform,
): Array<ProviderInstanceId> {
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])].flatMap((key) => {
    const id = ProviderInstanceId.make(key);
    const before = Object.hasOwn(previous, id) ? previous[id] : undefined;
    const after = Object.hasOwn(current, id) ? current[id] : undefined;
    if (before?.driver !== CODEX_DRIVER && after?.driver !== CODEX_DRIVER) return [];
    return codexSignIn(before, platform) === codexSignIn(after, platform) ? [] : [id];
  });
}
const USAGE_PROBE_TIMEOUT = "20 seconds";
// Codex spends credits as soon as the plan runs out, so a turn start does not trust an older reading.
const CREDIT_READING_MAX_AGE_MS = 2 * 60_000;

/** A Codex account with prepaid credits whose reading is too old to judge spending them from. */
const creditReadingIsStale = (provider: ServerProvider | undefined, nowMs: number) =>
  provider?.usageLimits !== undefined &&
  codexCreditStanding(provider, nowMs) !== null &&
  !(nowMs - Date.parse(provider.usageLimits.checkedAt) <= CREDIT_READING_MAX_AGE_MS);
const MCP_LIST_CONCURRENCY = 4;

/**
 * The MCP sign-ins each account that account switching could pick still needs. `discover` reads a
 * list no older than MCP_LIST_MAX_AGE and lists again when there is none, waiting a bounded time,
 * for launches; `loaded` only reads what a list already found, for paths that must not wait or
 * start a provider. Routing only steers, so an account whose servers cannot be read is left out.
 */
export const readMcpSignIns = Effect.fn("AccountRouting.readMcpSignIns")(function* (
  mcp: ProviderMcp.ProviderMcp["Service"],
  input: {
    readonly settings: Pick<ServerSettingsValue, "failoverLimitedThreads">;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly nowMs: number;
    readonly mode: "discover" | "loaded";
    /** Only this provider's accounts, when the choice is among them. */
    readonly driver?: ProviderDriverKind;
  },
) {
  if (!input.settings.failoverLimitedThreads) return new Map<ProviderInstanceId, Array<string>>();
  const servers = (instanceId: ProviderInstanceId) =>
    input.mode === "loaded"
      ? mcp.listLoaded(instanceId, ProviderMcp.MCP_LIST_MAX_AGE)
      : mcp.discover(instanceId);
  const accounts = input.providers.filter(
    (provider) =>
      supportsAccountFailover(provider.driver) &&
      (input.driver === undefined || provider.driver === input.driver) &&
      ProviderMcp.canListMcpServers(provider, input.nowMs),
  );
  const found = yield* Effect.forEach(
    accounts,
    (provider) =>
      servers(provider.instanceId).pipe(
        Effect.map(
          Option.map(
            (listed) =>
              [
                provider.instanceId,
                listed.filter(ProviderMcp.needsMcpSignIn).map((server) => server.name),
              ] as const,
          ),
        ),
      ),
    { concurrency: MCP_LIST_CONCURRENCY },
  );
  return new Map(
    found.flatMap((entry) =>
      Option.isSome(entry) && entry.value[1].length > 0 ? [entry.value] : [],
    ),
  );
});

export const layer = Layer.effect(
  AccountRouting,
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const mcp = yield* ProviderMcp.ProviderMcp;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const settingsChanges = yield* serverSettings.subscribeChanges;
    const platform = yield* HostProcess.Platform;
    // Without a database nothing is counted against a cap, so no account spends prepaid credits.
    const ledger = Option.getOrUndefined(yield* Effect.serviceOption(SqlClient.SqlClient));
    const logCreditSpendFailure = Effect.catchCause((cause) =>
      Effect.logWarning("orchestration-v2.account-routing.credit-spend-failed", { cause }),
    );
    // Forgets the count of every allowance the user removed, and counts a new one from now.
    const settleCreditGrants = (settings: LimitInput["settings"]) =>
      ledger === undefined
        ? Effect.void
        : PrepaidCreditSpend.forgetUngrantedSpend(ledger, settings).pipe(
            Effect.andThen(providerRegistry.getProviders),
            Effect.flatMap((providers) =>
              PrepaidCreditSpend.recordCreditBalances(ledger, providers, settings),
            ),
            logCreditSpendFailure,
          );
    if (ledger !== undefined) {
      // An allowance removed while the server was down starts again from zero.
      yield* PrepaidCreditSpend.ensureCreditSpendTable(ledger).pipe(
        Effect.andThen(serverSettings.getSettings),
        Effect.flatMap(settleCreditGrants),
        logCreditSpendFailure,
      );
      // Decisions count the reading they use; this counts the readings between them too.
      yield* forkParked(
        Stream.runForEach(providerRegistry.streamChanges, (providers) =>
          serverSettings.getSettings.pipe(
            Effect.flatMap((settings) =>
              PrepaidCreditSpend.recordCreditBalances(ledger, providers, settings),
            ),
            logCreditSpendFailure,
          ),
        ),
      );
    }
    let instances = (yield* serverSettings.getSettings.pipe(Effect.orDie)).providerInstances;
    yield* forkParked(
      Stream.runForEach(settingsChanges, (settings) => {
        const changed = codexSignInChanges(instances, settings.providerInstances, platform);
        instances = settings.providerInstances;
        return Effect.forEach(
          changed,
          (instanceId) =>
            DateTime.now.pipe(
              Effect.flatMap((now) => projections.liftUsageLimitHolds(instanceId, now)),
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestration-v2.account-routing.sign-in-lift-failed", {
                  instanceId,
                  cause,
                }),
              ),
            ),
          { discard: true },
        ).pipe(Effect.andThen(settleCreditGrants(settings)));
      }),
    );
    const readCreditAccess = Effect.fn("AccountRouting.readCreditAccess")(
      function* (
        settings: LimitInput["settings"],
        providers: ReadonlyArray<ServerProvider>,
        requesterThreadId: ThreadId | undefined,
      ) {
        const grants = PrepaidCreditSpend.creditGrants(settings);
        if (grants.size === 0 || ledger === undefined) return PrepaidCreditSpend.NO_CREDIT_ACCESS;
        // The reading this decision is made from counts first, so the cap holds against it.
        yield* PrepaidCreditSpend.recordCreditBalances(ledger, providers, settings);
        const scoped = [...grants.values()].some((grant) => grant.threadIds !== undefined);
        return {
          spent: yield* PrepaidCreditSpend.readCreditSpend(ledger),
          requesters:
            requesterThreadId === undefined
              ? []
              : scoped
                ? yield* PrepaidCreditSpend.requesterThreads(
                    projections.getThreadShell,
                    requesterThreadId,
                  )
                : [requesterThreadId],
        } satisfies PrepaidCreditSpend.CreditAccess;
      },
      // Credits are money: when the count or the requester cannot be read, nothing spends them.
      (effect) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.account-routing.credit-access-unavailable", {
              cause,
            }).pipe(Effect.as(PrepaidCreditSpend.NO_CREDIT_ACCESS)),
          ),
        ),
    );
    // Limits only steer and warn; a failed read leaves every account usable.
    const readLimits = (now: DateTime.Utc, providers: ReadonlyArray<ServerProvider>) =>
      projections.getUsageLimitedProviderInstances(now, runLiftsScope(providers)).pipe(
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
    const readUsageBlock = Effect.fn("AccountRouting.readUsageBlock")(function* (input: {
      readonly selection: ModelSelection | null;
      readonly projectId: ProjectId;
      readonly delegates: ReadonlyArray<ProviderDriverKind>;
      readonly fallbackModelSelections?: ReadonlyArray<ModelSelection>;
    }) {
      const now = yield* DateTime.now;
      const providers = yield* providerRegistry.getProviders;
      const recordedLimits = yield* readLimits(now, providers);
      const settings = yield* serverSettings.getSettings;
      // An occurrence has no thread yet, so only credits allowed to every thread let it run.
      const block = usageBlock({
        ...input,
        settings,
        providers,
        recordedLimits,
        nowMs: DateTime.toEpochMillis(now),
        creditAccess: yield* readCreditAccess(settings, providers, undefined),
      });
      return { block, providers, recordedLimits };
    });
    const probedAt = yield* Ref.make(new Map<ProviderInstanceId, number>());
    // Only a full read after the last refusal can say it no longer holds; a streamed update moves
    // `checkedAt` without reading the permission. A wrong lift costs one refused turn an hour. The
    // provider's own answer outranks its percentages, and the lift ends at the read, so a refusal
    // recorded after it still holds.
    const probeAccount = Effect.fn("AccountRouting.probeAccount")(
      function* (instanceId: ProviderInstanceId, lastRefusedAtMs: number, frees: ReadingFrees) {
        const providers = yield* providerRegistry
          .refreshInstance(instanceId)
          .pipe(Effect.timeout(USAGE_PROBE_TIMEOUT));
        const provider = providers.find((entry) => entry.instanceId === instanceId);
        const usage = provider?.usageLimits;
        const readAtMs = Date.parse(usage?.accountReadAt ?? usage?.checkedAt ?? "");
        if (
          provider === undefined ||
          usage === undefined ||
          usage.unavailable !== undefined ||
          !(readAtMs > lastRefusedAtMs) ||
          !frees(provider, DateTime.toEpochMillis(yield* DateTime.now))
        ) {
          return false;
        }
        yield* projections.liftUsageLimitHolds(instanceId, DateTime.makeUnsafe(readAtMs));
        yield* Effect.logInfo("orchestration-v2.account-routing.probe-found-room", { instanceId });
        return true;
      },
      (effect, instanceId) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.account-routing.probe-failed", {
              instanceId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        ),
    );
    const creditReads = yield* KeyedLock.make<ProviderInstanceId>();
    // Guarded by `creditReads`: when each account's last read for a turn start began.
    const creditReadStartedAt = new Map<ProviderInstanceId, number>();
    // The readings, with this account's read again when older than CREDIT_READING_MAX_AGE_MS. A
    // failed read leaves the old one; creditOverruns then stops a turn once a reading shows it
    // spending credits it may not.
    const readCreditsFresh = Effect.fn("AccountRouting.readCreditsFresh")(function* (
      instanceId: ProviderInstanceId,
      nowMs: number,
    ) {
      const providers = yield* providerRegistry.getProviders;
      if (
        !creditReadingIsStale(
          providers.find((entry) => entry.instanceId === instanceId),
          nowMs,
        )
      )
        return providers;
      return yield* creditReads.withLock(
        instanceId,
        Effect.gen(function* () {
          // Turns that start together wait for one read, failed or not.
          if ((creditReadStartedAt.get(instanceId) ?? -Infinity) >= nowMs)
            return yield* providerRegistry.getProviders;
          creditReadStartedAt.set(instanceId, DateTime.toEpochMillis(yield* DateTime.now));
          return yield* providerRegistry.refreshInstance(instanceId).pipe(
            Effect.timeout(USAGE_PROBE_TIMEOUT),
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.account-routing.credit-read-failed", {
                instanceId,
                cause,
              }).pipe(Effect.andThen(providerRegistry.getProviders)),
            ),
          );
        }),
      );
    });
    // Why this thread's work on `model` may not spend the account's prepaid credits, judged from
    // these readings; null while the plan has room or there are no credits, as the provider decides.
    const judgeCredits = Effect.fn("AccountRouting.judgeCredits")(function* (input: {
      readonly settings: LimitInput["settings"];
      readonly providers: ReadonlyArray<ServerProvider>;
      readonly provider: ServerProvider;
      readonly threadId: ThreadId;
      readonly model: string;
      readonly nowMs: number;
    }) {
      const { provider, nowMs } = input;
      if (provider.usageLimits === undefined || !isSubscriptionAccount(provider)) return null;
      const window = exhaustedUsageWindow(provider, nowMs, canonicalModel(provider, input.model));
      if (window === undefined || codexCreditStanding(provider, nowMs) !== "usable") return null;
      const state = PrepaidCreditSpend.creditGrantState(
        input.settings,
        provider.instanceId,
        yield* readCreditAccess(input.settings, input.providers, input.threadId),
      );
      return state === "granted"
        ? null
        : ({
            credits: state,
            limitedUntil: DateTime.formatIso(
              DateTime.makeUnsafe(usageWindowLimitEnd(provider.usageLimits, window)),
            ),
          } satisfies CreditRefusal);
    });
    const releaseScannedAt = yield* Ref.make(-Infinity);
    return {
      releaseAllowedHolds: Effect.gen(function* () {
        const now = yield* DateTime.now;
        const nowMs = DateTime.toEpochMillis(now);
        const scan = yield* Ref.modify(releaseScannedAt, (last) =>
          nowMs - last >= HOLD_RELEASE_SCAN_MS ? [true, nowMs] : [false, last],
        );
        if (!scan) return false;
        const providers = yield* providerRegistry.getProviders;
        const recorded = yield* readLimits(now, providers);
        // ChatGPT's app cap is not ordinary usage, so its holds keep the hourly path.
        const held = providers.flatMap((provider) => {
          const refusals = recorded.get(provider.instanceId) ?? [];
          return provider.enabled &&
            provider.driver === CODEX_DRIVER &&
            refusals.length > 0 &&
            refusals.every((refusal) => refusal.appCap === undefined)
            ? [
                {
                  instanceId: provider.instanceId,
                  lastRefusedAtMs: Math.max(
                    ...refusals.map((refusal) => Date.parse(refusal.refusedAt)),
                  ),
                },
              ]
            : [];
        });
        const due = yield* Ref.modify(probedAt, (probed) => {
          const accounts = held.filter(
            ({ instanceId, lastRefusedAtMs }) =>
              nowMs - Math.max(lastRefusedAtMs, probed.get(instanceId) ?? -Infinity) >=
              ALLOWED_PROBE_INTERVAL_MS,
          );
          if (accounts.length === 0) return [accounts, probed] as const;
          const next = new Map(probed);
          for (const { instanceId } of accounts) next.set(instanceId, nowMs);
          return [accounts, next] as const;
        });
        const found = yield* Effect.forEach(
          due,
          ({ instanceId, lastRefusedAtMs }) =>
            probeAccount(instanceId, lastRefusedAtMs, providerAllows),
          { concurrency: "unbounded" },
        );
        return found.some(Boolean);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.account-routing.hold-release-failed", {
            cause,
          }).pipe(Effect.as(false)),
        ),
        Effect.withSpan("AccountRouting.releaseAllowedHolds"),
      ),
      scheduledRunBlock: Effect.fn("AccountRouting.scheduledRunBlock")(
        function* (input) {
          const read = yield* readUsageBlock(input);
          if (read.block === null) return null;
          const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
          const probeable = read.block.accounts.filter((instanceId) => {
            const usage = read.providers.find(
              (provider) => provider.instanceId === instanceId,
            )?.usageLimits;
            return usage !== undefined && usage.unavailable?.reason !== "unsupported";
          });
          const due = yield* Ref.modify(probedAt, (probed) => {
            const accounts = probeable.filter(
              (instanceId) =>
                nowMs - (probed.get(instanceId) ?? -Infinity) >= USAGE_PROBE_INTERVAL_MS,
            );
            if (accounts.length === 0) return [accounts, probed] as const;
            const next = new Map(probed);
            for (const instanceId of accounts) next.set(instanceId, nowMs);
            return [accounts, next] as const;
          });
          const found = yield* Effect.forEach(
            due,
            (instanceId) =>
              probeAccount(
                instanceId,
                Math.max(
                  -Infinity,
                  ...(read.recordedLimits.get(instanceId) ?? []).map((refusal) =>
                    Date.parse(refusal.refusedAt),
                  ),
                ),
                usageHasRoom,
              ),
            { concurrency: "unbounded" },
          );
          return found.some(Boolean) ? (yield* readUsageBlock(input)).block : read.block;
        },
        // Skipping only saves usage; without the check the task runs as it always did.
        (effect) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.account-routing.scheduled-run-block-failed", {
                cause,
              }).pipe(Effect.as(null)),
            ),
          ),
      ),
      accountsWithRoom: Effect.fn("AccountRouting.accountsWithRoom")(
        function* (input) {
          const now = yield* DateTime.now;
          const providers = yield* providerRegistry.getProviders;
          const settings = yield* serverSettings.getSettings;
          const mcpSignInsNeeded = yield* readMcpSignIns(mcp, {
            settings,
            providers,
            nowMs: DateTime.toEpochMillis(now),
            mode: "discover",
            driver: input.driver,
          });
          return accountsWithRoom({
            ...input,
            settings,
            providers,
            recordedLimits: yield* readLimits(now, providers),
            mcpSignInsNeeded,
            nowMs: DateTime.toEpochMillis(now),
            creditAccess: yield* readCreditAccess(settings, providers, input.requesterThreadId),
          }).map((account) => ({
            ...account,
            mcpSignInsNeeded: pendingSignIns({ mcpSignInsNeeded }, account.instanceId),
          }));
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
      limits: Effect.fn("AccountRouting.limits")(function* (request?: CreditRequest) {
        const now = yield* DateTime.now;
        const providers = yield* providerRegistry.getProviders;
        const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
        const creditAccess = yield* readCreditAccess(
          settings,
          providers,
          request?.requesterThreadId,
        );
        const input: LimitInput = {
          settings,
          recordedLimits: yield* readLimits(now, providers),
          nowMs: DateTime.toEpochMillis(now),
          creditAccess,
        };
        const limited = new Map<ProviderInstanceId, string>();
        const estimated = new Set<ProviderInstanceId>();
        const models = new Map<ProviderInstanceId, ReadonlySet<string>>();
        const credits = new Map<ProviderInstanceId, ProviderCreditUse>();
        const grants = new Map<ProviderInstanceId, ProviderCreditGrant>();
        for (const [instanceId, grant] of PrepaidCreditSpend.creditGrants(settings))
          grants.set(
            instanceId,
            PrepaidCreditSpend.creditGrantReport(grant, creditAccess.spent.get(instanceId)),
          );
        for (const provider of providers) {
          const use = creditUse(provider, input);
          if (use !== null) credits.set(provider.instanceId, use);
          const detail = accountLimitDetail(provider, input);
          if (detail !== null) {
            limited.set(provider.instanceId, DateTime.formatIso(DateTime.makeUnsafe(detail.end)));
            if (detail.estimated) estimated.add(provider.instanceId);
          } else
            models.set(
              provider.instanceId,
              new Set(
                provider.models
                  .filter((model) => accountLimitEnd(provider, input, model.slug) !== null)
                  .map((model) => model.slug),
              ),
            );
        }
        return { accounts: limited, estimated, models, credits, grants };
      }),
      retryAccount: Effect.fn("AccountRouting.retryAccount")(function* (instanceId, request) {
        const providers = yield* providerRegistry.getProviders;
        const provider = providers.find((entry) => entry.instanceId === instanceId);
        if (provider === undefined) return yield* new UnknownAccountError({ instanceId });
        yield* projections.liftUsageLimitHolds(instanceId, yield* DateTime.now).pipe(Effect.orDie);
        // Judged from the same reads as every launch, so the report cannot promise what they refuse.
        const now = yield* DateTime.now;
        const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
        return accountAdmission(provider, {
          settings,
          recordedLimits: yield* readLimits(now, providers),
          nowMs: DateTime.toEpochMillis(now),
          creditAccess: yield* readCreditAccess(settings, providers, request?.requesterThreadId),
        });
      }),
      creditRefusal: Effect.fn("AccountRouting.creditRefusal")(function* (input) {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const providers = yield* readCreditsFresh(input.instanceId, nowMs);
        const provider = providers.find((entry) => entry.instanceId === input.instanceId);
        if (provider === undefined) return null;
        return yield* judgeCredits({
          settings: yield* serverSettings.getSettings.pipe(Effect.orDie),
          providers,
          provider,
          threadId: input.threadId,
          model: input.model,
          nowMs,
        });
      }),
      creditAccess: Effect.fn("AccountRouting.creditAccess")(function* (requesterThreadId) {
        const providers = yield* providerRegistry.getProviders;
        const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
        return yield* readCreditAccess(settings, providers, requesterThreadId);
      }),
      creditOverruns: Effect.gen(function* () {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        const providers = yield* providerRegistry.getProviders;
        const onCredits = providers.filter(
          (provider) =>
            isSubscriptionAccount(provider) &&
            codexCreditStanding(provider, nowMs) === "usable" &&
            exhaustedUsageWindow(provider, nowMs) !== undefined,
        );
        if (onCredits.length === 0) return [];
        const runs = yield* projections
          .getRunsUnderwayOn(onCredits.map((provider) => provider.instanceId))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.account-routing.runs-underway-unavailable", {
                cause,
              }).pipe(Effect.as([])),
            ),
          );
        const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
        const overruns = yield* Effect.forEach(runs, (run) => {
          const provider = onCredits.find((entry) => entry.instanceId === run.providerInstanceId);
          if (provider === undefined) return Effect.succeed([]);
          return judgeCredits({
            settings,
            providers,
            provider,
            threadId: run.threadId,
            model: run.modelSelection.model,
            nowMs,
          }).pipe(Effect.map((refusal) => (refusal === null ? [] : [{ run, refusal }])));
        });
        return overruns.flat();
      }).pipe(Effect.withSpan("AccountRouting.creditOverruns")),
      // Unlike routing, a list the user reads fails loudly rather than showing no holds.
      holds: Effect.gen(function* () {
        const now = yield* DateTime.now;
        const providers = yield* providerRegistry.getProviders;
        const recordedLimits = yield* projections
          .getUsageLimitedProviderInstances(now, runLiftsScope(providers))
          .pipe(Effect.orDie);
        return usageHolds(providers, {
          settings: yield* serverSettings.getSettings.pipe(Effect.orDie),
          recordedLimits,
          nowMs: DateTime.toEpochMillis(now),
        });
      }).pipe(Effect.withSpan("AccountRouting.holds")),
      launchLimit: Effect.fn("AccountRouting.launchLimit")(
        function* (input) {
          const now = yield* DateTime.now;
          const providers = yield* providerRegistry.getProviders;
          const limited = yield* readLimits(now, providers);
          const settings = yield* serverSettings.getSettings;
          // A new thread's first turn routes like this, so Auto is judged where it would start.
          const context = {
            ...input,
            settings,
            providers,
            recordedLimits: limited,
            nowMs: DateTime.toEpochMillis(now),
            mcpSignInsNeeded: new Map(),
            creditAccess: yield* readCreditAccess(settings, providers, input.requesterThreadId),
          };
          const routed =
            input.allowFailover === true
              ? failoverLimitedLaunch(context).selection
              : input.selection;
          const selection =
            routed === input.selection && input.selection.autoAccount === true
              ? primaryLaunch(context).selection
              : routed;
          const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
          return provider === undefined ? null : accountLimit(provider, context, selection.model);
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
          const stay: LaunchRoute = { selection: input.selection, failover: null };
          const settings = yield* serverSettings.getSettings;
          if (!settings.failoverLimitedThreads) return stay;
          const now = yield* DateTime.now;
          const providers = yield* providerRegistry.getProviders;
          const auto = input.selection.autoAccount === true;
          const named = auto
            ? resolveAutoModelSelection({
                selection: input.selection,
                settings,
                accounts: providers,
                projectId: input.projectId,
                started: false,
              })
            : input.selection;
          const driver = providers.find(
            (provider) => provider.instanceId === named.instanceId,
          )?.driver;
          if (driver === undefined) return stay;
          const context = {
            ...input,
            settings,
            providers,
            recordedLimits: yield* readLimits(now, providers),
            nowMs: DateTime.toEpochMillis(now),
            creditAccess: yield* readCreditAccess(settings, providers, input.requesterThreadId),
          };
          if (input.discoverMcpSignIns === false) {
            const mcpSignInsNeeded = yield* readMcpSignIns(mcp, { ...context, mode: "loaded" });
            return failoverLimitedLaunch({ ...context, mcpSignInsNeeded });
          }
          const route = failoverLimitedLaunch({ ...context, mcpSignInsNeeded: new Map() });
          const crossProvider =
            route.failover?.reason === "usageLimit" &&
            route.failover.crossProviderFrom !== undefined;
          const destinationDriver = crossProvider
            ? (providers.find((provider) => provider.instanceId === route.selection.instanceId)
                ?.driver ?? driver)
            : driver;
          const mcpSignInsNeeded = yield* readMcpSignIns(mcp, {
            ...context,
            mode: "discover",
            driver: destinationDriver,
          });
          return auto && !crossProvider
            ? stay
            : failoverLimitedLaunch({ ...context, mcpSignInsNeeded });
        },
        // Without routing the launch still runs on its own account.
        (effect, input) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.account-routing.launch-failed", { cause }).pipe(
                Effect.as({ selection: input.selection, failover: null } satisfies LaunchRoute),
              ),
            ),
          ),
      ),
      route: Effect.fn("AccountRouting.route")(
        function* (input) {
          if (input.selection.autoAccount !== true) return input.selection;
          const now = yield* DateTime.now;
          const providers = yield* providerRegistry.getProviders;
          const settings = yield* serverSettings.getSettings;
          // A message dispatch must not wait on or start a provider, so only what is loaded counts.
          return routeAutoAccount({
            ...input,
            settings,
            providers,
            recordedLimits: yield* readLimits(now, providers),
            mcpSignInsNeeded: yield* readMcpSignIns(mcp, {
              settings,
              providers,
              nowMs: DateTime.toEpochMillis(now),
              mode: "loaded",
            }),
            nowMs: DateTime.toEpochMillis(now),
            creditAccess: yield* readCreditAccess(settings, providers, input.requesterThreadId),
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
