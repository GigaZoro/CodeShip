import { assert, it } from "@effect/vitest";
import {
  type ProviderConsumeResetCreditResult,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ResetCreditRedemption from "./ResetCreditRedemption.ts";

const instanceId = ProviderInstanceId.make("codex_work");

it.effect.each([
  { result: { outcome: "reset" }, lifted: true },
  // The credit was spent even though the new limits could not be read back.
  { result: { outcome: "reset", warning: "Refresh to check." }, lifted: true },
  { result: { outcome: "nothingToReset" }, lifted: false },
  { result: { outcome: "noCredit" }, lifted: false },
] as const)(
  "a $result.outcome redemption lifts the account's holds: $lifted",
  ({ result, lifted }) =>
    Effect.gen(function* () {
      const lifts = yield* Ref.make<ReadonlyArray<ProviderInstanceId>>([]);
      const layer = ResetCreditRedemption.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: () =>
                Effect.succeed({
                  instanceId,
                  driverKind: ProviderDriverKind.make("codex"),
                  enabled: true,
                  consumeResetCredit: () =>
                    Effect.succeed<ProviderConsumeResetCreditResult>(result),
                } as unknown as ProviderInstance),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              liftUsageLimitHolds: (id) => Ref.update(lifts, (current) => [...current, id]),
            }),
          ),
        ),
      );
      const redemption = yield* ResetCreditRedemption.ResetCreditRedemption.pipe(
        Effect.provide(layer),
      );
      assert.deepEqual(yield* redemption.redeem(instanceId), result);
      assert.deepEqual(yield* Ref.get(lifts), lifted ? [instanceId] : []);
    }),
);
