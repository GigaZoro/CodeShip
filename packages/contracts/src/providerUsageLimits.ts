import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  ForwardCompatibleOptional,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

export const ServerProviderUsageScope = Schema.Union([
  Schema.Literals([
    "account",
    "model",
    "gemini-default",
    "gemini-argon",
    "gemini-carbon",
    "third-party",
    "opencode-go",
    "cursor-auto",
    "cursor-api",
    "spending-cap",
    "unknown",
  ]),
  Schema.Struct({
    /** Canonical catalog slugs drawing on the same provider allowance. */
    models: Schema.NonEmptyArray(TrimmedNonEmptyString).check(Schema.isUnique()),
  }),
]);
export type ServerProviderUsageScope = typeof ServerProviderUsageScope.Type;

/** Stable per-provider ids let sparse updates merge with full probes. */
export const ServerProviderUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  /** When present, this limit applies only to these provider model IDs. */
  modelIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  providerIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
  /** When this window was last observed, independent of other windows in the snapshot. */
  observedAt: Schema.optional(IsoDateTime),
  /** When the window was first seen at 100%; absent below 100% and from older servers. */
  exhaustedSince: Schema.optional(IsoDateTime),
  /** The model a scoped window limits, by slug or a provider's family name (Claude's `Fable`). */
  model: Schema.optional(TrimmedNonEmptyString),
  scope: Schema.optional(ServerProviderUsageScope),
});
export type ServerProviderUsageWindow = typeof ServerProviderUsageWindow.Type;

/** What a banked reset clears: Codex resets are `full`; Claude grants say which limit they reset. */
export const ServerProviderResetKind = Schema.Literals(["full", "weekly", "five_hour", "fable"]);
export type ServerProviderResetKind = typeof ServerProviderResetKind.Type;

/**
 * Why a Claude grant has no `kind`: with no grant usable now, Claude names only a total over all
 * its grants (`totalOnly`).
 */
export const ServerProviderResetKindUnknownReason = Schema.Literals(["totalOnly"]);
export type ServerProviderResetKindUnknownReason = typeof ServerProviderResetKindUnknownReason.Type;

/** One banked reset or grant, without the provider's id for it. */
export const ServerProviderResetCredit = Schema.Struct({
  program: TrimmedNonEmptyString,
  /** Absent only when the provider's answer named no kind; `kindUnknownReason` then says why. */
  kind: Schema.optional(ServerProviderResetKind),
  kindUnknownReason: Schema.optional(ServerProviderResetKindUnknownReason),
  status: Schema.optional(TrimmedNonEmptyString),
  grantedAt: Schema.optional(IsoDateTime),
  expiresAt: Schema.optional(IsoDateTime),
  resetsLeft: Schema.optional(NonNegativeInt),
  usableNow: Schema.optional(Schema.Boolean),
  requiresLimit: Schema.optional(Schema.Boolean),
  paused: Schema.optional(Schema.Boolean),
});
export type ServerProviderResetCredit = typeof ServerProviderResetCredit.Type;

/** Paid usage beyond the plan: Codex credits, or Claude's extra usage. */
export const ServerProviderUsageCredits = Schema.Struct({
  /** What is left, in `currency` when it is money; absent when the provider gives no balance. */
  balance: Schema.optional(TrimmedNonEmptyString),
  currency: Schema.optional(TrimmedNonEmptyString),
  unlimited: Schema.Boolean,
});
export type ServerProviderUsageCredits = typeof ServerProviderUsageCredits.Type;

/** One kind of banked reset, such as Claude's weekly reset or its Fable-only reset. */
export const ServerProviderResetCreditOption = Schema.Struct({
  creditId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  availableCount: NonNegativeInt,
  expiresAt: Schema.optional(IsoDateTime),
});
export type ServerProviderResetCreditOption = typeof ServerProviderResetCreditOption.Type;

