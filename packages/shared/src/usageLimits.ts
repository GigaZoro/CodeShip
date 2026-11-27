import {
  type EnvironmentId,
  ANTIGRAVITY_DEFAULT_MODEL,
  type ModelSelection,
  type ServerSettings,
  type ProjectId,
  type UsageLimitsReport,
  type ProviderInstanceId,
  REASONING_EFFORT_OPTION_IDS,
  type ProviderConsumeResetCreditInput,
  type ProviderDriverKind,
  type ServerProviderSlashCommand,
  isProviderAvailable,
  PROVIDER_DISPLAY_NAMES,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderResetCredits,
  type ServerProviderUsageScope,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
  type UsageLimitSourceSnapshot,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import {
  canAccountRun,
  isAccountReady,
  orderProviderInstancesForFailover,
  resolveAutoModelSelection,
  supportsAccountFailover,
} from "./serverSettings.ts";
import { msg, t, tn } from "./i18n.ts";
import { isLocalLoopbackHost, isWildcardHost } from "./hostClassification.ts";
import { antigravityModelFamily, resolveSelectableModel } from "./model.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Claude's model families; a `seven_day_<family>` window or refusal holds only that family. */
export const CLAUDE_MODEL_FAMILIES: ReadonlyArray<string> = ["opus", "sonnet", "haiku", "fable"];

/** The model scope a Claude `seven_day_<scope>` window limits, such as `opus`; undefined when it limits the account. */
export function claudeUsageWindowScope(windowId: string): string | undefined {
  return windowId.match(/^seven_day_(.+)$/)?.[1];
}

/** Whether a usage scope such as `opus` covers `model`: every scope word is a word of the slug. */
export function usageScopeCoversModel(scope: string, model: string | null | undefined): boolean {
  const words = model?.toLowerCase().split(/[^a-z0-9]+/) ?? [];
  return scope.split("_").every((word) => words.includes(word));
}

// Claude and ChatGPT subscriptions use a five-hour session window. The server's hold-end index
// (migration 080) bounds refusal reads by it; a longer hold needs a new index.
const DEFAULT_USAGE_HOLD_MINS = 5 * 60;

/** How long a limit with no known end holds: the account's shortest usage window, at most five hours. */
export function usageHoldMs(limits: ServerProviderUsageLimits | undefined): number {
  const durations = (limits?.windows ?? []).flatMap((window) =>
    window.windowDurationMins != null && window.windowDurationMins > 0
      ? [window.windowDurationMins]
      : [],
  );
  return Math.min(DEFAULT_USAGE_HOLD_MINS, ...durations) * MINUTE;
}

/** When a used-up window stops limiting: its reset, else the hold from when it was first seen used up. */
export function usageWindowLimitEnd(
  limits: ServerProviderUsageLimits,
  window: ServerProviderUsageWindow,
): number {
  // Servers before `exhaustedSince` leave it out, so their windows count from the check.
  return (
    resetMillis(window) ??
    Date.parse(window.exhaustedSince ?? limits.checkedAt) + usageHoldMs(limits)
  );
}

export function usageWindowScope(
  driver: ServerProvider["driver"],
  window: ServerProviderUsageWindow,
): ServerProviderUsageScope {
  if (window.scope !== undefined) return window.scope;
  if (
    window.model !== undefined ||
    window.modelIds !== undefined ||
    window.providerIds !== undefined
  )
    return "model";
  switch (driver) {
    case "claudeAgent":
      if (window.id === "monthly_spend") return "spending-cap";
      return claudeUsageWindowScope(window.id) === undefined ? "account" : "model";
    case "antigravity":
      // An untagged gemini-weekly could be an aggregate from the legacy models endpoint.
      if (window.id === "gemini-5h") return "gemini-default";
      if (window.id.startsWith("gemini-argon-")) return "gemini-argon";
      if (window.id.startsWith("gemini-carbon-")) return "gemini-carbon";
      if (window.id.startsWith("3p-")) return "third-party";
      return "unknown";
    case "codex":
      return window.id === CODEX_CREDIT_LIMIT_WINDOW_ID ? "spending-cap" : "account";
    case "opencode":
      return window.id.startsWith("go_") ? "opencode-go" : "account";
    case "cursor":
      if (window.id === "autoPercentUsed") return "cursor-auto";
      if (window.id === "apiPercentUsed") return "cursor-api";
      return window.id === "totalPercentUsed" ? "unknown" : "account";
    default:
      return "account";
  }
}

const usesCursorAutoPool = (model: string) => /^(auto|default|grok|composer)/.test(model);

function antigravityQuotaFamily(models: ServerProvider["models"], model: string): string {
  const canonical = antigravityModelFamily(model);
  if (canonical !== undefined) return canonical;
  const entry = models.find((entry) =>
    model === ANTIGRAVITY_DEFAULT_MODEL ? entry.isDefault : entry.slug === model,
  );
  return entry && !entry.isCustom
    ? (antigravityModelFamily(entry.slug) ?? entry.nativeModelFamily ?? model)
    : model;
}

/** Whether a rate window covers a canonical model slug. Pass null for account-wide windows. */
export function usageWindowAppliesToModel(
  provider: Pick<ServerProvider, "driver" | "models">,
  window: ServerProviderUsageWindow,
  model: string | null,
): boolean {
  const scope = usageWindowScope(provider.driver, window);
  if (window.modelIds !== undefined && (model === null || !window.modelIds.includes(model)))
    return false;
  if (
    window.providerIds !== undefined &&
    (model === null || !window.providerIds.includes(model.split("/")[0] ?? ""))
  )
    return false;
  if (scope === "account") return true;
  if (model === null) return false;
  if (typeof scope === "object") return scope.models.includes(model);
  switch (scope) {
    case "model": {
      const family =
        provider.driver === "claudeAgent" ? claudeUsageWindowScope(window.id) : undefined;
      if (family !== undefined) return usageScopeCoversModel(family, model);
      return window.model === undefined
        ? window.modelIds !== undefined || window.providerIds !== undefined
        : window.model === model;
    }
    case "gemini-default": {
      const family = antigravityQuotaFamily(provider.models, model);
      return (
        family === ANTIGRAVITY_DEFAULT_MODEL ||
        (/^gemini(?:-|$)/.test(family) &&
          !usageScopeCoversModel("argon", family) &&
          !usageScopeCoversModel("carbon", family))
      );
    }
    case "gemini-argon": {
      const family = antigravityQuotaFamily(provider.models, model);
      return family.startsWith("gemini-") && usageScopeCoversModel("argon", family);
    }
    case "gemini-carbon": {
      const family = antigravityQuotaFamily(provider.models, model);
      return family.startsWith("gemini-") && usageScopeCoversModel("carbon", family);
    }
    case "third-party":
      return /^(claude|gpt)(?:-|$)/.test(antigravityQuotaFamily(provider.models, model));
    case "opencode-go":
      return model.startsWith("opencode-go/");
    case "cursor-auto":
      return usesCursorAutoPool(model);
    case "cursor-api":
      return true;
    case "spending-cap":
    case "unknown":
      return false;
  }
}

/**
 * When the first weekly window that limits `model` on this account resets, after `now`; null
 * when no reading gives one. What is left of an allowance that resets sooner is lost sooner.
 */
export function nextWeeklyResetMs(
  provider: ServerProvider,
  now: number,
  model: string,
): number | null {
  const resets = (provider.usageLimits?.windows ?? []).flatMap((window) => {
    const reset = resetMillis(window);
    return window.kind === "weekly" &&
      reset !== null &&
      reset > now &&
      usageWindowAppliesToModel(provider, window, model)
      ? [reset]
      : [];
  });
  return resets.length === 0 ? null : Math.min(...resets);
}

function usedUpWindows(provider: ServerProvider | undefined, now: number) {
  const limits = provider?.usageLimits;
  if (provider === undefined || limits === undefined) return null;
  const end = (window: ServerProviderUsageWindow) => usageWindowLimitEnd(limits, window);
  const live = limits.windows.filter((window) => {
    const scope = usageWindowScope(provider.driver, window);
    return scope !== "spending-cap" && scope !== "unknown" && end(window) > now;
  });
  const usedUp = live.filter((window) => window.usedPercent >= 100);
  const accountWide = (window: ServerProviderUsageWindow) =>
    usageWindowAppliesToModel(provider, window, null);
  if (limits.usageAllowed === true) {
    // A provider's yes covers exhaustion already observed, including bars left at 100% after a reset.
    const allowedAt = Date.parse(limits.accountReadAt ?? limits.checkedAt);
    return {
      end,
      windows: usedUp.filter(
        (window) =>
          !accountWide(window) &&
          Date.parse(window.exhaustedSince ?? window.observedAt ?? "") > allowedAt,
      ),
    };
  }
  if (limits.usageAllowed !== false || usedUp.some(accountWide)) return { end, windows: usedUp };
  // Its no outranks them too: the fullest account-wide windows hold the account until they reset.
  const held = live.filter(accountWide);
  const fullest = Math.max(...held.map((window) => window.usedPercent));
  return { end, windows: [...usedUp, ...held.filter((window) => window.usedPercent === fullest)] };
}

function latestEnding(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  end: (window: ServerProviderUsageWindow) => number,
) {
  return windows.reduce<ServerProviderUsageWindow | undefined>(
    (latest, window) => (latest === undefined || end(window) > end(latest) ? window : latest),
    undefined,
  );
}

/**
 * The used-up window that holds `model` longest, so its end is when the model has room again.
 * Omit the model to inspect any pool; null asks only for an account-wide limit.
 */
export function exhaustedUsageWindow(
  provider: ServerProvider | undefined,
  now: number,
  model?: string | null,
) {
  const used = usedUpWindows(provider, now);
  if (provider === undefined || used === null) return undefined;
  const { end } = used;
  const windows = used.windows;
  if (model === undefined) return latestEnding(windows, end);
  if (provider.driver === "cursor") {
    const api = windows.find((window) => window.id === "apiPercentUsed");
    // Auto and Cursor's own models fall back to the other pool, so the first one back frees them.
    const auto = windows.find((window) => window.id === "autoPercentUsed");
    const pooled =
      model !== null && !usesCursorAutoPool(model)
        ? api
        : auto && api && (end(auto) < end(api) ? auto : api);
    return latestEnding(
      windows.filter((window) =>
        window === auto || window === api
          ? window === pooled
          : usageWindowAppliesToModel(provider, window, model),
      ),
      end,
    );
  }
  return latestEnding(
    windows.filter((window) => usageWindowAppliesToModel(provider, window, model)),
    end,
  );
}

/** Default soft-drain threshold (%) for non-weekly / short session windows (e.g. 5-hour). */
export const DEFAULT_SOFT_DRAIN_5H_PERCENT = 88;
/** Default soft-drain threshold (%) for weekly quota windows. */
export const DEFAULT_SOFT_DRAIN_WEEKLY_PERCENT = 92;

/** Headroom penalty applied per active concurrent run on an account to avoid dogpiling. */
const ACTIVE_RUN_HEADROOM_PENALTY = 6;

function liveRateWindows(provider: ServerProvider, now: number) {
  const limits = provider.usageLimits;
  if (limits === undefined) return null;
  const end = (window: ServerProviderUsageWindow) => usageWindowLimitEnd(limits, window);
  const live = limits.windows.filter((window) => {
    const scope = usageWindowScope(provider.driver, window);
    return scope !== "spending-cap" && scope !== "unknown" && end(window) > now;
  });
  return { limits, live, end };
}

/** Whether `provider` has at least one live rate window that applies to `model`. */
export function hasLiveUsageWindows(
  provider: ServerProvider | undefined,
  now: number,
  model?: string | null,
): boolean {
  if (provider === undefined) return false;
  const rated = liveRateWindows(provider, now);
  if (rated === null) return false;
  return model === undefined
    ? rated.live.length > 0
    : rated.live.some((window) => usageWindowAppliesToModel(provider, window, model));
}

/**
 * First live, applicable usage window at or above the soft-drain threshold (88% session / 92% weekly).
 * Returns `undefined` while `usageAllowed === true` with no newer reading.
 */
export function softDrainingUsageWindow(
  provider: ServerProvider | undefined,
  now: number,
  model?: string | null,
  thresholds?: {
    readonly sessionPercent?: number;
    readonly weeklyPercent?: number;
  },
): ServerProviderUsageWindow | undefined {
  if (provider === undefined) return undefined;
  const rated = liveRateWindows(provider, now);
  if (rated === null) return undefined;
  const { limits, live, end } = rated;
  const sessionPercent = thresholds?.sessionPercent ?? DEFAULT_SOFT_DRAIN_5H_PERCENT;
  const weeklyPercent = thresholds?.weeklyPercent ?? DEFAULT_SOFT_DRAIN_WEEKLY_PERCENT;
  const exceedsThreshold = (window: ServerProviderUsageWindow) =>
    window.usedPercent >= (window.kind === "weekly" ? weeklyPercent : sessionPercent);
  const accountWide = (window: ServerProviderUsageWindow) =>
    usageWindowAppliesToModel(provider, window, null);
  const overThreshold = live.filter(exceedsThreshold);
  let windows: ReadonlyArray<ServerProviderUsageWindow>;
  if (limits.usageAllowed === true) {
    const allowedAt = Date.parse(limits.accountReadAt ?? limits.checkedAt);
    windows = overThreshold.filter(
      (window) => Date.parse(window.exhaustedSince ?? window.observedAt ?? "") > allowedAt,
    );
  } else if (limits.usageAllowed === false && !overThreshold.some(accountWide)) {
    const held = live.filter(accountWide);
    const fullest = Math.max(...held.map((window) => window.usedPercent));
    windows = [...overThreshold, ...held.filter((window) => window.usedPercent === fullest)];
  } else {
    windows = overThreshold;
  }
  if (model === undefined) return latestEnding(windows, end);
  if (provider.driver === "cursor") {
    const api = windows.find((window) => window.id === "apiPercentUsed");
    const auto = windows.find((window) => window.id === "autoPercentUsed");
    const pooled =
      model !== null && !usesCursorAutoPool(model)
        ? api
        : auto && api && (end(auto) < end(api) ? auto : api);
    return latestEnding(
      windows.filter((window) =>
        window === auto || window === api
          ? window === pooled
          : usageWindowAppliesToModel(provider, window, model),
      ),
      end,
    );
  }
  return latestEnding(
    windows.filter((window) => usageWindowAppliesToModel(provider, window, model)),
    end,
  );
}

/**
 * Remaining quota headroom (`0..100`) across all live applicable usage windows for `model`.
 * Returns `100` if no live applicable windows are reported, and `0` if `usageAllowed === false`
 * or any live applicable window is `>= 100`.
 */
export function accountHeadroomPercent(
  provider: ServerProvider | undefined,
  now: number,
  model?: string | null,
): number {
  if (provider === undefined) return 100;
  const rated = liveRateWindows(provider, now);
  if (rated === null) return 100;
  const { limits, live } = rated;
  const applicable =
    model === undefined
      ? live
      : live.filter((window) => usageWindowAppliesToModel(provider, window, model));
  if (applicable.length === 0) return 100;
  const accountWide = (window: ServerProviderUsageWindow) =>
    usageWindowAppliesToModel(provider, window, null);
  if (limits.usageAllowed === false && live.some(accountWide)) return 0;
  const allowedAt =
    limits.usageAllowed === true ? Date.parse(limits.accountReadAt ?? limits.checkedAt) : null;
  const effectiveApplicable =
    allowedAt === null
      ? applicable
      : applicable.filter(
          (window) =>
            window.usedPercent < 100 ||
            Date.parse(window.exhaustedSince ?? window.observedAt ?? "") > allowedAt,
        );
  if (effectiveApplicable.length === 0) return 100;
  let usedPercents: ReadonlyArray<number>;
  if (
    provider.driver === "cursor" &&
    model !== undefined &&
    (model === null || usesCursorAutoPool(model))
  ) {
    const auto = effectiveApplicable.find((window) => window.id === "autoPercentUsed");
    const api = effectiveApplicable.find((window) => window.id === "apiPercentUsed");
    if (auto !== undefined && api !== undefined) {
      usedPercents = [
        Math.min(auto.usedPercent, api.usedPercent),
        ...effectiveApplicable
          .filter((window) => window !== auto && window !== api)
          .map((window) => window.usedPercent),
      ];
    } else {
      usedPercents = effectiveApplicable.map((window) => window.usedPercent);
    }
  } else {
    usedPercents = effectiveApplicable.map((window) => window.usedPercent);
  }
  const maxUsedPercent = Math.max(...usedPercents);
  return Math.max(0, Math.min(100, 100 - maxUsedPercent));
}

/**
 * Ranks non-soft-draining accounts first, then highest effective headroom
 * (`accountHeadroomPercent - activeRuns * 6`), breaking ties by soonest weekly reset.
 */
export function compareAccountsByHeadroom(
  a: { readonly provider: ServerProvider; readonly activeRuns?: number; readonly model: string },
  b: { readonly provider: ServerProvider; readonly activeRuns?: number; readonly model: string },
  now: number,
): number {
  const aDraining = softDrainingUsageWindow(a.provider, now, a.model) !== undefined;
  const bDraining = softDrainingUsageWindow(b.provider, now, b.model) !== undefined;
  if (aDraining !== bDraining) return aDraining ? 1 : -1;
  const aEffectiveHeadroom =
    accountHeadroomPercent(a.provider, now, a.model) -
    Math.max(0, a.activeRuns ?? 0) * ACTIVE_RUN_HEADROOM_PENALTY;
  const bEffectiveHeadroom =
    accountHeadroomPercent(b.provider, now, b.model) -
    Math.max(0, b.activeRuns ?? 0) * ACTIVE_RUN_HEADROOM_PENALTY;
  if (aEffectiveHeadroom !== bEffectiveHeadroom) return bEffectiveHeadroom - aEffectiveHeadroom;
  const aReset = nextWeeklyResetMs(a.provider, now, a.model) ?? Infinity;
  const bReset = nextWeeklyResetMs(b.provider, now, b.model) ?? Infinity;
  if (aReset === bReset) return 0;
  return aReset - bReset;
}

/** Codex's spend control: the most of its prepaid credits a workspace member may spend each month. */
const CODEX_CREDIT_LIMIT_WINDOW_ID = "individual";

/**
 * Whether this Codex account's prepaid credits could pay for work past its plan: "used_up" when
 * the balance or the monthly credit limit is spent, null for other providers and accounts without
 * credits. A balance the reading leaves out or cannot be read as a number counts as usable.
 */
export function codexCreditStanding(
  provider: ServerProvider,
  now: number,
): "usable" | "used_up" | null {
  const limits = provider.usageLimits;
  if (provider.driver !== "codex" || limits?.credits === undefined) return null;
  const creditLimit = limits.windows.find((window) => window.id === CODEX_CREDIT_LIMIT_WINDOW_ID);
  if (
    creditLimit !== undefined &&
    creditLimit.usedPercent >= 100 &&
    usageWindowLimitEnd(limits, creditLimit) > now
  )
    return "used_up";
  if (limits.credits.unlimited || limits.credits.balance === undefined) return "usable";
  const balance = Number(limits.credits.balance);
  return Number.isFinite(balance) && balance <= 0 ? "used_up" : "usable";
}

/**
 * Like `exhaustedUsageWindow`, counting only windows that leave the account's other models
 * usable, such as Claude's weekly Opus cap. Cursor's two pools back each other up, so neither counts.
 */
export function exhaustedModelUsageWindow(
  provider: ServerProvider | undefined,
  now: number,
  model: string,
) {
  const used = usedUpWindows(provider, now);
  if (provider === undefined || used === null) return undefined;
  return latestEnding(
    used.windows.filter((window) => {
      const scope = usageWindowScope(provider.driver, window);
      return (
        scope !== "cursor-auto" &&
        scope !== "cursor-api" &&
        scope !== "account" &&
        usageWindowAppliesToModel(provider, window, model)
      );
    }),
    used.end,
  );
}

export function resolveNewThreadModelSelection(input: {
  readonly defaultSelection: ModelSelection | null;
  readonly explicitSelection?: ModelSelection | null;
  readonly fallbackSelection: ModelSelection | null;
  readonly providers: readonly ServerProvider[];
  readonly now: number;
  readonly settings?: ServerSettings;
  readonly projectId?: ProjectId | null;
}) {
  const selection = input.explicitSelection ?? input.defaultSelection;
  const unchanged = { selection, fallback: null };
  if (input.explicitSelection || !selection || selection.quotaAwareAuto || !input.fallbackSelection)
    return unchanged;
  const provider = input.providers.find((entry) => entry.instanceId === selection.instanceId);
  const window = exhaustedUsageWindow(provider, input.now, selection.model);
  const usable = (entry: ServerProvider | undefined, model: string): entry is ServerProvider =>
    entry !== undefined &&
    (input.settings
      ? canAccountRun(entry, input.settings, input.projectId ?? null)
      : isAccountReady(entry)) &&
    !exhaustedUsageWindow(entry, input.now, model);
  // As account switching does, an account takes an Auto thread only when it lists the model.
  const anyAccountUsable = (driver: ServerProvider["driver"], model: string) =>
    input.providers.some((entry) => {
      const listed =
        entry.driver === driver ? resolveSelectableModel(driver, model, entry.models) : null;
      return listed !== null && usable(entry, listed);
    });
  if (
    !provider ||
    !window ||
    (selection.autoAccount === true && anyAccountUsable(provider.driver, selection.model))
  )
    return unchanged;
  const fallbackReason = { provider, resetsAt: window.resetsAt ?? null };
  if (input.fallbackSelection.quotaAwareAuto) {
    return { selection: input.fallbackSelection, fallback: fallbackReason };
  }
  const fallbackSelection = input.settings
    ? resolveAutoModelSelection({
        selection: input.fallbackSelection,
        settings: input.settings,
        accounts: input.providers,
        projectId: input.projectId ?? null,
        started: false,
      })
    : input.fallbackSelection;
  const autoFallback = fallbackSelection.autoAccount === true;
  const fallback = input.providers.find(
    (entry) => entry.instanceId === fallbackSelection.instanceId,
  );
  if (
    !fallback ||
    !(autoFallback
      ? anyAccountUsable(fallback.driver, fallbackSelection.model)
      : usable(fallback, fallbackSelection.model))
  )
    return unchanged;
  return {
    // Auto runs the model and effort set for Auto mode.
    selection: autoFallback
      ? fallbackSelection
      : withEffortOf(fallbackSelection, selection, fallback),
    fallback: fallbackReason,
  };
}

/** The fallback keeps the default's effort level when its own model offers that level. */
function withEffortOf(
  target: ModelSelection,
  source: ModelSelection,
  provider: ServerProvider,
): ModelSelection {
  const isEffort = (option: { readonly id: string }) =>
    REASONING_EFFORT_OPTION_IDS.includes(option.id);
  if (target.options?.some(isEffort)) return target;
  const effort = source.options?.find(isEffort)?.value;
  if (typeof effort !== "string") return target;
  const descriptor = provider.models
    .find((model) => model.slug === target.model)
    ?.capabilities?.optionDescriptors?.find(
      (candidate) =>
        candidate.type === "select" &&
        isEffort(candidate) &&
        candidate.options.some((choice) => choice.id === effort),
    );
  return descriptor
    ? { ...target, options: [...(target.options ?? []), { id: descriptor.id, value: effort }] }
    : target;
}

export const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings/Usage";
export const CHATGPT_USAGE_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";
/**
 * ChatGPT's own limit on a connected app's sign-in: the plan still has room, and no setting in
 * ChatGPT lifts it. CodeShip records it when a sharing stop arrives with no exhausted window.
 */
export const CHATGPT_APP_CAP_CODE = "chatgpt_app_cap";
export const isChatGptUsageLimitCode = (code: string | null | undefined) =>
  code === CHATGPT_USAGE_LIMIT_CODE || code === CHATGPT_APP_CAP_CODE;
/** A ChatGPT Business admin caps plan use in other apps; only the admin can raise it. */
export const CHATGPT_WORKSPACE_USAGE_LIMIT_CODE =
  "subscription_sharing_workplace_individual_usage_limit_exceeded";
/** OpenAI's partner guidelines fix this wording; the user sends it to their admin themselves. */
export const CHATGPT_WORKSPACE_ADMIN_REQUEST =
  "I've reached the limit for using my ChatGPT plan in T3.CodeShip. Could you increase our workspace's usage limits so I can continue?\n\nGo to admin.openai.com → Workspace → Usage limits. Thank you!";

export function usesChatGptSharing(provider: ServerProvider | null | undefined): boolean {
  return provider?.auth.status === "authenticated" && provider.auth.subscriptionSharing === true;
}

export const CURSOR_USAGE_WINDOWS = [
  {
    id: "totalPercentUsed",
    label: msg("Overall"),
    description: msg("All usage on your plan this billing cycle."),
  },
  {
    id: "autoPercentUsed",
    label: msg("Cursor Models"),
    description: msg("Grok, Composer, and Auto use this allowance."),
  },
  {
    id: "apiPercentUsed",
    label: msg("Other Models"),
    description: msg("Usage allowance for third-party models such as Claude, GPT, and Gemini."),
  },
] as const;

export function cursorUsageWindowDetails(id: string, pool: LimitPool, resolve: typeof t = t) {
  const window = CURSOR_USAGE_WINDOWS.find((window) => window.id === id);
  const details = window && {
    id: window.id,
    label: resolve(window.label),
    description: resolve(window.description),
  };
  return details &&
    ((pool.windows.length === 1 && id === "totalPercentUsed") || hasDuplicateCursorTotal(pool))
    ? { ...details, label: null, description: undefined }
    : details;
}

function cursorUsageWindowRank(id: string): number {
  const rank = CURSOR_USAGE_WINDOWS.findIndex((window) => window.id === id);
  return rank < 0 ? CURSOR_USAGE_WINDOWS.length : rank;
}

function providersWithLimits(providers: readonly ServerProvider[]): readonly ServerProvider[] {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      provider.usageLimits !== undefined,
  );
}

