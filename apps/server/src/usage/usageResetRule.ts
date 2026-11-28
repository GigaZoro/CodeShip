/**
 * When an account whose usage limit is out should claim a banked reset. Pure: it reads one provider
 * snapshot and returns a decision for each of its limits, so the redeemer re-runs it on a fresh
 * reading right before it claims, and `orchestrator_capabilities` publishes what it decides.
 */
import type {
  OrchestratorMcpResetClaimReason,
  OrchestratorMcpResetRunReason,
  OrchestratorMcpResetWaitReason,
  ServerProvider,
  ServerProviderResetCredit,
  ServerProviderResetKind,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

const HOUR_MS = 3_600_000;
// A window younger than this has too little history to read a burn rate from.
const EARLY_PACE_HOURS = 3;

/** The limit id of each driver's own, unscoped meters; a scoped meter has its own. */
const ACCOUNT_LIMIT_IDS: Readonly<Record<string, string>> = {
  claudeAgent: "claude",
  codex: "codex",
};

type UsageResetOutcome =
  | { readonly action: "run"; readonly reason: OrchestratorMcpResetRunReason }
  | {
      readonly action: "wait";
      readonly reason: OrchestratorMcpResetWaitReason;
      /** The plan reset every blocking meter waits for, when it is known. */
      readonly boundaryMs: number | null;
    }
  | {
      readonly action: "claim";
      readonly kind: ServerProviderResetKind;
      /** `codex` or `claude` for the account's own meters, `weekly_scoped:<model>` for a scoped one. */
      readonly limitId: string;
      /** The plan reset of the limit this claim clears, in epoch milliseconds. */
      readonly boundaryMs: number;
      readonly reason: OrchestratorMcpResetClaimReason;
    };

export type UsageResetDecision = UsageResetOutcome & {
  /** Null for the account's own, unscoped meters; else the model a scoped meter limits, as the provider names it. */
  readonly model: string | null;
};

export type UsageResetClaim = Extract<UsageResetDecision, { readonly action: "claim" }>;

export interface UsageResetOptions {
  readonly nowMs: number;
  readonly maxWaitHours: number;
  /** The limit id of the account's own, unscoped meters. */
  readonly accountLimitId: string;
}

interface Meter {
  readonly kind: ServerProviderUsageWindow["kind"];
  /** The model a scoped meter limits, as the provider names it. */
  readonly model: string | undefined;
  readonly usedPercent: number;
  readonly resetsAtMs: number;
  readonly windowHours: number;
}

interface Reset {
  readonly kind: ServerProviderResetKind;
  readonly expiresAtMs: number | null;
  /** Held until the account reaches a limit it refills, so Claude may still refuse it. */
  readonly held: boolean;
}

/**
 * Whether a window is a rate limit, the only kind the rule counts. A monthly one is when it states
 * its length: Codex's monthly credit limit and Claude's monthly spend are spending caps with no
 * window, and a reset does not refill them.
 */
export function isRateLimit(window: ServerProviderUsageWindow): boolean {
  if (window.kind === "other") return false;
  return window.kind !== "monthly" || window.windowDurationMins !== undefined;
}

function meterOf(window: ServerProviderUsageWindow): Meter | null {
  if (!isRateLimit(window)) return null;
  return {
    kind: window.kind,
    model: window.model,
    usedPercent: window.usedPercent,
    resetsAtMs: window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt),
    windowHours: (window.windowDurationMins ?? 0) / 60,
  };
}

const modelKey = (meter: Meter) => meter.model?.toLowerCase();

/** A model-scoped meter at 100%: its own limit, which gets its own decision. */
const isSpentScoped = (meter: Meter): meter is Meter & { readonly model: string } =>
  meter.model !== undefined && meter.usedPercent >= 100;