export const ServerProviderResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  nextExpiresAt: Schema.optional(IsoDateTime),
  /** Pins hub redemption to the displayed credit, including retries from another client. */
  nextCreditId: Schema.optional(TrimmedNonEmptyString),
  /** Each banked reset, when the provider lists them; it may list fewer than `availableCount`. */
  credits: Schema.optional(ForwardCompatibleArray(ServerProviderResetCredit)),
  /** Present when resets differ in what they refill; redeem one by its `creditId`. */
  options: Schema.optional(ForwardCompatibleArray(ServerProviderResetCreditOption)),
});
export type ServerProviderResetCredits = typeof ServerProviderResetCredits.Type;

/** Which of Claude's reset programs the account's flags turn on. */
export const ServerProviderResetPrograms = Schema.Struct({
  /** Banked grants (`tengu_cedar_ember`), listed in `resetCredits`. */
  granted: Schema.Boolean,
  /** The weekly 5-hour reset (`tengu_nifty_lemur`), which Claude shows only at the 5-hour limit. */
  weeklySession: Schema.Boolean,
  /** When the weekly 5-hour reset is next available, as Claude said when it was last used. */
  weeklySessionAvailableAt: Schema.optional(IsoDateTime),
});
export type ServerProviderResetPrograms = typeof ServerProviderResetPrograms.Type;

/**
 * Why `resetCredits` is absent although the account has banked resets to read. `lowPriority`:
 * Claude answered that resets wait while the account runs at lower priority, before reading any.
 */
export const ServerProviderResetCreditsError = Schema.Literals([
  "signedOut",
  "unrecognizedScreen",
  "readFailed",
  "lowPriority",
]);
export type ServerProviderResetCreditsError = typeof ServerProviderResetCreditsError.Type;

/** Clear bars for unavailable accounts; retain last good bars after a failed probe. */
export const ServerProviderUsageLimits = Schema.Struct({
  checkedAt: IsoDateTime,
  /** Older Antigravity readings came from an unsupported Google endpoint. */
  source: ForwardCompatibleOptional(Schema.Literal("antigravity-acp")),
  windows: ForwardCompatibleArray(ServerProviderUsageWindow),
  /** A $0 monthly spend cap has no percentage, so it cannot be a window. */
  zeroSpendCap: Schema.optional(Schema.Boolean),
  credentialFingerprint: Schema.optional(TrimmedNonEmptyString),
  /** The provider account's `usageAccountKey`: equal on every machine, never the id itself. */
  accountKey: Schema.optional(TrimmedNonEmptyString),
  plan: Schema.optional(TrimmedNonEmptyString),
  credits: Schema.optional(ServerProviderUsageCredits),
  /** Time of a streamed balance change or removal after the last account read. */
  creditsObservedAt: Schema.optional(IsoDateTime),
  /** No full read has established which windows exist on this account yet. */
  streamOnly: Schema.optional(Schema.Literal(true)),
  /**
   * The provider's own answer, at its last usage read, whether the plan's ordinary usage may run;
   * absent when it gives none. Codex says recovery must not be inferred from percentages or resets,
   * so `true` outranks a window still shown at 100%.
   */
  usageAllowed: Schema.optional(Schema.Boolean),
  /**
   * When the last full read gave `accountKey`, `plan`, `usageAllowed` and `resetCredits`, if a
   * streamed update has moved `checkedAt` past it.
   */
  accountReadAt: Schema.optional(IsoDateTime),
  resetCredits: Schema.optional(ServerProviderResetCredits),
  resetCreditsError: Schema.optional(ServerProviderResetCreditsError),
  resetPrograms: Schema.optional(ServerProviderResetPrograms),
  externalUsage: Schema.optional(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      url: TrimmedNonEmptyString,
    }),
  ),
  /** These limits become readable through a sign-in with the auth purpose "limits". */
  limitsSignIn: Schema.optional(Schema.Boolean),
  unavailable: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals(["unsupported", "probeFailed"]),
      message: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});
export type ServerProviderUsageLimits = typeof ServerProviderUsageLimits.Type;