export type LimitPresentations = ReadonlyMap<
  EnvironmentId,
  {
    readonly entry: { readonly target: { readonly label: string } };
    /** Without one, the environment counts as connected. */
    readonly connection?: { readonly phase: string } | undefined;
    readonly serverConfig: {
      readonly providers: readonly ServerProvider[];
      readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
    } | null;
  }
>;

/** A connected environment can re-read its limits; any other keeps showing its last reading. */
function isConnected(presentation: {
  readonly connection?: { readonly phase: string } | undefined;
}) {
  return presentation.connection === undefined || presentation.connection.phase === "connected";
}

/** A connected environment where the account can sign in to have its limits read there. */
export interface LimitsSignInTarget {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
}

export interface ExternalUsageAccount {
  readonly key: string;
  readonly names: readonly string[];
  readonly email: string | undefined;
  readonly environments: readonly string[];
  readonly signIns: readonly LimitsSignInTarget[];
}

export interface ExternalUsageLink {
  readonly driver: ProviderDriverKind;
  readonly label: string;
  readonly url: string;
  readonly message: string | undefined;
  readonly accounts: readonly ExternalUsageAccount[];
}

/** Accounts some environment or hub reads limits for, even where another sign-in of theirs cannot. */
function loginsWithLimits(presentations: LimitPresentations): ReadonlySet<string> {
  const logins = new Set<string>();
  for (const presentation of presentations.values()) {
    const reports = [
      ...providersWithLimits(presentation.serverConfig?.providers ?? []).map(nativeReport),
      ...(presentation.serverConfig?.usageLimitSources ?? []).flatMap((source) => source.accounts),
    ];
    for (const report of reports) {
      const login = accountKey(report.driver, report.email);
      if (login && report.usageLimits && limitsNotice(report.usageLimits) === null) {
        logins.add(login);
      }
    }
  }
  return logins;
}