/** A reset kind is a contract about meters, never about a provider's choice of id. */
function clearsMeter(kind: ServerProviderResetKind, meter: Meter): boolean {
  if (kind === "full") return true;
  if (kind === "fable") return modelKey(meter) === "fable";
  if (meter.model !== undefined) return false;
  return kind === "weekly" ? meter.kind === "weekly" : meter.kind === "session";
}

function availableResets(limits: ServerProviderUsageLimits, nowMs: number): Reset[] {
  const resets: Reset[] = [];
  for (const credit of limits.resetCredits?.credits ?? []) {
    if (!isAvailable(credit) || credit.kind === undefined) continue;
    const expiresAtMs = credit.expiresAt === undefined ? null : Date.parse(credit.expiresAt);
    if (expiresAtMs !== null && !(expiresAtMs > nowMs)) continue;
    resets.push({ kind: credit.kind, expiresAtMs, held: credit.usableNow === false });
  }
  return resets;
}

/**
 * Claude grants say `usableNow`; Codex credits say `status`. A Claude grant held only until the
 * account reaches a limit it refills counts too: it is claimed only at a limit its kind clears, and
 * the grants' reading can predate the limit the meters show. A paused grant is never claimed.
 */
function isAvailable(credit: ServerProviderResetCredit): boolean {
  if (credit.paused === true) return false;
  if (credit.usableNow === false) return credit.requiresLimit === true;
  return credit.usableNow ?? credit.status === "available";
}

const expiryOrder = (reset: Reset) => reset.expiresAtMs ?? Number.POSITIVE_INFINITY;

/** On equal expiry, one offered now goes before one held for a limit. */
function earliestExpiry(resets: ReadonlyArray<Reset>): Reset | undefined {
  return resets.toSorted(
    (a, b) => expiryOrder(a) - expiryOrder(b) || Number(a.held) - Number(b.held),
  )[0];
}

/** The unscoped meters at 100%, or, when the provider says usage is blocked, the fullest ones. */
function blockingMeters(meters: ReadonlyArray<Meter>, usageAllowed: boolean | undefined) {
  const full = meters.filter((meter) => meter.usedPercent >= 100);
  if (full.length > 0 || usageAllowed !== false) return full;
  const top = Math.max(...meters.map((meter) => meter.usedPercent));
  return meters.filter((meter) => meter.usedPercent === top);
}

/** A meter without a reset time may block longer than the rest; one whose time has passed is stale. */
function planReset(
  blocking: ReadonlyArray<Meter>,
  nowMs: number,
): { readonly boundaryMs: number } | { readonly untimed: "unknown-plan-reset" | "stale-reading" } {
  const resets = blocking.map((meter) => meter.resetsAtMs);
  if (resets.length === 0 || resets.some((at) => !Number.isFinite(at)))
    return { untimed: "unknown-plan-reset" };
  if (resets.some((at) => at <= nowMs)) return { untimed: "stale-reading" };
  return { boundaryMs: Math.max(...resets) };
}

function elapsedHours(meter: Meter, measuredMs: number): number | undefined {
  if (!Number.isFinite(meter.resetsAtMs) || !Number.isFinite(measuredMs)) return undefined;
  if (!(meter.windowHours > 0)) return undefined;
  const elapsed = (measuredMs - (meter.resetsAtMs - meter.windowHours * HOUR_MS)) / HOUR_MS;
  return elapsed < 0 || measuredMs >= meter.resetsAtMs ? undefined : elapsed;
}

// Bounds the forecast; a reset it cannot see the end of is kept rather than claimed on a guess.
const MAX_FORECAST_EVENTS = 10_000;

/** A meter as the forecast runs it forward. */
interface Track {
  readonly meter: Meter;
  readonly cleared: boolean;
  /** Percent per hour since the window began; undefined when it cannot be read yet. */
  readonly rate: number | undefined;
  readonly windowMs: number;
  used: number;
  nextResetMs: number;
}

/** A spent meter stops its own model's meters; an unscoped one stops the whole account. */
const stops = (by: Meter, meter: Meter) =>
  by.model === undefined || modelKey(by) === modelKey(meter);