export function hasSupportedUsageLimits(
  driver: ProviderDriverKind,
  limits: ServerProviderUsageLimits,
): boolean {
  return driver !== "antigravity" || limits.source === "antigravity-acp";
}

/** Partial updates merge windows by id; omitted windows remain unchanged. */
export const ProviderUsageLimitsUpdate = Schema.Struct({
  windows: Schema.Array(ServerProviderUsageWindow),
  /** Null when the account has no credits any more; absent when the update says nothing of them. */
  credits: Schema.optional(Schema.NullOr(ServerProviderUsageCredits)),
  /** The event contains usable limits independently of a successful background probe. */
  available: Schema.optional(Schema.Literal(true)),
});
export type ProviderUsageLimitsUpdate = typeof ProviderUsageLimitsUpdate.Type;

export const UsageLimitSourceAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  email: Schema.optional(TrimmedNonEmptyString),
  plan: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  /** The models the hub routes to this account. */
  models: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  usageLimits: ServerProviderUsageLimits,
}).check(
  Schema.makeFilter((account) => hasSupportedUsageLimits(account.driver, account.usageLimits)),
);
export type UsageLimitSourceAccount = typeof UsageLimitSourceAccount.Type;

export const HttpQuotaAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  windows: Schema.Array(
    Schema.Struct({
      id: ServerProviderUsageWindow.fields.id,
      kind: ServerProviderUsageWindow.fields.kind,
      label: ServerProviderUsageWindow.fields.label,
      usedPercent: ServerProviderUsageWindow.fields.usedPercent,
      resetsAt: ServerProviderUsageWindow.fields.resetsAt,
    }),
  ),
});

export const HttpQuotaResponse = Schema.Struct({
  version: Schema.Literal(1),
  accounts: Schema.Array(HttpQuotaAccount),
});