export function collectExternalUsageLinks(
  presentations: LimitPresentations,
): readonly ExternalUsageLink[] {
  const readable = loginsWithLimits(presentations);
  const links = new Map<
    string,
    {
      readonly link: Omit<ExternalUsageLink, "accounts">;
      readonly accounts: Map<string, ExternalUsageAccount>;
    }
  >();
  for (const [environmentId, presentation] of presentations) {
    const environment = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const external = provider.usageLimits?.externalUsage;
      if (!external || provider.auth.status !== "authenticated") continue;
      const login = accountKey(provider.driver, provider.auth.email);
      const canSignIn = provider.usageLimits?.limitsSignIn === true && isConnected(presentation);
      // Its limits already show in a bar, and this environment cannot read them itself.
      if (login && readable.has(login) && !canSignIn) continue;
      const linkKey = `${provider.driver}:${external.url}`;
      const entry = links.get(linkKey) ?? {
        link: {
          ...external,
          driver: provider.driver,
          message: provider.usageLimits?.unavailable?.message,
        },
        accounts: new Map(),
      };
      links.set(linkKey, entry);
      const key = login
        ? `${login}${provider.auth.workspaceId ? `:${provider.auth.workspaceId}` : ""}`
        : `${environmentId}:${provider.instanceId}`;
      const previous = entry.accounts.get(key);
      entry.accounts.set(key, {
        key,
        names: [
          ...new Set([
            ...(previous?.names ?? []),
            provider.displayName?.trim() || String(provider.instanceId),
          ]),
        ],
        email: previous?.email ?? provider.auth.email,
        environments: [...new Set([...(previous?.environments ?? []), environment])],
        signIns: [
          ...(previous?.signIns ?? []),
          ...(canSignIn
            ? [{ environmentId, environmentLabel: environment, instanceId: provider.instanceId }]
            : []),
        ],
      });
    }
  }
  return [...links.values()].map(({ link, accounts }) => ({
    ...link,
    accounts: [...accounts.values()].sort((left, right) =>
      left.names[0]!.localeCompare(right.names[0]!),
    ),
  }));
}