function track(meter: Meter, cleared: boolean, spent: boolean, measuredMs: number): Track {
  const windowMs = meter.windowHours * HOUR_MS;
  // A meter whose reset is unknown or past may have refilled already, so it never holds others.
  if (!(meter.resetsAtMs > measuredMs)) {
    const nextResetMs = Number.POSITIVE_INFINITY;
    return { meter, cleared, rate: undefined, windowMs, used: 0, nextResetMs };
  }
  const elapsed = elapsedHours(meter, measuredMs);
  const rate =
    elapsed !== undefined && elapsed >= EARLY_PACE_HOURS ? meter.usedPercent / elapsed : undefined;
  const used = spent ? 100 : meter.usedPercent;
  return { meter, cleared, rate, windowMs, used, nextResetMs: meter.resetsAtMs };
}

/**
 * Whether a meter the reset clears runs out again before it expires while the meters it does not
 * clear still let that meter run. Each meter keeps its measured pace, refills at its window's
 * resets and pauses while a spent meter stops it; one whose pace is unread may run out whenever it runs.
 */
function usableLater(expiresAtMs: number, tracks: ReadonlyArray<Track>, measuredMs: number) {
  let atMs = measuredMs;
  for (let event = 0; event < MAX_FORECAST_EVENTS; event++) {
    const running = tracks.map((t) =>
      tracks.every((by) => by.used < 100 || !stops(by.meter, t.meter)),
    );
    if (tracks.some((t, i) => running[i] && t.cleared && t.rate === undefined)) return true;
    const outMs = tracks.map((t, i) =>
      running[i] && t.rate !== undefined && t.rate > 0
        ? ((100 - t.used) / t.rate) * HOUR_MS
        : Number.POSITIVE_INFINITY,
    );
    const stepMs = Math.min(...outMs, ...tracks.map((t) => t.nextResetMs - atMs));
    if (!(atMs + stepMs < expiresAtMs)) return false;
    atMs += stepMs;
    tracks.forEach((t, i) => {
      if (running[i] && t.rate !== undefined) {
        t.used = outMs[i] === stepMs ? 100 : t.used + (t.rate * stepMs) / HOUR_MS;
      }
      if (t.nextResetMs <= atMs) {
        t.used = 0;
        t.nextResetMs = t.windowMs > 0 ? t.nextResetMs + t.windowMs : Number.POSITIVE_INFINITY;
      }
    });
    const ranOut = tracks.filter((t, i) => outMs[i] === stepMs && t.used >= 100);
    const usable = (t: Track) =>
      t.cleared && tracks.every((by) => by.cleared || by.used < 100 || !stops(by.meter, t.meter));
    if (ranOut.some(usable)) return true;
  }
  return true;
}

/**
 * Whether the reset would lapse unused: no later run-out before it expires could use it. It is
 * claimed at the last run-out before it expires, not one cycle early.
 */
function expiresUnused(
  reset: Reset,
  meters: ReadonlyArray<Meter>,
  blocking: ReadonlyArray<Meter>,
  measuredMs: number,
): boolean {
  if (reset.expiresAtMs === null) return false;
  // The blocking meters are spent even when the provider stopped the account short of 100%.
  const tracks = meters.map((meter) =>
    track(meter, clearsMeter(reset.kind, meter), blocking.includes(meter), measuredMs),
  );
  return !usableLater(reset.expiresAtMs, tracks, measuredMs);
}

