import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as ApiCreditBalance from "./ApiCreditBalance.ts";
import * as ApiCreditRecovery from "./ApiCreditRecovery.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

it.effect("checks Claude credit in expiry order and recovers only on metered success", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-19T12:00:00Z"));
    const instanceId = ProviderInstanceId.make("claude_api");
    const api: ServerProvider = {
      instanceId,
      driver: ProviderDriverKind.make("claudeAgent"),
      billingKind: "payPerUse",
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated", type: "apiKey" },
      checkedAt: "2026-11-19T12:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    };
    const plan: ServerProvider = {
      ...api,
      instanceId: ProviderInstanceId.make("claude_plan"),
      billingKind: "plan",
      auth: { status: "authenticated", type: "oauth" },
    };
    const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([plan, api]);
    const requests = yield* Ref.make(0);
    const response = yield* Ref.make({ status: 429, code: "rate_limit_exceeded" });
    const balances = yield* ApiCreditBalance.make;

    yield* Effect.gen(function* () {
      const recovery = yield* ApiCreditRecovery.ApiCreditRecovery;
      const missing = yield* recovery.check(instanceId).pipe(Effect.flip);
      assert.include(missing.detail, "Configure");
      assert.equal(yield* Ref.get(requests), 0);
      yield* balances.configure(instanceId, {
        linkedPlanInstanceId: plan.instanceId,
        grantUsd: 200,
        cycleEnd: "2026-12-01T00:00:00Z",
      });
      yield* balances.recordFailure(instanceId, "claudeAgent", {
        message: "Credit balance is too low",
      });
      const blocked = yield* recovery.check(instanceId).pipe(Effect.flip);
      assert.include(blocked.detail, "Plan capacity expires first");
      assert.equal(yield* Ref.get(requests), 0);
      const planWithReset = (resetsAt: string): ServerProvider => ({
        ...plan,
        usageLimits: {
          checkedAt: plan.checkedAt,
          windows: [
            { id: "five_hour", kind: "session", label: "Session", usedPercent: 0, resetsAt },
          ],
        },
      });
      yield* Ref.set(providers, [planWithReset("2026-11-20T00:00:00.000Z"), api]);
      yield* recovery.check(instanceId).pipe(Effect.flip);
      assert.equal(yield* Ref.get(requests), 0);
      yield* Ref.set(providers, [planWithReset("2026-12-10T00:00:00.000Z"), api]);
      yield* recovery.check(instanceId).pipe(Effect.flip);
      assert.equal((yield* balances.snapshot(instanceId))?.balanceState, "exhausted");
      yield* Ref.set(response, { status: 400, code: "invalid_request_error" });
      yield* recovery.check(instanceId).pipe(Effect.flip);
      assert.equal((yield* balances.snapshot(instanceId))?.balanceState, "exhausted");
      yield* Ref.set(response, { status: 200, code: "" });
      yield* recovery.check(instanceId);
      const recovered = yield* balances.snapshot(instanceId);
      assert.equal(recovered?.balanceState, "available");
      assert.equal(recovered?.spendUsd, 0.00001);
      assert.equal(yield* Ref.get(requests), 3);
      yield* recovery.check(instanceId);
      assert.equal(yield* Ref.get(requests), 3);
    }).pipe(
      Effect.provide(
        ApiCreditRecovery.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ApiCreditBalance.ApiCreditBalance, balances),
              Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Ref.get(providers) }),
              Layer.mock(SecretResolver.SecretResolver)({}),
              Layer.mock(UsageService.UsageService)({
                clientSettingsKey: () => "test-settings",
                priceTokens: (items) =>
                  Effect.sync(() => {
                    assert.deepStrictEqual(items, [
                      {
                        model: "claude-haiku-4-5-20251001",
                        totals: {
                          uncachedInputTokens: 2,
                          cachedInputTokens: 0,
                          cacheCreationTokens: 0,
                          outputTokens: 1,
                          reasoningTokens: 0,
                        },
                      },
                    ]);
                    return [0.00001];
                  }),
              }),
              ServerSettings.layerTest({
                providerInstances: {
                  [instanceId]: {
                    driver: "claudeAgent",
                    enabled: true,
                    config: {
                      billingKind: "payPerUse",
                      apiKey: "test-key",
                      linkedPlanInstanceId: plan.instanceId,
                      apiCreditGrantUsd: 200,
                      apiCreditCycleEnd: "2026-12-01T00:00:00Z",
                    },
                  },
                },
              }),
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) =>
                  Effect.gen(function* () {
                    yield* Ref.update(requests, (count) => count + 1);
                    const current = yield* Ref.get(response);
                    return HttpClientResponse.fromWeb(
                      request,
                      Response.json(
                        current.status === 200
                          ? {
                              model: "claude-haiku-4-5-20251001",
                              usage: { input_tokens: 2, output_tokens: 1 },
                            }
                          : {
                              error: {
                                type: current.code,
                                message:
                                  current.status === 400
                                    ? "Credit balance is too low"
                                    : "upstream failure",
                              },
                            },
                        { status: current.status },
                      ),
                    );
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