function accountKey(
  driver: ServerProvider["driver"],
  email: string | undefined,
  limits?: ServerProviderUsageLimits,
): string | null {
  const normalizedEmail = email?.trim().toLowerCase();
  if (normalizedEmail) return `${driver}:${normalizedEmail}`;
  return limits?.credentialFingerprint
    ? `${driver}:credential:${limits.credentialFingerprint}`
    : null;
}

interface AccountReport {
  readonly driver: ServerProvider["driver"];
  readonly email?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly usageLimits?: ServerProviderUsageLimits | undefined;
}

const nativeReport = (provider: ServerProvider): AccountReport => ({
  driver: provider.driver,
  email: provider.auth.email,
  workspaceId: provider.auth.workspaceId,
  usageLimits: provider.usageLimits,
});

type AccountWorkspace = readonly [login: string, workspace: string];

export interface LimitAccountWorkspaces {
  readonly byLogin: ReadonlyMap<string, ReadonlySet<string>>;
  readonly byHub: ReadonlyMap<string, readonly AccountWorkspace[]>;
  readonly byNative: ReadonlyMap<string, readonly AccountWorkspace[]>;
}

function accountWorkspace(report: AccountReport): AccountWorkspace[] {
  const login = accountKey(report.driver, report.email, report.usageLimits);
  return login && report.workspaceId ? [[login, report.workspaceId]] : [];
}

function accountWorkspaces(evidence: Iterable<AccountWorkspace>) {
  const workspaces = new Map<string, Set<string>>();
  for (const [login, workspace] of evidence) {
    const known = workspaces.get(login);
    if (known === undefined) workspaces.set(login, new Set([workspace]));
    else known.add(workspace);
  }
  return workspaces;
}

export function limitAccountWorkspaces(
  presentations: LimitPresentations,
  previous?: LimitAccountWorkspaces,
): LimitAccountWorkspaces {
  const byHub = new Map<string, readonly AccountWorkspace[]>();
  const byNative = new Map<string, readonly AccountWorkspace[]>();
  for (const [environmentId, { serverConfig }] of presentations) {
    for (const source of serverConfig?.usageLimitSources ?? []) {
      const key = JSON.stringify([environmentId, source.id]);
      // A successful read replaces evidence, including an empty result. Removed hubs have no entry.
      byHub.set(
        key,
        source.error !== undefined
          ? (previous?.byHub.get(key) ?? [])
          : source.accounts.flatMap(accountWorkspace),
      );
    }
    for (const provider of serverConfig?.providers ?? []) {
      if (!provider.enabled) continue;
      const key = JSON.stringify([environmentId, provider.instanceId]);
      const unavailable =
        provider.auth.status === "unknown" ||
        provider.usageLimits?.unavailable?.reason === "probeFailed";
      byNative.set(
        key,
        unavailable
          ? (previous?.byNative.get(key) ?? accountWorkspace(nativeReport(provider)))
          : accountWorkspace(nativeReport(provider)),
      );
    }
  }
  return {
    byLogin: accountWorkspaces([...byNative.values(), ...byHub.values()].flat()),
    byHub,
    byNative,
  };
}

function accountKeyResolver(workspaces: LimitAccountWorkspaces["byLogin"]) {
  return (report: AccountReport): string | null => {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (!key) return null;
    const known = workspaces.get(key);
    if (report.workspaceId) return `${key}:${report.workspaceId}`;
    if (!known || known.size === 0) return key;
    return known.size === 1 ? `${key}:${[...known][0]}` : null;
  };
}

const hubAccountName = (account: { readonly id: string }) => account.id.replace(/\.json$/i, "");

const nativeRowKey = (
  resolveKey: ReturnType<typeof accountKeyResolver>,
  environmentId: EnvironmentId,
  provider: ServerProvider,
) => resolveKey(nativeReport(provider)) ?? `${environmentId}:${provider.instanceId}`;

const hubRowKey = (
  resolveKey: ReturnType<typeof accountKeyResolver>,
  environmentId: EnvironmentId,
  source: UsageLimitSourceSnapshot,
  account: UsageLimitSourceAccount,
) =>
  resolveKey(account) ??
  `${hubIdentity(environmentId, source)}:${account.id}${account.workspaceId ? `:${account.workspaceId}` : ""}`;

// Source ids are environment-local, so only a remote endpoint names the same hub across environments.
function hubIdentity(environmentId: EnvironmentId, source: UsageLimitSourceSnapshot): string {
  // The server supplies canonical endpoints; native URL polyfills can misparse IPv6 hosts.
  const endpoint = source.endpoint;
  const host = endpoint?.match(/^https?:\/\/(\[[\da-f:.]+\]|[^:/?#@]+)(?::\d+)?(?:\/|$)/)?.[1];
  const local =
    !host ||
    isLocalLoopbackHost(host) ||
    isWildcardHost(host) ||
    // Each machine resolves these to itself too; shared host classification leaves them out.
    /\.localhost\.*$|^\[::ffff:(?:127\.|7f[\da-f]{2}:)/i.test(host);
  return endpoint && !local ? endpoint : `${environmentId}:${source.id}`;
}

export interface LimitAccount {
  readonly key: string;
  readonly identity?: string | undefined;
  readonly driver: ServerProvider["driver"];
  readonly displayName: string | null;
  readonly email: string | undefined;
  readonly plan: string | undefined;
  readonly accentColor: string | undefined;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly sourceLabel: string | null;
  /** No environment reporting this account is connected, so its reading cannot refresh now. */
  readonly offline: boolean;
  readonly redeem: {
    readonly environmentId: EnvironmentId;
    readonly input: ProviderConsumeResetCreditInput;
  } | null;
  readonly limits: ServerProviderUsageLimits;
}

export function collectHttpQuotaSources(presentations: Parameters<typeof collectLimitAccounts>[0]) {
  return [...presentations].flatMap(([environmentId, presentation]) =>
    (presentation.serverConfig?.usageLimitSources ?? []).flatMap((source) =>
      source.kind === "http" && source.quotaAccounts?.length
        ? [
            {
              ...source,
              key: `${environmentId}:${source.id}`,
              label:
                presentations.size > 1
                  ? `${presentation.entry.target.label} · ${source.label}`
                  : source.label,
            },
          ]
        : [],
    ),
  );
}

export function collectLimitAccounts(
  presentations: LimitPresentations,
  workspaces = limitAccountWorkspaces(presentations),
): readonly LimitAccount[] {
  const accounts = new Map<string, LimitAccount>();
  const creditSources = new Map<string, LimitAccount>();
  const hubRedeems = new Map<string, LimitAccount>();
  const planSources = new Map<string, LimitAccount>();
  const merge = (key: string, next: LimitAccount) => {
    // Prefer hub redemption to clear its routing cooldown too; displayed balance still follows the freshest read.
    const previousHub = hubRedeems.get(key);
    if (
      next.redeem &&
      "sourceId" in next.redeem.input &&
      (!previousHub || Date.parse(next.limits.checkedAt) > Date.parse(previousHub.limits.checkedAt))
    ) {
      hubRedeems.set(key, next);
    }
    const previousCredit = creditSources.get(key);
    if (
      next.limits.resetCredits &&
      (!previousCredit ||
        Date.parse(next.limits.checkedAt) > Date.parse(previousCredit.limits.checkedAt))
    ) {
      creditSources.set(key, next);
    }
    const previousPlan = planSources.get(key);
    if (
      next.plan &&
      (!previousPlan ||
        Date.parse(next.limits.checkedAt) > Date.parse(previousPlan.limits.checkedAt))
    ) {
      planSources.set(key, next);
    }
    const previous = accounts.get(key);
    if (!previous) {
      accounts.set(key, next);
      return;
    }
    const fresher = Date.parse(next.limits.checkedAt) > Date.parse(previous.limits.checkedAt);
    const environments = [
      ...previous.environments,
      ...next.environments.filter(
        (candidate) =>
          !previous.environments.some((seen) => seen.environmentId === candidate.environmentId),
      ),
    ];
    const winner = fresher ? next : previous;
    const creditSource = creditSources.get(key);
    // A hub e-mail names the account better than the driver's default instance name.
    const hubEmail = [previous, next].some(
      (account) => account.environments.length === 0 && account.email,
    );
    const displayName = previous.displayName ?? next.displayName;
    accounts.set(key, {
      ...previous,
      displayName:
        hubEmail &&
        displayName?.toLowerCase() === PROVIDER_DISPLAY_NAMES[previous.driver]?.toLowerCase()
          ? null
          : displayName,
      plan: planSources.get(key)?.plan ?? previous.plan ?? next.plan,
      accentColor: previous.accentColor ?? next.accentColor,
      environments,
      sourceLabel: environments.length > 0 ? null : (previous.sourceLabel ?? next.sourceLabel),
      offline: previous.offline && next.offline,
      redeem:
        hubRedeems.get(key)?.redeem ??
        (creditSource ? creditSource.redeem : (winner.redeem ?? previous.redeem ?? next.redeem)),
      limits: {
        ...winner.limits,
        ...(creditSource?.limits.resetCredits
          ? { resetCredits: creditSource.limits.resetCredits }
          : { resetCredits: undefined }),
      },
    });
  };
  const resolveKey = accountKeyResolver(workspaces.byLogin);
  for (const [environmentId, presentation] of presentations) {
    const label = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (!provider.usageLimits || limitsNotice(provider.usageLimits) !== null) continue;
      const identity = resolveKey(nativeReport(provider)) ?? undefined;
      const key = identity ?? `${environmentId}:${provider.instanceId}`;
      merge(key, {
        key,
        identity,
        driver: provider.driver,
        displayName: provider.displayName?.trim() || null,
        email: provider.auth.email,
        // A ChatGPT-shared login's label names the connection, not the plan.
        plan: usesChatGptSharing(provider) ? undefined : provider.auth.label,
        accentColor: provider.accentColor,
        environments: [{ environmentId, label }],
        sourceLabel: null,
        offline: !isConnected(presentation),
        redeem: { environmentId, input: { instanceId: provider.instanceId } },
        limits: provider.usageLimits,
      });
    }
  }
  const labelEnvironment = presentations.size > 1;
  for (const [environmentId, presentation] of presentations) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      const sourceLabel = labelEnvironment
        ? `${presentation.entry.target.label} · ${source.label}`
        : source.label;
      for (const account of source.accounts) {
        if (limitsNotice(account.usageLimits) !== null) continue;
        const identity = resolveKey(account) ?? undefined;
        const key =
          identity ??
          `${hubIdentity(environmentId, source)}:${account.id}${account.workspaceId ? `:${account.workspaceId}` : ""}`;
        merge(key, {
          key,
          identity,
          driver: account.driver,
          displayName: account.email ? null : hubAccountName(account),
          email: account.email,
          plan: account.plan,
          accentColor: undefined,
          environments: [],
          sourceLabel,
          offline: !isConnected(presentation),
          redeem: account.usageLimits.resetCredits?.nextCreditId
            ? {
                environmentId,
                input: {
                  sourceId: source.id,
                  accountId: account.id,
                  creditId: account.usageLimits.resetCredits.nextCreditId,
                },
              }
            : null,
          limits: account.usageLimits,
        });
      }
    }
  }
  return [...accounts.values()];
}

/** Where an account's limits are read: the environments it is signed in on, or its hub. */
export function limitAccountLocations(account: LimitAccount): readonly string[] {
  if (account.environments.length > 0) {
    return account.environments.map((environment) => environment.label);
  }
  return account.sourceLabel === null ? [] : [account.sourceLabel];
}

const older = (left: string | null, right: string) =>
  left === null || Date.parse(right) < Date.parse(left) ? right : left;

/**
 * How old the shown limits are: the stalest reading from a connected environment, and apart from
 * it each disconnected environment or hub with the oldest reading it last sent.
 */
export function limitsFreshness(accounts: readonly LimitAccount[]): {
  readonly checkedAt: string | null;
  readonly offline: ReadonlyArray<{ readonly label: string; readonly checkedAt: string }>;
} {
  let checkedAt: string | null = null;
  const offline = new Map<string, string>();
  for (const account of accounts) {
    if (!account.offline) {
      checkedAt = older(checkedAt, account.limits.checkedAt);
      continue;
    }
    const locations = limitAccountLocations(account);
    for (const label of locations.length > 0 ? locations : [String(account.driver)]) {
      offline.set(label, older(offline.get(label) ?? null, account.limits.checkedAt));
    }
  }
  return {
    checkedAt,
    offline: [...offline].map(([label, at]) => ({ label, checkedAt: at })),
  };
}

/** Hub accounts whose read failed and that no other report shows as a row, with their names. */
function unshownFailedHubAccounts(
  presentations: LimitPresentations,
): ReadonlyMap<UsageLimitSourceAccount, string> {
  const resolveKey = accountKeyResolver(limitAccountWorkspaces(presentations).byLogin);
  const shownRows = new Set<string>();
  for (const [environmentId, presentation] of presentations) {
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (provider.usageLimits && limitsNotice(provider.usageLimits) === null) {
        shownRows.add(nativeRowKey(resolveKey, environmentId, provider));
      }
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      for (const account of source.accounts) {
        if (limitsNotice(account.usageLimits) === null) {
          shownRows.add(hubRowKey(resolveKey, environmentId, source, account));
        }
      }
    }
  }
  const failed = new Map<UsageLimitSourceAccount, string>();
  for (const [environmentId, presentation] of presentations) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      for (const account of source.accounts) {
        if (account.usageLimits.unavailable?.reason !== "probeFailed") continue;
        if (shownRows.has(hubRowKey(resolveKey, environmentId, source, account))) continue;
        failed.set(account, account.email ?? hubAccountName(account));
      }
    }
  }
  return failed;
}

