import * as DateTime from "effect/DateTime";

import type {
  OrchestratorMcpBankedReset,
  OrchestratorMcpLastRedemption,
  OrchestratorMcpProviderUsage,
  OrchestratorMcpResetDecision,
  OrchestratorMcpUsageError,
  OrchestratorMcpUsageMeter,
  ProviderCreditUse,
  ProviderRetryUsageLimitResult,
  ServerProvider,
  ServerProviderResetCreditsError,
  ServerProviderResetKindUnknownReason,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

import {
  isRateLimit,
  providerResetDecisions,
  type UsageResetDecision,
} from "../usage/usageResetRule.ts";

/** How old a usage reading may be before `orchestrator_capabilities` with `usage` reads it again. */
const USAGE_READING_MAX_AGE_MS = 10 * 60_000;

export function publishesUsage(provider: ServerProvider): boolean {
  return provider.enabled && (provider.driver === "claudeAgent" || provider.driver === "codex");
}

/**
 * Whether the account's last full usage read is missing or older than `USAGE_READING_MAX_AGE_MS`,
 * and no probe ran since then: one that left no newer reading would fail the same way again.
 */
export function usageReadingStale(provider: ServerProvider, now: number): boolean {
  const limits = provider.usageLimits;
  const old = (at: string | undefined) =>
    at === undefined || now - Date.parse(at) > USAGE_READING_MAX_AGE_MS;
  return old(limits?.accountReadAt ?? limits?.checkedAt) && old(provider.checkedAt);
}

function meterId(window: ServerProviderUsageWindow): string {
  if (window.kind === "weekly") {
    return window.model === undefined ? "weekly_all" : `weekly_scoped:${window.model}`;
  }
  return window.kind === "session" ? "session" : window.id;
}

function meter(window: ServerProviderUsageWindow): OrchestratorMcpUsageMeter {
  return {
    id: meterId(window),
    model: window.model ?? null,
    usedPercent: window.usedPercent,
    windowMinutes: window.windowDurationMins ?? null,
    resetsAt: window.resetsAt ?? null,
    rateLimit: isRateLimit(window),
  };
}

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

function resetDecision(decision: UsageResetDecision): OrchestratorMcpResetDecision {
  const { model } = decision;
  switch (decision.action) {
    case "run":
      return { model, action: "run", reason: decision.reason, until: null };
    case "wait":
      return {
        model,
        action: "wait",
        reason: decision.reason,
        until: decision.boundaryMs === null ? null : isoAt(decision.boundaryMs),
      };
    case "claim":
      return {
        model,
        action: "claim",
        reason: decision.reason,
        until: isoAt(decision.boundaryMs),
        kind: decision.kind,
      };
  }
}

const RESET_READ_ERRORS = {
  signedOut: "signed_out",
  unrecognizedScreen: "unrecognized_screen",
  readFailed: "read_failed",
  lowPriority: "low_priority",
} as const satisfies Record<ServerProviderResetCreditsError, OrchestratorMcpUsageError>;

const KIND_UNKNOWN_REASONS = {
  totalOnly: "total_only",
} as const satisfies Record<
  ServerProviderResetKindUnknownReason,
  NonNullable<OrchestratorMcpBankedReset["kindUnknownReason"]>
>;

function bankedResets(
  provider: ServerProvider,
): Pick<OrchestratorMcpProviderUsage, "bankedResets" | "bankedResetsError"> {
  const limits = provider.usageLimits;
  if (limits?.resetCreditsError !== undefined) {
    return { bankedResets: null, bankedResetsError: RESET_READ_ERRORS[limits.resetCreditsError] };
  }
  // A Claude account whose flags turn banked grants off has none, though nothing was read.
  const summary =
    limits?.resetCredits ??
    (limits?.resetPrograms?.granted === false ? { availableCount: 0, credits: [] } : undefined);
  if (summary === undefined) return { bankedResets: null, bankedResetsError: "not_read" };
  return {
    bankedResets: {
      available: summary.availableCount,
      resets: (summary.credits ?? []).map((credit) => ({
        status: credit.status ?? null,
        grantedAt: credit.grantedAt ?? null,
        expiresAt: credit.expiresAt ?? null,
        program: credit.program,
        kind: credit.kind ?? null,
        ...(credit.kindUnknownReason === undefined
          ? {}
          : { kindUnknownReason: KIND_UNKNOWN_REASONS[credit.kindUnknownReason] }),
        ...(credit.resetsLeft === undefined ? {} : { resetsLeft: credit.resetsLeft }),
        ...(credit.usableNow === undefined ? {} : { usableNow: credit.usableNow }),
        ...(credit.requiresLimit === undefined ? {} : { requiresLimit: credit.requiresLimit }),
        ...(credit.paused === undefined ? {} : { paused: credit.paused }),
      })),
    },
  };
}

function usageError(provider: ServerProvider): OrchestratorMcpUsageError | undefined {
  if (provider.auth.status === "unauthenticated") return "signed_out";
  const limits = provider.usageLimits;
  if (limits === undefined) return "not_read";
  if (limits.unavailable?.reason === "unsupported") return "unsupported";
  if (limits.unavailable !== undefined && limits.windows.length === 0) return "read_failed";
  return undefined;
}

/** Why new work cannot start on a usage-limited account, as an agent should act on it. */
export function usageLimitReason(credits: ProviderCreditUse | null | undefined): string {
  switch (credits) {
    case "not_enabled":
      return "a usage limit holds it, and spending its prepaid credits is off. That is the user's money: only the user turns it on, with Spend prepaid credits in Settings > Providers.";
    case "out_of_scope":
      return "a usage limit holds it, and the user allowed its prepaid credits only for other threads' work. That is the user's money: only the user widens it.";
    case "cap_reached":
      return "a usage limit holds it, and the prepaid credits the user allowed it are spent. That is the user's money: only the user raises the cap.";
    case "used_up":
      return "a usage limit holds it, and its prepaid credits or monthly credit limit are used up too.";
    default:
      return "a usage limit holds it.";
  }
}

/** What `t3_provider_retry_usage_limit` reports: what admission does with the account next. */
export function releaseReport(
  instanceId: string,
  admission: ProviderRetryUsageLimitResult,
): { readonly message: string } {
  if (admission.limitedUntil === undefined)
    return {
      message: `Released ${instanceId}. New work can start on it now.${
        admission.credits === "spending"
          ? " It runs on the prepaid credits the user allowed for this work."
          : ""
      }`,
    };
  return {
    message: `Released ${instanceId}'s recorded refusals, but new work still cannot start on it until ${
      admission.limitedUntil
    }${admission.estimated ? " (T3's estimate)" : ""}: ${usageLimitReason(admission.credits)}`,
  };
}

export interface UsagePublication {
  /** The account's usage hold. */
  readonly limited: boolean;
  /** The redeemer's last claims by account key; only the account held now is published. */
  readonly redemptions: ReadonlyMap<string, OrchestratorMcpLastRedemption>;
  /** How the account's prepaid credits stand; spending them lets it run past its plan. */
  readonly credits: ProviderCreditUse | null;
  readonly nowMs: number;
  /** The server's `maxPlanResetWaitHours`, which the reset rule's decisions apply. */
  readonly maxWaitHours: number;
}

/**
 * The `usage` an enabled Claude or Codex account publishes in `orchestrator_capabilities`: its
 * meters, credits, banked resets and the reset rule's decisions, keyed by a hash of the account
 * id. A provider's own error text is never published, since it can name the account.
 */
export function providerUsageFields(
  provider: ServerProvider,
  { limited, redemptions, credits, nowMs, maxWaitHours }: UsagePublication,
): {
  readonly usage: OrchestratorMcpProviderUsage | null;
  readonly usageError?: OrchestratorMcpUsageError;
} {
  const error = usageError(provider);
  const limits = provider.usageLimits;
  if (error !== undefined || limits === undefined) {
    return { usage: null, usageError: error ?? "not_read" };
  }
  return {
    usage: {
      accountKey: limits.accountKey ?? null,
      plan: limits.plan ?? null,
      measuredAt: limits.checkedAt,
      meters: limits.windows.map(meter),
      credits:
        limits.credits === undefined
          ? null
          : {
              balance: limits.credits.balance ?? null,
              unlimited: limits.credits.unlimited,
              ...(limits.credits.currency === undefined
                ? {}
                : { currency: limits.credits.currency }),
            },
      ...bankedResets(provider),
      ...(limits.resetPrograms === undefined
        ? {}
        : {
            resetPrograms: {
              granted: limits.resetPrograms.granted,
              weeklySession: limits.resetPrograms.weeklySession,
              weeklySessionAvailableAt: limits.resetPrograms.weeklySessionAvailableAt ?? null,
            },
          }),
      usageAllowed: !limited && (limits.usageAllowed !== false || credits === "spending"),
      resetDecisions: providerResetDecisions(provider, { nowMs, maxWaitHours }).map(resetDecision),
      lastRedemption:
        (limits.accountKey === undefined ? undefined : redemptions.get(limits.accountKey)) ?? null,
    },
  };
}