function decideBlocked(input: {
  readonly blocking: ReadonlyArray<Meter>;
  readonly meters: ReadonlyArray<Meter>;
  readonly resets: ReadonlyArray<Reset>;
  readonly limitId: string;
  readonly nowMs: number;
  readonly maxWaitMs: number;
  readonly measuredMs: number;
}): UsageResetOutcome {
  const plan = planReset(input.blocking, input.nowMs);
  // Without the plan reset the wait threshold cannot be applied, so no reset is spent on it.
  if ("untimed" in plan) return { action: "wait", reason: plan.untimed, boundaryMs: null };
  const { boundaryMs } = plan;
  const tooFar = boundaryMs - input.nowMs > input.maxWaitMs;
  // A 5-hour limit's plan reset is never far, so a 5-hour reset is claimed only when it would lapse.
  const farFits = (reset: Reset) => tooFar && reset.kind !== "five_hour";
  const lapses = (reset: Reset) =>
    expiresUnused(reset, input.meters, input.blocking, input.measuredMs);
  const first = earliestExpiry(
    input.resets.filter(
      (reset) =>
        input.blocking.every((meter) => clearsMeter(reset.kind, meter)) &&
        (farFits(reset) || lapses(reset)),
    ),
  );
  if (first === undefined) {
    return { action: "wait", reason: tooFar ? "no-reset" : "plan-resets-soon", boundaryMs };
  }
  return {
    action: "claim",
    kind: first.kind,
    limitId: input.limitId,
    boundaryMs,
    reason: farFits(first) ? "reset-too-far" : "reset-expiring",
  };
}

/**
 * The decision for each limit on an account's snapshot: the account's own first, then each
 * model-scoped meter at 100%. The first claim among them is the one to make. Credits and Claude's
 * weekly 5-hour program are never spent here.
 */
export function decideUsageReset(
  limits: ServerProviderUsageLimits,
  options: UsageResetOptions,
): ReadonlyArray<UsageResetDecision> {
  const meters = limits.windows.flatMap((window) => meterOf(window) ?? []);
  const spentScoped = meters.filter(isSpentScoped);
  const measuredMs = Date.parse(limits.checkedAt);
  if (limits.unavailable !== undefined || !Number.isFinite(measuredMs)) {
    const unmeasured = { action: "wait", reason: "unmeasured", boundaryMs: null } as const;
    return [
      { model: null, ...unmeasured },
      ...spentScoped.map((meter) => ({ model: meter.model, ...unmeasured })),
    ];
  }
  const unscoped = meters.filter((meter) => meter.model === undefined);
  const resets = availableResets(limits, options.nowMs);
  const shared = {
    meters,
    resets,
    nowMs: options.nowMs,
    maxWaitMs: options.maxWaitHours * HOUR_MS,
    measuredMs,
  };

  const blocking = blockingMeters(unscoped, limits.usageAllowed);
  // The provider's own answer outranks a window still shown at 100%.
  const account: UsageResetOutcome =
    limits.usageAllowed === true
      ? { action: "run", reason: "usage-allowed" }
      : blocking.length === 0 && limits.usageAllowed !== false
        ? { action: "run", reason: "plan-available" }
        : decideBlocked({ ...shared, blocking, limitId: options.accountLimitId });

  // A model-scoped meter (Claude's Fable week) is its own limit, but while the account is blocked
  // that model waits for the account's meters too, so its reset must clear them as well.
  const accountBlocking = account.action === "run" ? [] : blocking;
  const scoped = spentScoped.map((meter): UsageResetDecision => ({
    model: meter.model,
    ...decideBlocked({
      ...shared,
      blocking: [...accountBlocking, meter],
      limitId: `${meter.kind}_scoped:${modelKey(meter)}`,
    }),
  }));
  return [{ model: null, ...account }, ...scoped];
}

/** The decisions on a provider's last reading; none when it has none or its driver has no usage limits. */
export function providerResetDecisions(
  provider: ServerProvider,
  options: Omit<UsageResetOptions, "accountLimitId">,
): ReadonlyArray<UsageResetDecision> {
  const accountLimitId = ACCOUNT_LIMIT_IDS[provider.driver];
  if (provider.usageLimits === undefined || accountLimitId === undefined) return [];
  return decideUsageReset(provider.usageLimits, { ...options, accountLimitId });
}