export function collectLimitNotices(
  presentations: LimitPresentations,
  resolve: typeof t = t,
): readonly string[] {
  const label = (environmentLabel: string, subject: string) =>
    presentations.size > 1 ? `${environmentLabel} · ${subject}` : subject;
  const noticeLine = (subject: string, notice: string) =>
    resolve(msg("{subject}: {notice}"), { subject, notice });
  const notices = new Set<string>();
  // A failed hub read needs no notice when another report already shows the account's row.
  const failedAccounts = unshownFailedHubAccounts(presentations);
  for (const presentation of presentations.values()) {
    const environmentLabel = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const limits = provider.usageLimits;
      // A bare unsupported means the account has no limits; an external usage link shows its message.
      if (
        limits?.unavailable?.reason === "unsupported" &&
        (!limits.unavailable.message || limits.externalUsage)
      ) {
        continue;
      }
      const notice = limits ? limitsNotice(limits, resolve) : null;
      const name = provider.displayName?.trim() || String(provider.driver);
      if (notice) notices.add(noticeLine(label(environmentLabel, name), notice));
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.error) {
        notices.add(noticeLine(label(environmentLabel, source.label), source.error));
      } else if (
        (source.kind === "http" ? (source.quotaAccounts?.length ?? 0) : source.accounts.length) ===
        0
      ) {
        notices.add(
          resolve(msg("{source}: No accounts reported."), {
            source: label(environmentLabel, source.label),
          }),
        );
      }
      for (const account of source.accounts) {
        const name = failedAccounts.get(account);
        if (name === undefined) continue;
        const notice = limitsNotice(account.usageLimits, resolve);
        if (notice !== null)
          notices.add(noticeLine(`${label(environmentLabel, source.label)} · ${name}`, notice));
      }
    }
  }
  return [...notices];
}

export interface LimitPoolMember {
  readonly account: LimitAccount;
  readonly window: ServerProviderUsageWindow;
  readonly refillPercent: number;
}

export interface LimitPoolWindow {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly members: readonly LimitPoolMember[];
  readonly columns: ReadonlyArray<
    LimitPoolMember | { readonly account: LimitAccount; readonly window: null }
  >;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly pace: LimitPace | null;
  readonly resets: ReadonlyArray<{
    readonly member: LimitPoolMember;
    readonly at: number;
    readonly restoresPercent: number;
  }>;
}

export interface LimitPool {
  readonly driver: ServerProvider["driver"];
  readonly accounts: readonly LimitAccount[];
  readonly windows: readonly LimitPoolWindow[];
}

function hasDuplicateCursorTotal(pool: LimitPool): boolean {
  if (pool.windows.length !== 2) return false;
  const total = pool.windows.find((window) => window.id === "totalPercentUsed");
  const auto = pool.windows.find((window) => window.id === "autoPercentUsed");
  return (
    total !== undefined &&
    auto !== undefined &&
    total.members.length === auto.members.length &&
    total.members.every(({ account, window }) =>
      account.limits.windows.some(
        (candidate) =>
          candidate.id === auto.id &&
          candidate.kind === auto.kind &&
          candidate.usedPercent === window.usedPercent &&
          candidate.resetsAt === window.resetsAt,
      ),
    )
  );
}

export function displayLimitWindows(pool: LimitPool) {
  if (pool.driver !== "cursor") return pool.windows;
  const hasAuto = pool.windows.some((window) => window.id === "autoPercentUsed");
  const hasApi = pool.windows.some((window) => window.id === "apiPercentUsed");
  const hideTotal = (hasAuto && hasApi) || hasDuplicateCursorTotal(pool);
  return pool.windows
    .filter((window) => !hideTotal || window.id !== "totalPercentUsed")
    .sort((left, right) => cursorUsageWindowRank(left.id) - cursorUsageWindowRank(right.id));
}

/**
 * The window closest to running out across providers. Session and weekly allowances gate work, so a
 * provider's monthly spend cap or one-off quota counts only when it reports neither.
 */
export function tightestLimitWindow(pools: readonly LimitPool[], now = -Infinity) {
  let tightest: { readonly pool: LimitPool; readonly window: LimitPoolWindow } | null = null;
  for (const pool of pools) {
    const windows = displayLimitWindows(pool).filter(({ members }) =>
      members.some(({ window }) => (resetMillis(window) ?? Infinity) > now),
    );
    const gating = windows.filter(
      (window) => window.kind === "session" || window.kind === "weekly",
    );
    for (const window of gating.length > 0 ? gating : windows) {
      if (tightest === null || window.remainingPercent < tightest.window.remainingPercent) {
        tightest = { pool, window };
      }
    }
  }
  return tightest;
}

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function collectLimitPools(
  accounts: readonly LimitAccount[],
  now: number,
): readonly LimitPool[] {
  const byDriver = new Map<ServerProvider["driver"], LimitAccount[]>();
  for (const account of accounts) {
    const list = byDriver.get(account.driver);
    if (list) list.push(account);
    else byDriver.set(account.driver, [account]);
  }
  return [...byDriver].map(([driver, members]) => {
    const sorted = [...members].sort(
      (left, right) =>
        accountSortName(left).localeCompare(accountSortName(right)) ||
        left.key.localeCompare(right.key),
    );
    return { driver, accounts: sorted, windows: poolWindows(sorted, now) };
  });
}

/** Every pool shows a relative "checked … ago" label besides any countdown, so either needs the minute clock. */
export function showsRelativeLimitTimes(accounts: readonly LimitAccount[]): boolean {
  return accounts.length > 0;
}

