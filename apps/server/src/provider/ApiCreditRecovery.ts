import { isProviderAvailable } from "@t3tools/contracts/provider";
import { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import { ClaudeSettings } from "@t3tools/contracts/settings";
import { isSecretReference, settingsSecretLiteral } from "@t3tools/contracts/settingsSecretValue";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { accountCapacityExpiresAt, accountUsageTier } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as ApiCreditBalance from "./ApiCreditBalance.ts";
import { checkApiCredit } from "./ApiCreditCheck.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

export class ApiCreditRecoveryError extends Schema.TaggedError<ApiCreditRecoveryError>()(
  "ApiCreditRecoveryError",
  { instanceId: ProviderInstanceId, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class ApiCreditRecovery extends Context.Service<
  ApiCreditRecovery,
  {
    readonly check: (instanceId: ProviderInstanceId) => Effect.Effect<void, ApiCreditRecoveryError>;
  }
>()("t3/provider/ApiCreditRecovery") {}

export const layer = Layer.effect(
  ApiCreditRecovery,
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const settings = yield* ServerSettings.ServerSettingsService;
    const secrets = yield* SecretResolver.SecretResolver;
    const balances = yield* ApiCreditBalance.ApiCreditBalance;
    const usage = yield* UsageService.UsageService;
    // The check captures its HTTP/process services when the service is built.
    const context = yield* Effect.context<Effect.Services<ReturnType<typeof checkApiCredit>>>();
    return ApiCreditRecovery.of({
      check: Effect.fn("ApiCreditRecovery.check")(function (instanceId) {
        return Effect.gen(function* () {
          const providers = yield* registry.getProviders;
          const provider = providers.find((entry) => entry.instanceId === instanceId);
          if (provider?.driver !== "claudeAgent" || provider.billingKind !== "payPerUse") return;
          const balance = yield* balances.snapshot(instanceId);
          if (balance?.balanceState === "available") return;
          if (balance === undefined)
            return yield* new ApiCreditRecoveryError({
              instanceId,
              detail: "Configure this account's linked plan, grant and cycle end first.",
            });
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const linkedPlan = providers.find(
            (entry) => entry.instanceId === balance.linkedPlanInstanceId,
          );
          if (
            !provider.enabled ||
            !provider.installed ||
            provider.auth.status !== "authenticated" ||
            linkedPlan?.driver !== "claudeAgent" ||
            !linkedPlan.enabled ||
            linkedPlan.billingKind === "payPerUse" ||
            linkedPlan.instanceId === instanceId ||
            !(balance.grantUsd > 0) ||
            !Number.isFinite(Date.parse(balance.cycleEnd)) ||
            Date.parse(balance.cycleEnd) <= now
          )
            return yield* new ApiCreditRecoveryError({
              instanceId,
              detail:
                "Configure a valid Claude API account, linked plan and monthly grant before checking credit.",
            });
          if (
            providers.some(
              (entry) =>
                entry.driver === provider.driver &&
                entry.enabled &&
                entry.installed &&
                entry.auth.status === "authenticated" &&
                isProviderAvailable(entry) &&
                entry.billingKind !== "payPerUse" &&
                accountUsageTier(entry, now) === 0 &&
                accountCapacityExpiresAt(entry, now) <= Date.parse(balance.cycleEnd),
            )
          )
            return yield* new ApiCreditRecoveryError({
              instanceId,
              detail: "Plan capacity expires first. API credit checks wait until it is used.",
            });
          const entry = (yield* settings.getSettings).providerInstances[instanceId];
          const config = yield* decodeClaudeSettings(entry?.config ?? {});
          const apiKey = isSecretReference(config.apiKey)
            ? (yield* secrets.read([config.apiKey]))[0]
            : settingsSecretLiteral(config.apiKey);
          if (apiKey === undefined)
            return yield* new ApiCreditRecoveryError({
              instanceId,
              detail: "Could not read the API key from its secret provider.",
            });
          const result = yield* Effect.gen(function* () {
            const result = yield* checkApiCredit({ apiKey });
            const costs = yield* usage.priceTokens([
              {
                model: result.model,
                totals: {
                  uncachedInputTokens: result.inputTokens,
                  cachedInputTokens: result.cachedInputTokens,
                  cacheCreationTokens: result.cacheWriteInputTokens,
                  outputTokens: result.outputTokens,
                  reasoningTokens: 0,
                },
              },
            ]);
            return { costUsd: costs[0] ?? null };
          }).pipe(
            Effect.tapError((error) => balances.recordFailure(instanceId, provider.driver, error)),
          );
          yield* balances.recordCheckSpend(instanceId, result.costUsd);
          yield* balances.recordSuccess(instanceId);
        }).pipe(
          Effect.provide(context),
          Effect.mapError(
            (error) =>
              new ApiCreditRecoveryError({
                instanceId,
                detail: error.message,
              }),
          ),
        );
      }),
    });
  }),
);
