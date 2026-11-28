import type { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import { ProviderSetupError } from "@t3tools/contracts/providerSetup";
import type { ProviderConsumeResetCreditResult } from "@t3tools/contracts/providerUsageLimits";
import type { ServerProvider } from "@t3tools/contracts/server";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type {
  ProviderConsumeResetCreditRequest,
  ProviderInstance,
} from "@t3tools/provider-core/server/driver";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class ResetCreditRedemption extends Context.Service<
  ResetCreditRedemption,
  {
    /**
     * Redeems one banked reset of the account shown when called, never one the login switched to
     * meanwhile. A reset, confirmed or not, ends the account's usage-limit holds. `request` names
     * the kind to claim and the key that makes a repeat of the same claim idempotent.
     */
    readonly redeem: (
      instanceId: ProviderInstanceId,
      request?: ProviderConsumeResetCreditRequest,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, ProviderSetupError>;
    /**
     * Reads the account's usage uncached and redeems what `decide` asks for on that reading, both
     * under the account's redemption lock, so a reset used meanwhile is seen before another is
     * spent. None when the read failed, made no new reading, found another account, or `decide`
     * declined.
     */
    readonly redeemOnFreshRead: <E>(
      instanceId: ProviderInstanceId,
      decide: (fresh: ServerProvider) => Effect.Effect<ProviderConsumeResetCreditRequest | null, E>,
    ) => Effect.Effect<Option.Option<ProviderConsumeResetCreditResult>, ProviderSetupError | E>;
  }
>()("t3/orchestration-v2/ResetCreditRedemption") {}

const readAtMs = (snapshot: ServerProvider) => {
  const usage = snapshot.usageLimits;
  return usage === undefined ? Number.NaN : Date.parse(usage.accountReadAt ?? usage.checkedAt);
};

export const layer = Layer.effect(
  ResetCreditRedemption,
  Effect.gen(function* () {
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    // Instances that share a login share its account, so the lock follows the account.
    const accountLocks = yield* KeyedLock.make<string>();

    const failure = (instanceId: ProviderInstanceId, detail: string, cause?: unknown) =>
      new ProviderSetupError({
        instanceId,
        operation: "consume-reset-credit",
        detail,
        ...(cause === undefined ? {} : { cause }),
      });

    const shownAccount = (instance: ProviderInstance) =>
      Effect.map(instance.snapshot.getSnapshot, (snapshot) => snapshot.usageLimits?.accountKey);

    const redeemer = Effect.fn("ResetCreditRedemption.redeemer")(function* (
      instanceId: ProviderInstanceId,
    ) {
      const instance = yield* providerInstances.getInstance(instanceId);
      if (instance === undefined || !instance.enabled) {
        return yield* failure(
          instanceId,
          instance ? "This provider is disabled." : "Provider instance not found.",
        );
      }
      const consume = instance.consumeResetCredit;
      if (consume === undefined) {
        return yield* failure(instanceId, "This provider does not bank reset credits.");
      }
      return { instance, consume, accountKey: yield* shownAccount(instance) };
    });

    const consumeWith = Effect.fn("ResetCreditRedemption.consume")(function* (
      instanceId: ProviderInstanceId,
      consume: NonNullable<ProviderInstance["consumeResetCredit"]>,
      request: ProviderConsumeResetCreditRequest | undefined,
    ) {
      const result = yield* consume(request).pipe(
        Effect.mapError((error) => failure(instanceId, error.detail, error)),
      );
      if (result.outcome === "reset") {
        yield* projections.liftUsageLimitHolds(instanceId, yield* DateTime.now).pipe(Effect.orDie);
      }
      return result;
    });

    return ResetCreditRedemption.of({
      redeem: Effect.fn("ResetCreditRedemption.redeem")(function* (instanceId, request) {
        const { instance, consume, accountKey } = yield* redeemer(instanceId);
        const forAccount = request?.accountKey ?? accountKey;
        return yield* accountLocks.withLock(
          forAccount ?? instanceId,
          Effect.gen(function* () {
            // The login can switch while this waits; naming the account makes the provider refuse it.
            if (forAccount === undefined && (yield* shownAccount(instance)) !== undefined) {
              return yield* failure(
                instanceId,
                "The account changed while the reset waited, so nothing was used.",
              );
            }
            return yield* consumeWith(
              instanceId,
              consume,
              forAccount === undefined ? request : { ...request, accountKey: forAccount },
            );
          }),
        );
      }),
      redeemOnFreshRead: Effect.fn("ResetCreditRedemption.redeemOnFreshRead")(function* <E>(
        instanceId: ProviderInstanceId,
        decide: (
          fresh: ServerProvider,
        ) => Effect.Effect<ProviderConsumeResetCreditRequest | null, E>,
      ): Effect.fn.Return<Option.Option<ProviderConsumeResetCreditResult>, ProviderSetupError | E> {
        const { instance, consume, accountKey } = yield* redeemer(instanceId);
        const refreshUsage = instance.snapshot.refreshUsage;
        if (refreshUsage === undefined) return Option.none();
        return yield* accountLocks.withLock(
          accountKey ?? instanceId,
          Effect.gen(function* () {
            const before = readAtMs(yield* instance.snapshot.getSnapshot);
            const startedMs = DateTime.toEpochMillis(yield* DateTime.now);
            yield* refreshUsage.pipe(
              Effect.mapError((error) => failure(instanceId, "Usage could not be read.", error)),
            );
            const fresh = yield* instance.snapshot.getSnapshot;
            const usage = fresh.usageLimits;
            const readAt = readAtMs(fresh);
            // A failed read keeps the usage from before it, and a queued refresh may not have run.
            const read =
              usage?.unavailable === undefined && readAt >= startedMs && readAt !== before;
            if (!read || usage?.accountKey !== accountKey) return Option.none();
            const request = yield* decide(fresh);
            if (request === null) return Option.none();
            return Option.some(yield* consumeWith(instanceId, consume, request));
          }),
        );
      }),
    });
  }),
);
