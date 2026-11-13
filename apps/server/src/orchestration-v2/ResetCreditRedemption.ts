import {
  type ProviderConsumeResetCreditResult,
  type ProviderInstanceId,
  ProviderSetupError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class ResetCreditRedemption extends Context.Service<
  ResetCreditRedemption,
  {
    /**
     * Redeems one of the account's banked reset credits. A reset, confirmed or not, also ends the
     * account's recorded usage-limit holds, so its next turn, account switching and new threads
     * see the room it got.
     */
    readonly redeem: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, ProviderSetupError>;
  }
>()("t3/orchestration-v2/ResetCreditRedemption") {}

export const layer = Layer.effect(
  ResetCreditRedemption,
  Effect.gen(function* () {
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return ResetCreditRedemption.of({
      redeem: Effect.fn("ResetCreditRedemption.redeem")(function* (instanceId) {
        const failure = (detail: string, cause?: unknown) =>
          new ProviderSetupError({
            instanceId,
            operation: "consume-reset-credit",
            detail,
            ...(cause === undefined ? {} : { cause }),
          });
        const instance = yield* providerInstances.getInstance(instanceId);
        if (instance === undefined || !instance.enabled) {
          return yield* failure(
            instance ? "This provider is disabled." : "Provider instance not found.",
          );
        }
        if (instance.consumeResetCredit === undefined) {
          return yield* failure("This provider does not bank reset credits.");
        }
        const result = yield* instance
          .consumeResetCredit()
          .pipe(Effect.mapError((error) => failure(error.detail, error)));
        if (result.outcome === "reset") {
          yield* projections
            .liftUsageLimitHolds(instanceId, yield* DateTime.now)
            .pipe(Effect.orDie);
        }
        return result;
      }),
    });
  }),
);