export function findLimitAccountWindow(
  pools: readonly LimitPool[],
  accountKey: string,
  windowId: string,
  kind: LimitPoolWindow["kind"],
) {
  for (const pool of pools) {
    for (const window of displayLimitWindows(pool)) {
      if (window.kind !== kind) continue;
      const member = window.members.find(
        ({ account, window: reading }) =>
          account.key === accountKey && (window.id === windowId || reading.id === windowId),
      );
      if (member !== undefined)
        return {
          account: member.account,
          window: member.window,
          reset: window.resets.find(({ member }) => member.account.key === accountKey),
        };
    }
  }
  return null;
}

function accountSortName(account: LimitAccount): string {
  return (
    account.identity?.slice(account.driver.length + 1) ??
    account.displayName ??
    account.email ??
    account.key
  ).toLowerCase();
}

const CODEX_PLAN_CAPACITY: Record<string, number> = {
  "ChatGPT Plus Subscription": 1,
  "ChatGPT Pro 100 Subscription": 5,
  "ChatGPT Pro 200 Subscription": 20,
};
// Claude's published plan multipliers describe the session allowance only.
const CLAUDE_SESSION_CAPACITY: Record<string, number> = { Pro: 1, Max: 5, Ultra: 20 };

function planCapacity(account: LimitAccount, kind: ServerProviderUsageWindow["kind"]) {
  if (!account.plan) return undefined;
  if (account.driver === "codex" && (kind === "session" || kind === "weekly")) {
    return CODEX_PLAN_CAPACITY[account.plan];
  }
  if (account.driver === "claudeAgent" && kind === "session") {
    return CLAUDE_SESSION_CAPACITY[account.plan];
  }
  return undefined;
}

// Codex ids name slots, so pool by kind; other drivers' ids identify distinct allowances.
function poolKey(driver: ServerProvider["driver"], window: ServerProviderUsageWindow): string {
  return driver === "codex" ? window.kind : `${window.kind}:${window.id}`;
}

function poolMember(account: LimitAccount, reported: ServerProviderUsageWindow, now: number) {
  const spentWeekly =
    reported.kind === "session"
      ? account.limits.windows.find(
          (window) =>
            window.kind === "weekly" &&
            window.usedPercent >= 100 &&
            usageWindowScope(account.driver, window) === "account",
        )
      : undefined;
  if (!spentWeekly) return { account, window: reported, refillPercent: reported.usedPercent };

  const weeklyReset = resetMillis(spentWeekly);
  const sessionReset = resetMillis(reported);
  const cutoff = Math.max(now, Date.parse(account.limits.checkedAt));
  let resetsAt: string | undefined;
  let refillPercent = 0;
  // Only a stale or missing weekly clock hides when blocked quota becomes usable. Claude drops the
  // session clock while no session runs, and a lapsed one has already refilled before the week.
  if (weeklyReset !== null && weeklyReset > cutoff) {
    if (sessionReset !== null && sessionReset <= weeklyReset) {
      resetsAt = spentWeekly.resetsAt;
      refillPercent = 100;
    } else if (sessionReset !== null && reported.usedPercent >= 100) {
      resetsAt = reported.resetsAt;
      refillPercent = 100;
    } else if (reported.usedPercent < 100) {
      resetsAt = spentWeekly.resetsAt;
      refillPercent = 100 - Math.max(0, reported.usedPercent);
    }
  }
  return {
    account,
    // Suppression is not session spending, so it has no session pace clock.
    window: { ...reported, usedPercent: 100, resetsAt, windowDurationMins: undefined },
    refillPercent,
  };
}

/** Neumaier compensated summation. */
function compensatedSum(values: readonly number[]): number {
  let sum = 0;
  let correction = 0;
  for (const value of values) {
    const next = sum + value;
    correction += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
    sum = next;
  }
  return sum + correction;
}

function poolWindows(accounts: readonly LimitAccount[], now: number): readonly LimitPoolWindow[] {
  const byKey = new Map<string, LimitPoolMember[]>();
  for (const account of accounts) {
    for (const reported of account.limits.windows) {
      const member = poolMember(account, reported, now);
      const { window } = member;
      const pooled = poolKey(account.driver, window);
      const key = byKey.get(pooled)?.some((member) => member.account === account)
        ? `${window.kind}:${window.id}`
        : pooled;
      const list = byKey.get(key);
      if (list) list.push(member);
      else byKey.set(key, [member]);
    }
  }
  const pools = [...byKey].map(([key, members]): LimitPoolWindow => {
    const memberByAccount = new Map(members.map((member) => [member.account.key, member]));
    const first = members[0]!.window;
    const id = members[0]!.account.driver === "codex" ? key : first.id;
    // One unknown plan makes the pool incomparable by plan, so every member then counts once.
    const capacities = members.map((m) => planCapacity(m.account, first.kind));
    const weights = capacities.every((capacity) => capacity !== undefined)
      ? capacities
      : members.map(() => 1);
    const weightOf = new Map(members.map((m, index) => [m, weights[index]!]));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    // Sum in value order so reset order cannot change the rounded result.
    const usedPercent =
      compensatedSum(
        members.map((m) => m.window.usedPercent * weightOf.get(m)!).sort((a, b) => a - b),
      ) / totalWeight;
    // Judge pace only for windows with reset clocks; others add spend without elapsed time.
    const timed = members.flatMap((m) => {
      const share = elapsedShare(m.window, now);
      return share === null
        ? []
        : [{ used: m.window.usedPercent, elapsed: share, weight: weightOf.get(m)! }];
    });
    const timedWeight = timed.reduce((sum, t) => sum + t.weight, 0);
    const timedUsed = timed.reduce((sum, t) => sum + t.used * t.weight, 0) / timedWeight;
    const meanElapsed =
      timed.length > 0
        ? timed.reduce((sum, t) => sum + t.elapsed * t.weight, 0) / timedWeight
        : null;
    const resets = members
      .flatMap((member) => {
        const at = resetMillis(member.window);
        return at === null
          ? []
          : [
              {
                member,
                at,
                restoresPercent: Math.round(
                  (member.refillPercent * weightOf.get(member)!) / totalWeight,
                ),
              },
            ];
      })
      .sort((left, right) => left.at - right.at);
    return {
      id,
      kind: first.kind,
      label: first.label,
      members,
      columns: accounts.map(
        (account) => memberByAccount.get(account.key) ?? { account, window: null },
      ),
      usedPercent: Math.round(usedPercent),
      remainingPercent: Math.round(100 - usedPercent),
      pace: meanElapsed === null ? null : paceOfShares(timedUsed, meanElapsed),
      resets,
    };
  });
  return pools.sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind]);
}

export function limitsNotice(
  limits: ServerProviderUsageLimits,
  resolve: typeof t = t,
): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? resolve(msg("This account has no subscription limits."));
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? resolve(msg("Could not read limits."));
  }
  return limits.windows.length === 0 ? resolve(msg("No limits reported.")) : null;
}

export function remainingPercent(window: ServerProviderUsageWindow): number {
  return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
}

export function limitResetTimes(presentations: LimitPresentations): number[] {
  const resets: number[] = [];
  for (const { serverConfig } of presentations.values()) {
    const reports = [
      ...providersWithLimits(serverConfig?.providers ?? []),
      ...(serverConfig?.usageLimitSources ?? []).flatMap(({ accounts }) => accounts),
    ];
    for (const report of reports) {
      for (const window of report.usageLimits?.windows ?? []) {
        const reset = resetMillis(window);
        if (reset !== null) resets.push(reset);
      }
    }
  }
  return resets;
}

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

export function elapsedShare(window: ServerProviderUsageWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowDurationMins === undefined) return null;
  const length = window.windowDurationMins * MINUTE;
  if (length <= 0) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

// Bars show quota remaining, so even pace tracks time remaining.
export function paceRemainingPercent(
  window: ServerProviderUsageWindow,
  now: number,
): number | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : Math.round((1 - elapsed) * 100);
}

export type LimitPace = "ahead" | "on" | "under";

export function paceOf(window: ServerProviderUsageWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : paceOfShares(window.usedPercent, elapsed);
}

