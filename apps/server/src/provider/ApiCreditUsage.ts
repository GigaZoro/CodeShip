import type { ApiCreditUsageRow } from "@t3tools/contracts/apiCreditUsage";
import type { ServerProviderApiCredit } from "@t3tools/contracts/provider";
import type { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import type { ServerProvider } from "@t3tools/contracts/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ApiCreditBalance } from "./ApiCreditBalance.ts";
import { UsageService } from "../usage/UsageService.ts";

export function apiCreditUsageRows(
  providers: ReadonlyArray<ServerProvider>,
  credits: ReadonlyMap<ProviderInstanceId, ServerProviderApiCredit>,
): ReadonlyArray<ApiCreditUsageRow> {
  return providers
    .filter((provider) => provider.driver === "claudeAgent" && provider.billingKind !== "payPerUse")
    .map((plan) => ({
      planInstanceId: plan.instanceId,
      planName: plan.displayName ?? plan.instanceId,
      suggestedGrantUsd: (() => {
        const tier = plan.usageLimits?.plan?.toLowerCase().replace(/[\s_-]+/g, "");
        return [
          "max",
          "maxplan",
          "max5",
          "claudemaxsubscription",
          "claudemax5xsubscription",
        ].includes(tier ?? "")
          ? 100
          : ["ultra", "max20", "claudemax20xsubscription"].includes(tier ?? "")
            ? 200
            : null;
      })(),
      apiAccounts: providers.flatMap((provider) => {
        const credit = credits.get(provider.instanceId);
        return credit?.linkedPlanInstanceId === plan.instanceId
          ? [
              {
                instanceId: provider.instanceId,
                displayName: provider.displayName ?? provider.instanceId,
                credit,
              },
            ]
          : [];
      }),
    }));
}

export class ApiCreditUsage extends Context.Service<
  ApiCreditUsage,
  {
    readonly listRows: (
      providers: ReadonlyArray<ServerProvider>,
    ) => Effect.Effect<ReadonlyArray<ApiCreditUsageRow>>;
    readonly read: (
      providers: ReadonlyArray<ServerProvider>,
    ) => Effect.Effect<ReadonlyMap<ProviderInstanceId, ServerProviderApiCredit>>;
  }
>()("t3/provider/ApiCreditUsage") {}

const make = Effect.gen(function* () {
  const balances = yield* ApiCreditBalance;
  const usage = yield* UsageService;
  const read = Effect.fn("ApiCreditUsage.read")(function* (
    providers: ReadonlyArray<ServerProvider>,
  ) {
    const result = new Map<ProviderInstanceId, ServerProviderApiCredit>();
    for (const provider of providers) {
      if (
        provider.driver !== "claudeAgent" ||
        provider.billingKind !== "payPerUse" ||
        !provider.payPerUse
      )
        continue;
      const balance = yield* balances.snapshot(provider.instanceId);
      if (balance !== undefined) result.set(provider.instanceId, balance);
    }
    const spend = yield* usage
      .readAccountSpend(
        [...result].map(([instanceId, balance]) => ({
          instanceId,
          since:
            balance.meteringStartedAt > balance.cycleStart
              ? balance.meteringStartedAt
              : balance.cycleStart,
        })),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not meter Claude API credit usage", { cause }).pipe(
            Effect.as(
              new Map<
                ProviderInstanceId,
                { spendUsd: number | null; unpricedUsage: boolean; sharedWith?: ProviderInstanceId }
              >(),
            ),
          ),
        ),
      );
    for (const [instanceId, balance] of result) {
      const history = spend.get(instanceId);
      const unpricedUsage =
        balance.unpricedUsage ||
        history === undefined ||
        history.unpricedUsage ||
        history.spendUsd === null;
      const spendUsd =
        balance.spendUsd === null && history?.spendUsd == null
          ? null
          : (balance.spendUsd ?? 0) + (history?.spendUsd ?? 0);
      result.set(instanceId, {
        ...balance,
        spendUsd,
        unpricedUsage,
        estimatedRemainingUsd:
          unpricedUsage || spendUsd === null ? null : Math.max(0, balance.grantUsd - spendUsd),
        ...(history?.sharedWith ? { sharedWith: history.sharedWith } : {}),
      });
    }
    return result;
  });
  return ApiCreditUsage.of({
    read,
    listRows: Effect.fn("ApiCreditUsage.listRows")(function* (
      providers: ReadonlyArray<ServerProvider>,
    ) {
      return apiCreditUsageRows(providers, yield* read(providers));
    }),
  });
});
export const layer = Layer.effect(ApiCreditUsage, make);
