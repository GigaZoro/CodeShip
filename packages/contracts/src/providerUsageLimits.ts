import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

/** Stable per-provider ids let sparse updates merge with full probes. */
export const ServerProviderUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
  /** When the window was first seen at 100%; absent below 100% and from older servers. */
  exhaustedSince: Schema.optional(IsoDateTime),
  /** The model a scoped window limits, by the provider's name for it (Claude's `Fable`). */
  model: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderUsageWindow = typeof ServerProviderUsageWindow.Type;

/** What a banked reset clears: Codex resets are `full`; Claude grants say which limit they reset. */
export const ServerProviderResetKind = Schema.Literals(["full", "weekly", "five_hour", "fable"]);
export type ServerProviderResetKind = typeof ServerProviderResetKind.Type;

/** One banked reset or grant, without the provider's id for it. */
export const ServerProviderResetCredit = Schema.Struct({
  program: TrimmedNonEmptyString,
  kind: ServerProviderResetKind,
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

export const ServerProviderResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  nextExpiresAt: Schema.optional(IsoDateTime),
  /** Pins hub redemption to the displayed credit, including retries from another client. */
  nextCreditId: Schema.optional(TrimmedNonEmptyString),
  /** Each banked reset, when the provider lists them; it may list fewer than `availableCount`. */
  credits: Schema.optional(ForwardCompatibleArray(ServerProviderResetCredit)),
});
export type ServerProviderResetCredits = typeof ServerProviderResetCredits.Type;

/** Clear bars for unavailable accounts; retain last good bars after a failed probe. */
export const ServerProviderUsageLimits = Schema.Struct({
  checkedAt: IsoDateTime,
  windows: ForwardCompatibleArray(ServerProviderUsageWindow),
  credentialFingerprint: Schema.optional(TrimmedNonEmptyString),
  /** The provider account's `usageAccountKey`: equal on every machine, never the id itself. */
  accountKey: Schema.optional(TrimmedNonEmptyString),
  plan: Schema.optional(TrimmedNonEmptyString),
  credits: Schema.optional(ServerProviderUsageCredits),
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
  usageLimits: ServerProviderUsageLimits,
});
export type UsageLimitSourceAccount = typeof UsageLimitSourceAccount.Type;

export const UsageLimitSourceSnapshot = Schema.Struct({
  id: UsageLimitSourceId,
  kind: Schema.Literal("cliproxy"),
  label: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  accounts: ForwardCompatibleArray(UsageLimitSourceAccount),
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
  Schema.Struct({ instanceId: ProviderInstanceId }),
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

/** An account CodeShip skips after a usage refusal until the hold ends or Try again lifts it. */
export const ProviderUsageHold = Schema.Struct({
  instanceId: ProviderInstanceId,
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