export const UsageLimitSourceSnapshot = Schema.Struct({
  id: UsageLimitSourceId,
  kind: Schema.Literals(["cliproxy", "http"]),
  label: TrimmedNonEmptyString,
  /** Origin of the hub, which also serves the agents sent through it. */
  origin: Schema.optional(TrimmedNonEmptyString),
  /** Origin and base path of the hub, which tell apart hubs served from one origin. */
  endpoint: Schema.optional(TrimmedNonEmptyString),
  checkedAt: IsoDateTime,
  accounts: ForwardCompatibleArray(UsageLimitSourceAccount),
  quotaAccounts: Schema.optional(ForwardCompatibleArray(HttpQuotaAccount)),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type UsageLimitSourceSnapshot = typeof UsageLimitSourceSnapshot.Type;

export const UsageLimitSourceSnapshots = ForwardCompatibleArray(UsageLimitSourceSnapshot);
export type UsageLimitSourceSnapshots = typeof UsageLimitSourceSnapshots.Type;

export const UsageLimitSourceConsumeResetCreditInput = Schema.Struct({
  sourceId: UsageLimitSourceId,
  accountId: TrimmedNonEmptyString,
  creditId: TrimmedNonEmptyString,
});
export type UsageLimitSourceConsumeResetCreditInput =
  typeof UsageLimitSourceConsumeResetCreditInput.Type;

export const ProviderConsumeResetCreditInput = Schema.Union([
  Schema.Struct({
    instanceId: ProviderInstanceId,
    creditId: Schema.optional(TrimmedNonEmptyString),
  }),
  UsageLimitSourceConsumeResetCreditInput,
]);
export type ProviderConsumeResetCreditInput = typeof ProviderConsumeResetCreditInput.Type;

export class UsageLimitSourceError extends Schema.TaggedError<UsageLimitSourceError>()(
  "UsageLimitSourceError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ProviderConsumeResetCreditOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type ProviderConsumeResetCreditOutcome = typeof ProviderConsumeResetCreditOutcome.Type;

export const ProviderConsumeResetCreditResult = Schema.Struct({
  outcome: ProviderConsumeResetCreditOutcome,
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderConsumeResetCreditResult = typeof ProviderConsumeResetCreditResult.Type;

/**
 * How a Codex account's prepaid credits stand for new work: `spending` (plan used up, allowed),
 * `standby` (allowed, plan has room), `not_enabled`, `out_of_scope` (allowed for other threads),
 * `cap_reached` (the allowed credits are spent), `used_up` (balance or monthly limit spent).
 */
export const ProviderCreditUse = Schema.Literals([
  "spending",
  "standby",
  "not_enabled",
  "out_of_scope",
  "cap_reached",
  "used_up",
]);
export type ProviderCreditUse = typeof ProviderCreditUse.Type;

const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

/** What the user allowed a Codex account to spend of its prepaid credits, and what is left. */
export const ProviderCreditGrant = Schema.Struct({
  capCredits: PositiveInt,
  /** How far the balance fell, from any use of the account, since spending was allowed. */
  spentCredits: NonNegativeNumber,
  remainingCredits: NonNegativeNumber,
  /** The threads whose work, their delegates' included, may spend them; absent: any thread. */
  threadIds: Schema.optional(Schema.Array(ThreadId)),
});
export type ProviderCreditGrant = typeof ProviderCreditGrant.Type;

/** Whether new work can start on an account once Try again has lifted its holds. */
export const ProviderRetryUsageLimitResult = Schema.Struct({
  /** When new work can start on it again; absent when it can start now, and from older servers. */
  limitedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** `limitedUntil` is CodeShip's guess, not a reset the provider reported. */
  estimated: Schema.optional(Schema.Literal(true)),
  /** Absent for an account without prepaid credits CodeShip could spend. */
  credits: ForwardCompatibleOptional(ProviderCreditUse),
});
export type ProviderRetryUsageLimitResult = typeof ProviderRetryUsageLimitResult.Type;

/** An account CodeShip skips after a usage refusal until the hold ends or Try again lifts it. */
export const ProviderUsageHold = Schema.Struct({
  instanceId: ProviderInstanceId,
  apiCredit: Schema.optional(Schema.Literal(true)),
  /** When the hold ends by itself; absent when only the next turn shows whether the cap is gone. */
  heldUntil: Schema.optional(IsoDateTime),
  /** `heldUntil` is CodeShip's guess, not a reset the provider reported. */
  estimated: Schema.optional(Schema.Literal(true)),
  /** ChatGPT's connected-app limit refused it while the plan still had room. */
  appCap: Schema.optional(Schema.Literal(true)),
});
export type ProviderUsageHold = typeof ProviderUsageHold.Type;

export const ProviderUsageHoldsResult = Schema.Struct({
  holds: ForwardCompatibleArray(ProviderUsageHold),
});
export type ProviderUsageHoldsResult = typeof ProviderUsageHoldsResult.Type;

/** Each Codex account the user allowed to spend prepaid credits, with what is left of it. */
export const ProviderCreditGrantsResult = Schema.Struct({
  grants: ForwardCompatibleArray(
    Schema.Struct({ instanceId: ProviderInstanceId, ...ProviderCreditGrant.fields }),
  ),
});
export type ProviderCreditGrantsResult = typeof ProviderCreditGrantsResult.Type;

export const UsageLimitsReport = Schema.Struct({
  createdAt: IsoDateTime,
  accounts: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      driver: ProviderDriverKind,
      label: TrimmedNonEmptyString,
      plan: Schema.optional(TrimmedNonEmptyString),
      email: Schema.optional(TrimmedNonEmptyString),
      sourceLabel: Schema.optional(TrimmedNonEmptyString),
      instanceId: Schema.optional(ProviderInstanceId),
      resetCreditInput: Schema.optional(ProviderConsumeResetCreditInput),
      displayName: Schema.optional(Schema.String),
      accentColor: Schema.optional(Schema.String),
      limits: ServerProviderUsageLimits,
    }),
  ),
  notices: Schema.Array(Schema.String),
});
export type UsageLimitsReport = typeof UsageLimitsReport.Type;
