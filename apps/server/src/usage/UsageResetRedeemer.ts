import {
  isProviderAvailable,
  type OrchestratorMcpLastRedemption,
  type OrchestratorMcpRedemptionOutcome,
  type ProviderConsumeResetCreditOutcome,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderResetKind,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { accountUsageTier, usageScopeCoversModel } from "@t3tools/shared/usageLimits";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ResetCreditRedemption from "../orchestration-v2/ResetCreditRedemption.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { decideUsageReset } from "./usageResetRule.ts";

// A claim that used nothing is tried again no sooner than this, so a provider that keeps refusing
// is not asked, and the account not read uncached, every tick.
const FAILED_CLAIM_RETRY_MS = 15 * 60_000;

const OUTCOMES = {
  reset: "reset",
  alreadyRedeemed: "already_used",
  nothingToReset: "not_limited",
  noCredit: "no_reset",
} as const satisfies Record<ProviderConsumeResetCreditOutcome, OrchestratorMcpRedemptionOutcome>;

/** The unscoped meters of an account share its driver's limit id; a scoped meter has its own. */
const ACCOUNT_LIMIT_IDS: Readonly<Record<string, string>> = {
  claudeAgent: "claude",
  codex: "codex",
};

interface Claim {
  readonly kind: ServerProviderResetKind;
  readonly limitId: string;
  readonly boundaryMs: number;
  readonly reason: "reset-too-far" | "reset-expiring";
}

/** The last claim tried on an account, and whether another try of the same one is pointless. */
interface Attempt {
  readonly key: string;
  readonly kind: ServerProviderResetKind;
  readonly atMs: number;
  readonly final: boolean;
}

/** Only a claim that spent a reset, here or under the same key before, settles its run-out. */
const SETTLED_OUTCOMES: ReadonlySet<OrchestratorMcpRedemptionOutcome> = new Set([
  "reset",
  "already_used",
]);

export class UsageResetRedeemer extends Context.Service<
  UsageResetRedeemer,
  {
    /**
     * The last claim made for each account since the server started, by the account key usage
     * publishes, so an instance signed into another account since shows none of it.
     */
    readonly lastRedemptions: Effect.Effect<ReadonlyMap<string, OrchestratorMcpLastRedemption>>;
  }
>()("t3/usage/UsageResetRedeemer") {}

const isRedeemable = (provider: ServerProvider) =>
  provider.enabled &&
  provider.billingKind !== "payPerUse" &&
  provider.auth.status === "authenticated" &&
  // An account another instance already uses is that instance's to redeem.
  provider.availability !== "unavailable" &&
  provider.usageLimits?.accountKey !== undefined &&
  ACCOUNT_LIMIT_IDS[provider.driver] !== undefined;

/** The claim the rule calls for on this reading, or null when the account runs, waits or has nothing to claim. */
function claimFor(provider: ServerProvider, nowMs: number, maxWaitHours: number): Claim | null {
  const limits = provider.usageLimits;
  const accountLimitId = ACCOUNT_LIMIT_IDS[provider.driver];
  if (limits === undefined || accountLimitId === undefined) return null;
  const decision = decideUsageReset(limits, { nowMs, maxWaitHours, accountLimitId });
  return decision.action === "claim" ? decision : null;
}

function hasRoomBeforeReset(
  provider: ServerProvider,
  claim: Claim,
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
): boolean {
  const scope = claim.limitId.split("_scoped:")[1];
  const models = provider.models.filter(
    (model) => scope === undefined || usageScopeCoversModel(scope, model.slug),
  );
  return providers.some((candidate) => {
    if (
      candidate.driver !== provider.driver ||
      !candidate.enabled ||
      !candidate.installed ||
      candidate.status === "error" ||
      candidate.auth.status !== "authenticated" ||
      !isProviderAvailable(candidate)
    )
      return false;
    const hasRoom = (model?: string) => {
      const tier = accountUsageTier(candidate, nowMs, model);
      return tier === 0;
    };
    return (
      models.some((model) => {
        const resolved = resolveSelectableModel(candidate.driver, model.slug, candidate.models);
        return resolved !== null && hasRoom(resolved);
      }) ||
      (models.length === 0 && scope === undefined && hasRoom())
    );
  });
}

/** The same shape for both drivers, so one boundary of one limit is claimed once. */
const attemptKey = (accountKey: string, claim: Claim) =>
  `banked-reset:${accountKey}:${claim.limitId}:${Math.floor(claim.boundaryMs / 1000)}`;

const sameClaim = (left: Claim, right: Claim | null) =>
  right !== null &&
  left.kind === right.kind &&
  left.limitId === right.limitId &&
  left.boundaryMs === right.boundaryMs;

export const layer = Layer.effect(
  UsageResetRedeemer,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const redemption = yield* ResetCreditRedemption.ResetCreditRedemption;
    const records = yield* Ref.make(new Map<string, OrchestratorMcpLastRedemption>());
    const attempts = yield* Ref.make(new Map<ProviderInstanceId, Attempt>());

    const nowMs = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

    const remember =
      <Key, Value>(ref: Ref.Ref<Map<Key, Value>>) =>
      (key: Key, value: Value) =>
        Ref.update(ref, (current) => new Map(current).set(key, value));

    const redeemOn = Effect.fn("UsageResetRedeemer.redeemOn")(function* (
      provider: ServerProvider,
      maxWaitHours: number,
      providers: ReadonlyArray<ServerProvider>,
    ) {
      const { instanceId } = provider;
      const accountKey = provider.usageLimits?.accountKey;
      const first = claimFor(provider, yield* nowMs, maxWaitHours);
      if (first === null || accountKey === undefined) return;
      if (hasRoomBeforeReset(provider, first, providers, yield* nowMs)) return;
      const key = attemptKey(accountKey, first);
      const previous = (yield* Ref.get(attempts)).get(instanceId);
      if (previous?.key === key && previous.kind === first.kind) {
        if (previous.final) return;
        if ((yield* nowMs) < previous.atMs + FAILED_CLAIM_RETRY_MS) return;
      }
      const request = { kind: first.kind, attemptKey: key, accountKey };
      // A reading can be minutes old, and the person may have used or switched the account or
      // turned this off since, so the claim is made only when a fresh reading still calls for it.
      const result = yield* redemption
        .redeemOnFreshRead(instanceId, (fresh) =>
          Effect.gen(function* () {
            const current = yield* settings.getSettings;
            const claim =
              current.redeemUsageResets && fresh.usageLimits?.accountKey === accountKey
                ? claimFor(fresh, yield* nowMs, current.maxPlanResetWaitHours)
                : null;
            if (!sameClaim(first, claim)) return null;
            const peers = (yield* providerRegistry.getProviders).map((candidate) =>
              candidate.instanceId === fresh.instanceId ? fresh : candidate,
            );
            return hasRoomBeforeReset(fresh, first, peers, yield* nowMs) ? null : request;
          }),
        )
        .pipe(
          Effect.map(Option.map((redeemed) => OUTCOMES[redeemed.outcome])),
          Effect.catchCause((cause) =>
            Effect.logWarning("usage-reset-redeemer.claim-failed", {
              instanceId,
              errorTag: causeErrorTag(cause),
            }).pipe(Effect.as(Option.some("failed" as const))),
          ),
        );
      const at = yield* nowMs;
      const final = Option.isSome(result) && SETTLED_OUTCOMES.has(result.value);
      yield* remember(attempts)(instanceId, { key, kind: first.kind, atMs: at, final });
      if (Option.isNone(result)) return;
      const outcome = result.value;
      yield* remember(records)(accountKey, {
        at: DateTime.formatIso(DateTime.makeUnsafe(at)),
        outcome,
        kind: first.kind,
        reason: first.reason,
      });
      yield* Effect.logInfo("usage-reset-redeemer.claimed", {
        instanceId,
        outcome,
        kind: first.kind,
        limitId: first.limitId,
        reason: first.reason,
      });
    });

    const sweep = Effect.gen(function* () {
      const current = yield* settings.getSettings;
      if (!current.redeemUsageResets) return;
      const providers = yield* providerRegistry.getProviders;
      // One claim per account per tick: the next reading shows what the claim cleared.
      for (const provider of providers.filter(isRedeemable)) {
        yield* redeemOn(provider, current.maxPlanResetWaitHours, providers).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("usage-reset-redeemer.sweep-failed", {
              instanceId: provider.instanceId,
              errorTag: causeErrorTag(cause),
            }),
          ),
        );
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("usage-reset-redeemer.settings-failed", {
          errorTag: causeErrorTag(cause),
        }),
      ),
    );

    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-reset-redeemer", sweep);

    return UsageResetRedeemer.of({
      lastRedemptions: Ref.get(records),
    });
  }),
);