function paceOfShares(usedPercent: number, elapsed: number): LimitPace {
  const gap = usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

/** A time left under a minute reads "<1m", so every countdown and expiry keeps its own sentence. */
export function formatDuration(ms: number, resolve: typeof t = t): string {
  const remaining = Math.max(0, ms);
  if (remaining < MINUTE) return resolve(msg("<1m"));
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return resolve(msg("{days}d {hours}h"), { days, hours });
  if (hours > 0) return resolve(msg("{hours}h {minutes}m"), { hours, minutes });
  return resolve(msg("{minutes}m"), { minutes });
}

/** One redeemable reset as clients offer it; `input` already names the chosen credit. */
export interface ResetCreditChoice {
  readonly key: string;
  readonly summary: string;
  readonly actionLabel: string;
  readonly confirmDescription: string;
  readonly availableCount: number;
  readonly input: ProviderConsumeResetCreditInput;
}

export function resetCreditChoices(
  credits: ServerProviderResetCredits,
  input: ProviderConsumeResetCreditInput,
  now: number,
  compact = false,
  resolve: typeof t = t,
): ReadonlyArray<ResetCreditChoice> {
  const expiresIn = (at: string | undefined) =>
    at ? formatDuration(Date.parse(at) - now, resolve) : null;
  if (credits.options && "instanceId" in input) {
    return credits.options.map((option) => {
      const expires = expiresIn(option.expiresAt);
      const values = { label: option.label, count: option.availableCount };
      return {
        key: option.creditId,
        summary: expires
          ? resolve(msg("{label} · {count} left · expires in {expires}"), { ...values, expires })
          : resolve(msg("{label} · {count} left"), values),
        actionLabel: resolve(msg("Use")),
        confirmDescription: resolve(msg("{label}: {description} This cannot be undone."), {
          label: option.label,
          description: option.description,
        }),
        availableCount: option.availableCount,
        input: { ...input, creditId: option.creditId },
      };
    });
  }
  const count = credits.availableCount;
  const expires = expiresIn(credits.nextExpiresAt);
  return [
    {
      key: "next",
      summary:
        count === 0
          ? resolve(msg("No reset credits banked"))
          : compact
            ? expires
              ? resolve(msg("{count} banked · expires in {expires}"), { count, expires })
              : resolve(msg("{count} banked"), { count })
            : expires
              ? tn(
                  count,
                  "{count} reset credit banked · next expires in {expires}",
                  "{count} reset credits banked · next expires in {expires}",
                  { expires },
                )
              : tn(count, "{count} reset credit banked", "{count} reset credits banked"),
      actionLabel: resolve(msg("Use reset")),
      confirmDescription: resolve(
        msg(
          "This redeems one credit on your account and clears the current rate-limit windows. It cannot be undone.",
        ),
      ),
      availableCount: count,
      input,
    },
  ];
}

/**
 * `full` reads "resets in 2h 5m", `sentence` reads "Resets in 2h 5m", `after` reads "in 2h 5m",
 * `arrow` reads "↻ 2h 5m", and `duration` is just "2h 5m".
 */
export type ResetsInForm = "full" | "sentence" | "after" | "arrow" | "duration";

export function formatResetsIn(
  window: ServerProviderUsageWindow,
  now: number,
  form: ResetsInForm = "full",
): string | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  if (resetsAt <= now) {
    return form === "after" ? t("now") : form === "sentence" ? t("Resets now") : t("resets now");
  }
  const duration = formatDuration(resetsAt - now);
  switch (form) {
    case "duration":
      return duration;
    case "arrow":
      return t("↻ {duration}", { duration });
    case "after":
      return t("in {duration}", { duration });
    case "sentence":
      return t("Resets in {duration}", { duration });
    case "full":
      return t("resets in {duration}", { duration });
  }
}

/**
 * What a window card says about its reset: one account's own reset time, or with several
 * accounts the next reset that hands quota back to the pool.
 */
export function poolResetSummary(
  pool: LimitPoolWindow,
  now: number,
): { readonly text: string; readonly resetsAt: string | null } | null {
  if (pool.columns.length === 1) {
    const window = pool.members[0]?.window;
    const text = window ? formatResetsIn(window, now, "sentence") : null;
    return window?.resetsAt && text ? { text, resetsAt: window.resetsAt } : null;
  }
  const next = pool.resets.find((reset) => reset.at > now && reset.restoresPercent > 0);
  const when = next ? formatResetsIn(next.member.window, now, "after") : null;
  return next && when
    ? {
        text: t("+{percent}% back {when}", { percent: next.restoresPercent, when }),
        resetsAt: null,
      }
    : null;
}

export type ResetCountdown =
  | { readonly kind: "now" }
  | { readonly kind: "momentarily" }
  | { readonly kind: "in"; readonly ms: number };

export function resetCountdown(
  window: ServerProviderUsageWindow,
  now: number,
): ResetCountdown | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  if (resetsAt <= now) return { kind: "now" };
  if (resetsAt - now < MINUTE) return { kind: "momentarily" };
  return { kind: "in", ms: resetsAt - now };
}

export const USAGE_LIMITS_COMMAND = {
  name: "usage-limits",
  description: "Show this provider's usage limits",
} satisfies ServerProviderSlashCommand;

export function isUsageLimitsCommand(prompt: string): boolean {
  return prompt.trim().toLowerCase() === "/usage-limits";
}

export function hasProviderUsageLimits(
  driver: ServerProvider["driver"],
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): boolean {
  return (
    providersWithLimits(providers).some((provider) => provider.driver === driver) ||
    sources.some(
      (source) =>
        source.accounts.some((account) => account.driver === driver) ||
        (source.error !== undefined && source.accounts.length === 0),
    )
  );
}

export function sameUsageLimitCommandCoverage(
  previous: UsageLimitSourceSnapshots,
  next: UsageLimitSourceSnapshots,
): boolean {
  const coverage = (sources: UsageLimitSourceSnapshots) =>
    new Set(
      sources.flatMap((source) =>
        source.error !== undefined && source.accounts.length === 0
          ? ["*"]
          : source.accounts.map((account) => String(account.driver)),
      ),
    );
  const before = coverage(previous);
  const after = coverage(next);
  return before.size === after.size && [...before].every((driver) => after.has(driver));
}

/** Advertise on workspace catalogs too, which replace the global command list. */
export function withUsageLimitsCommands(
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): ServerProvider[] {
  const supportedDrivers = new Set([
    ...providersWithLimits(providers).map((provider) => provider.driver),
    ...sources.flatMap((source) => source.accounts.map((account) => account.driver)),
  ]);
  const unreadableSource = sources.some(
    (source) => source.error !== undefined && source.accounts.length === 0,
  );
  return providers.map((provider) => {
    if (!unreadableSource && !supportedDrivers.has(provider.driver)) return provider;
    const commands = (items: readonly ServerProviderSlashCommand[]) => [
      ...items.filter((command) => command.name !== USAGE_LIMITS_COMMAND.name),
      USAGE_LIMITS_COMMAND,
    ];
    return {
      ...provider,
      slashCommands: commands(provider.slashCommands),
      ...(provider.workspaceSnapshots
        ? {
            workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
              ...snapshot,
              slashCommands: commands(snapshot.slashCommands),
            })),
          }
        : {}),
    };
  });
}

/** The hubs an instance sends its requests through: those whose address is its endpoint. */
export function instanceHubs(
  provider: ServerProvider,
  sources: UsageLimitSourceSnapshots,
): UsageLimitSourceSnapshots {
  const endpoint = provider.auth.endpoint;
  return endpoint === undefined ? [] : sources.filter((source) => source.origin === endpoint);
}

/** The hub accounts that serve a model: those that list it, else every account of the driver. */
export function hubRoutes(
  sources: UsageLimitSourceSnapshots,
  driver: ServerProvider["driver"],
  model: string | null,
): (account: UsageLimitSourceAccount) => boolean {
  // Claude Code's 1M-context suffix is not part of the model id a hub routes.
  const full = model?.replace(/\[1m\]$/i, "");
  // The hub routes a thinking suffix such as "gpt-5.2(high)" by its base model when one lists it.
  const base = full?.replace(/\([^)]*\)$/, "");
  const lists = (id: string | undefined) =>
    sources.some((source) => source.accounts.some((account) => account.models?.includes(id ?? "")));
  const slug = lists(base) ? base : full;
  const listed = (account: UsageLimitSourceAccount) =>
    slug !== undefined && account.models?.includes(slug) === true;
  const serving = new Set(
    sources.flatMap((source) => source.accounts.filter(listed).map((account) => account.driver)),
  );
  // Model ids such as "opus" are aliases no hub lists, so no listing falls back to the driver.
  if (serving.size === 0)
    return (account) => account.driver === driver && account.models?.length !== 0;
  // An account whose model list was unreadable may serve the model too.
  return (account) =>
    account.models ? listed(account) : serving.has(account.driver) || account.driver === driver;
}

