import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ApiCreditBalance from "./ApiCreditBalance.ts";

it.each([
  {
    driver: "claudeAgent",
    error: { error: "billing_error", message: "Credit balance is too low" },
    exhausted: true,
  },
  {
    driver: "claudeAgent",
    error: {
      status: 400,
      message:
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    },
    exhausted: true,
  },
  {
    driver: "claudeAgent",
    error: { status: 429, message: "Rate limit exceeded" },
    exhausted: false,
  },
  { driver: "codex", error: { code: "insufficient_quota" }, exhausted: false },
])(
  "classifies only Claude API credit exhaustion ($driver / $exhausted)",
  ({ driver, error, exhausted }) => {
    assert.equal(ApiCreditBalance.apiCreditExhaustion(driver, error) !== null, exhausted);
  },
);

it.each([
  {
    now: "2028-02-28T12:00:00.000Z",
    start: "2028-01-31T12:00:00.000Z",
    end: "2028-02-29T12:00:00.000Z",
  },
  {
    now: "2028-02-29T12:00:00.000Z",
    start: "2028-02-29T12:00:00.000Z",
    end: "2028-03-31T12:00:00.000Z",
  },
  {
    now: "2029-02-28T12:00:00.000Z",
    start: "2029-02-28T12:00:00.000Z",
    end: "2029-03-31T12:00:00.000Z",
  },
])("advances monthly expiry without drifting after February: $now", ({ now, start, end }) => {
  assert.deepEqual(ApiCreditBalance.apiCreditCycle("2028-01-31T12:00:00.000Z", Date.parse(now)), {
    cycleStart: start,
    cycleEnd: end,
  });
});

it.effect(
  "persists refusal through restart and edits, clearing only on success or the next cycle",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claude_api");
      const config = {
        linkedPlanInstanceId: ProviderInstanceId.make("claude_plan"),
        grantUsd: 0.5,
        cycleEnd: "2026-11-30T12:00:00.000Z",
      };
      yield* TestClock.setTime(Date.parse("2026-11-19T12:00:00.000Z"));
      const first = yield* Effect.gen(function* () {
        const balance = yield* ApiCreditBalance.make;
        assert.equal(yield* balance.snapshot(instanceId), undefined);
        assert.equal(
          (yield* balance.assertAvailable(instanceId).pipe(Effect.flip))._tag,
          "ApiCreditExhausted",
        );
        yield* balance.configure(instanceId, config);
        yield* balance.recordFailure(
          instanceId,
          "claudeAgent",
          new Error("Credit balance is too low."),
        );
        yield* balance.recordCheckSpend(instanceId, 0.25);
        yield* balance.recordCheckSpend(instanceId, null);
        return yield* balance.snapshot(instanceId);
      }).pipe(Effect.scoped);
      yield* TestClock.adjust("5 days");
      yield* Effect.gen(function* () {
        const balance = yield* ApiCreditBalance.make;
        assert.deepEqual(yield* balance.snapshot(instanceId), first);
        yield* balance.configure(instanceId, { ...config, grantUsd: 1 });
        assert.equal(
          (yield* balance.assertAvailable(instanceId).pipe(Effect.flip))._tag,
          "ApiCreditExhausted",
        );
        yield* balance.recordFailure(instanceId, "claudeAgent", {
          status: 429,
          type: "rate_limit_error",
        });
        yield* balance.recordCheckSpend(instanceId, 1.5);
        assert.equal((yield* balance.snapshot(instanceId))?.balanceState, "exhausted");
        yield* balance.recordSuccess(instanceId);
        yield* balance.assertAvailable(instanceId);
        assert.equal((yield* balance.snapshot(instanceId))?.spendUsd, 1.75);
        yield* balance.recordFailure(instanceId, "claudeAgent", "Credit balance is too low");
        yield* TestClock.setTime(Date.parse("2026-11-30T12:00:00.000Z"));
        yield* balance.assertAvailable(instanceId);
        const renewed = yield* balance.snapshot(instanceId);
        assert.equal(renewed?.spendUsd, 0);
        assert.equal(renewed?.unpricedUsage, false);
        assert.equal(renewed?.exhaustedAt, undefined);
        assert.equal(renewed?.cycleStart, "2026-11-30T12:00:00.000Z");
        assert.equal(renewed?.cycleEnd, "2026-12-30T12:00:00.000Z");
        assert.equal(renewed?.meteringStartedAt, first?.meteringStartedAt);
      }).pipe(Effect.scoped);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