export function collectProviderUsageLimits(
  instanceId: ProviderInstanceId,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
  model: string | null = null,
): UsageLimitsReport | null {
  const selected = providers.find((provider) => provider.instanceId === instanceId);
  if (!selected) return null;
  // Only an instance sent to a hub is known to reach the accounts that hub routes its model to.
  const hubs = instanceHubs(selected, sources);
  const routes =
    hubs.length > 0
      ? hubRoutes(hubs, selected.driver, model)
      : (account: UsageLimitSourceAccount) => account.driver === selected.driver;
  const shownHubs = hubs.length > 0 ? hubs : sources;
  const drivers = new Set(
    shownHubs.flatMap((source) => source.accounts.filter(routes).map((account) => account.driver)),
  );
  if (drivers.size === 0) drivers.add(selected.driver);
  if (![...drivers].some((driver) => hasProviderUsageLimits(driver, providers, sources))) {
    return null;
  }
  const resolveKey = accountKeyResolver(
    accountWorkspaces(
      [
        ...providers.filter((provider) => provider.enabled).map(nativeReport),
        ...sources.flatMap((source) => source.accounts),
      ].flatMap(accountWorkspace),
    ),
  );
  // Behind a hub, a local login counts only when it is one of the accounts the hub routes to.
  const routedKeys =
    hubs.length > 0
      ? new Set(hubs.flatMap((source) => source.accounts.filter(routes).map(resolveKey)))
      : null;
  type NativeSnapshot = { provider: ServerProvider; limits: ServerProviderUsageLimits };
  const nativeByAccount = new Map<
    string,
    { usage: NativeSnapshot; credits: NativeSnapshot | null }
  >();
  for (const provider of providersWithLimits(providers)) {
    if (!drivers.has(provider.driver) || !provider.usageLimits) continue;
    const accountKey = resolveKey(nativeReport(provider));
    if (routedKeys && (accountKey === null || !routedKeys.has(accountKey))) continue;
    const snapshot = { provider, limits: provider.usageLimits };
    const key = accountKey ?? `instance:${provider.instanceId}`;
    const previous = nativeByAccount.get(key);
    const previousUsable = previous ? limitsNotice(previous.usage.limits) === null : false;
    const usable = limitsNotice(snapshot.limits) === null;
    const providerWins =
      !previous ||
      (usable && !previousUsable) ||
      (usable === previousUsable &&
        Date.parse(snapshot.limits.checkedAt) > Date.parse(previous.usage.limits.checkedAt));
    const previousCredit = previous?.credits;
    const credits =
      snapshot.limits.resetCredits &&
      (!previousCredit ||
        Date.parse(snapshot.limits.checkedAt) > Date.parse(previousCredit.limits.checkedAt))
        ? snapshot
        : (previousCredit ?? null);
    nativeByAccount.set(key, {
      usage: providerWins ? snapshot : previous.usage,
      credits,
    });
  }
  const native = [...nativeByAccount.values()];
  const nativeAccountKeys = new Set(
    native.flatMap(({ usage: { provider, limits } }) => {
      const key = resolveKey(nativeReport(provider));
      return key && limits.windows.length && !limits.unavailable ? [key] : [];
    }),
  );
  const accounts: Array<UsageLimitsReport["accounts"][number]> = [];
  const notices: string[] = [];
  for (const {
    usage: { provider, limits },
    credits,
  } of native) {
    const key = resolveKey(nativeReport(provider));
    // Only a hub this instance reaches may redeem a credit for its thread.
    const hubCredits = shownHubs
      .flatMap((source) => source.accounts.map((account) => ({ source, account })))
      .filter(
        ({ account }) =>
          key !== null &&
          resolveKey(account) === key &&
          account.usageLimits.resetCredits &&
          !limitsNotice(account.usageLimits),
      )
      .sort(
        (a, b) =>
          Date.parse(b.account.usageLimits.checkedAt) - Date.parse(a.account.usageLimits.checkedAt),
      )[0];
    const hubCreditId = hubCredits?.account.usageLimits.resetCredits?.nextCreditId;
    const showHubCredits =
      hubCredits &&
      (!credits ||
        Date.parse(hubCredits.account.usageLimits.checkedAt) >
          Date.parse(credits.limits.checkedAt));
    const shownCredits = showHubCredits
      ? hubCredits.account.usageLimits.resetCredits
      : credits?.limits.resetCredits;
    accounts.push({
      id: provider.instanceId,
      driver: provider.driver,
      label: `${provider.displayName?.trim() || String(provider.driver)} [${provider.instanceId}]`,
      ...(provider.auth.label ? { plan: provider.auth.label } : {}),
      instanceId: provider.instanceId,
      resetCreditInput:
        hubCreditId && hubCredits
          ? {
              sourceId: hubCredits.source.id,
              accountId: hubCredits.account.id,
              creditId: hubCreditId,
            }
          : { instanceId: credits?.provider.instanceId ?? provider.instanceId },
      ...(provider.displayName ? { displayName: provider.displayName } : {}),
      ...(provider.accentColor ? { accentColor: provider.accentColor } : {}),
      ...(provider.auth.email ? { email: provider.auth.email } : {}),
      limits: shownCredits ? { ...limits, resetCredits: shownCredits } : limits,
    });
  }
  for (const source of shownHubs) {
    const matching = source.accounts.filter(routes);
    for (const account of matching) {
      const key = resolveKey(account);
      if (key && nativeAccountKeys.has(key)) continue;
      accounts.push({
        id: `${source.id}:${account.id}`,
        driver: account.driver,
        label: `${source.label} · ${hubAccountName(account)}`,
        sourceLabel: "CLI Proxy",
        ...(account.usageLimits.resetCredits?.nextCreditId
          ? {
              resetCreditInput: {
                sourceId: source.id,
                accountId: account.id,
                creditId: account.usageLimits.resetCredits.nextCreditId,
              },
            }
          : {}),
        ...(account.plan ? { plan: account.plan } : {}),
        ...(account.email ? { email: account.email } : {}),
        limits: account.usageLimits,
      });
    }
    if (source.error && (matching.length > 0 || source.accounts.length === 0)) {
      notices.push(`${source.label}: ${source.error}`);
    }
  }
  return { createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)), accounts, notices };
}

// Pay-per-token accounts bill every turn instead of drawing on a subscription, so failover skips them.
const METERED_AUTH_TYPES: ReadonlySet<string> = new Set(["apiKey", "api-key", "bedrock"]);

export const isCodexCloudAccount = (provider: Pick<ServerProvider, "driver" | "auth">): boolean =>
  provider.driver === "codex" &&
  (provider.auth.type === "amazonBedrock" || provider.auth.type === "gcp");

export const isSubscriptionAccount = (provider: ServerProvider): boolean =>
  provider.auth.funding !== "metered" &&
  !isCodexCloudAccount(provider) &&
  (provider.auth.type === undefined || !METERED_AUTH_TYPES.has(provider.auth.type));

export type AccountFailoverStatus =
  | { readonly kind: "off" }
  /** No account above `active` is limited, so a limited thread moves no further than it. */
  | { readonly kind: "ready"; readonly active: ServerProvider }
  | {
      readonly kind: "switched";
      readonly active: ServerProvider;
      /** Limited accounts above `active`. */
      readonly limited: readonly ServerProvider[];
      /** The first of them back, null when no reset is known. */
      readonly until: string | null;
    }
  | { readonly kind: "exhausted"; readonly until: string | null };

/** When a limited account has room again: its last exhausted window's end, as routing counts it. */
function limitedUntil(provider: ServerProvider, now: number): string | undefined {
  const limits = provider.usageLimits;
  let latest: number | undefined;
  for (const window of limits?.windows ?? []) {
    if (window.usedPercent < 100 || !usageWindowAppliesToModel(provider, window, null)) continue;
    const end = usageWindowLimitEnd(limits!, window);
    if (end > now) latest = Math.max(latest ?? end, end);
  }
  return latest === undefined ? undefined : DateTime.formatIso(DateTime.makeUnsafe(latest));
}

function earliest(times: ReadonlyArray<string | null>): string | null {
  const known = times.filter((time): time is string => time !== null);
  return known.length === 0
    ? null
    : known.reduce((first, time) => (Date.parse(time) < Date.parse(first) ? time : first));
}

/**
 * Where "Switch accounts at usage limits" sends a limited `driver` thread, judged from the accounts'
 * last-read usage windows. The server also skips an account whose last run stopped on a limit,
 * which clients cannot see. Null when the provider has no second subscription account to switch to.
 */
export function accountFailoverStatus(input: {
  readonly driver: ProviderDriverKind;
  readonly providers: readonly ServerProvider[];
  readonly settings: Pick<
    ServerSettings,
    "failoverLimitedThreads" | "providerInstanceFailoverOrder"
  >;
  readonly now: number;
}): AccountFailoverStatus | null {
  if (!supportsAccountFailover(input.driver)) return null;
  const accounts = orderProviderInstancesForFailover(
    input.settings.providerInstanceFailoverOrder,
    input.providers.filter(
      (provider) =>
        provider.driver === input.driver && provider.enabled && isSubscriptionAccount(provider),
    ),
  );
  if (accounts.length < 2) return null;
  if (!input.settings.failoverLimitedThreads) return { kind: "off" };
  const limited: ServerProvider[] = [];
  const returns: Array<string | null> = [];
  for (const account of accounts) {
    if (
      !account.installed ||
      account.status === "error" ||
      account.auth.status === "unauthenticated" ||
      !isProviderAvailable(account)
    )
      continue;
    const until = limitedUntil(account, input.now);
    if (until === undefined) {
      return limited.length === 0
        ? { kind: "ready", active: account }
        : { kind: "switched", active: account, limited, until: earliest(returns) };
    }
    limited.push(account);
    returns.push(until);
  }
  return limited.length === 0 ? null : { kind: "exhausted", until: earliest(returns) };
}

export interface AccountFailoverEntry {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly driver: ProviderDriverKind;
  readonly status: AccountFailoverStatus;
}

/** Each environment's account switching for every provider that has accounts to switch between. */
export function collectAccountFailover(
  presentations: ReadonlyMap<
    EnvironmentId,
    {
      readonly entry: { readonly target: { readonly label: string } };
      readonly serverConfig: {
        readonly providers: readonly ServerProvider[];
        readonly settings: Pick<
          ServerSettings,
          "failoverLimitedThreads" | "providerInstanceFailoverOrder"
        >;
        readonly environment: {
          readonly capabilities: { readonly usageLimitAccountFailover?: boolean | undefined };
        };
      } | null;
    }
  >,
  now: number,
): readonly AccountFailoverEntry[] {
  return [...presentations].flatMap(([environmentId, presentation]) => {
    const config = presentation.serverConfig;
    if (config?.environment.capabilities.usageLimitAccountFailover !== true) return [];
    const drivers = new Set(config.providers.map((provider) => provider.driver));
    return [...drivers].flatMap((driver) => {
      const status = accountFailoverStatus({
        driver,
        providers: config.providers,
        settings: config.settings,
        now,
      });
      return status === null
        ? []
        : [{ environmentId, environmentLabel: presentation.entry.target.label, driver, status }];
    });
  });
}

/** One sentence on where a limited thread goes, shared so web and mobile say the same thing. */
export function describeAccountFailover(
  status: AccountFailoverStatus,
  format: {
    readonly accountName: (account: ServerProvider) => string;
    readonly time: (isoDate: string) => string;
  },
): string {
  switch (status.kind) {
    case "off":
      return t(
        "Switching accounts at usage limits is off, so a limited thread waits for its reset.",
      );
    case "ready":
      return t("Switching accounts at usage limits is on. {account} is first in line.", {
        account: format.accountName(status.active),
      });
    case "switched": {
      const values = {
        accounts: status.limited.map(format.accountName).join(", "),
        account: format.accountName(status.active),
      };
      const count = status.limited.length;
      return status.until === null
        ? tn(
            count,
            "{accounts} is at its limit, so limited threads continue on {account}.",
            "{accounts} are at their limits, so limited threads continue on {account}.",
            values,
          )
        : tn(
            count,
            "{accounts} is at its limit until {time}, so limited threads continue on {account}.",
            "{accounts} are at their limits, and the first resets {time}. Limited threads continue on {account}.",
            { ...values, time: format.time(status.until) },
          );
    }
    case "exhausted":
      return status.until === null
        ? t("Every account is at its limit, so limited threads wait for a reset.")
        : t("Every account is at its limit, and the first resets {time}.", {
            time: format.time(status.until),
          });
  }
}
