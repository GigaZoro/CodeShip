import type { ServerProviderApiCredit } from "@t3tools/contracts/provider";
import { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

export class ApiCreditExhausted extends Schema.TaggedError<ApiCreditExhausted>()(
  "ApiCreditExhausted",
  { instanceId: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface ApiCreditConfiguration {
  readonly linkedPlanInstanceId: ProviderInstanceId;
  readonly grantUsd: number;
  readonly cycleEnd: string;
}

export function apiCreditCycle(anchor: string, nowMs: number) {
  const date = DateTime.makeUnsafe(anchor);
  const start = DateTime.toPartsUtc(date);
  const now = DateTime.toPartsUtc(DateTime.makeUnsafe(nowMs));
  const boundary = (months: number) => DateTime.add(date, { months });
  let offset = (now.year - start.year) * 12 + now.month - start.month;
  if (DateTime.toEpochMillis(boundary(offset)) <= nowMs) offset++;
  return {
    cycleStart: DateTime.formatIso(boundary(offset - 1)),
    cycleEnd: DateTime.formatIso(boundary(offset)),
  };
}

/** Claude translates the upstream HTTP 400 into this billing-error text. */
export function apiCreditExhaustion(driver: string, error: unknown): string | null {
  if (driver !== "claudeAgent") return null;
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  for (let index = 0; index < pending.length && index < 100; index++) {
    const value = pending[index];
    if (typeof value === "string" && /\bcredit balance is too low\b/i.test(value))
      return "Anthropic API credit is exhausted: Credit balance is too low.";
    if (value !== null && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      if (value instanceof Error) pending.push(value.message, value.cause);
      pending.push(...Object.values(value));
    }
  }
  return null;
}

interface BalanceRow {
  instance_id: string;
  linked_plan_instance_id: string;
  grant_usd: number;
  cycle_anchor: string;
  cycle_start: string;
  cycle_end: string;
  balance_state: "available" | "exhausted";
  checked_at: string;
  metering_started_at: string;
  exhausted_at: string | null;
  reason: string | null;
  check_spend_usd: number;
  unpriced_checks: number;
}

export class ApiCreditBalance extends Context.Service<
  ApiCreditBalance,
  {
    readonly configure: (
      instanceId: ProviderInstanceId,
      config: ApiCreditConfiguration,
    ) => Effect.Effect<void>;
    readonly snapshot: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ServerProviderApiCredit | undefined>;
    readonly assertAvailable: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<void, ApiCreditExhausted>;
    readonly recordFailure: (
      instanceId: ProviderInstanceId,
      driver: string,
      error: unknown,
    ) => Effect.Effect<void>;
    readonly recordSuccess: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
    readonly recordCheckSpend: (
      instanceId: ProviderInstanceId,
      costUsd: number | null,
    ) => Effect.Effect<void>;
    readonly changes: Stream.Stream<void>;
  }
>()("t3/provider/ApiCreditBalance") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
  const snapshot = Effect.fn("ApiCreditBalance.snapshot")(function* (
    instanceId: ProviderInstanceId,
  ): Effect.fn.Return<ServerProviderApiCredit | undefined> {
    const rows =
      yield* sql<BalanceRow>`SELECT * FROM api_credit_balances WHERE instance_id = ${instanceId}`.pipe(
        Effect.orDie,
      );
    const row = rows[0];
    if (row === undefined) return undefined;
    const now = DateTime.formatIso(yield* DateTime.now);
    const cycle = apiCreditCycle(row.cycle_anchor, Date.parse(now));
    if (Date.parse(cycle.cycleStart) >= Date.parse(row.cycle_end)) {
      yield* sql`UPDATE api_credit_balances SET cycle_start = ${cycle.cycleStart}, cycle_end = ${cycle.cycleEnd},
        balance_state = 'available', checked_at = ${now}, exhausted_at = NULL, reason = NULL,
        check_spend_usd = 0, unpriced_checks = 0
        WHERE instance_id = ${instanceId} AND cycle_end = ${row.cycle_end}`.pipe(Effect.orDie);
      yield* PubSub.publish(changes, undefined);
      return yield* snapshot(instanceId);
    }
    return {
      linkedPlanInstanceId: ProviderInstanceId.make(row.linked_plan_instance_id),
      grantUsd: row.grant_usd,
      cycleStart: row.cycle_start,
      cycleEnd: row.cycle_end,
      balanceState: row.balance_state,
      checkedAt: row.checked_at,
      ...(row.exhausted_at ? { exhaustedAt: row.exhausted_at } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      spendUsd: row.check_spend_usd,
      estimatedRemainingUsd: null,
      spendSource: "metered",
      unpricedUsage: row.unpriced_checks > 0,
      meteringStartedAt: row.metering_started_at,
    };
  });
  const configure = Effect.fn("ApiCreditBalance.configure")(function* (
    instanceId: ProviderInstanceId,
    config: ApiCreditConfiguration,
  ) {
    yield* snapshot(instanceId);
    const rows =
      yield* sql<BalanceRow>`SELECT * FROM api_credit_balances WHERE instance_id = ${instanceId}`.pipe(
        Effect.orDie,
      );
    const row = rows[0];
    if (
      row?.linked_plan_instance_id === config.linkedPlanInstanceId &&
      row.grant_usd === config.grantUsd &&
      row.cycle_anchor === config.cycleEnd
    )
      return;
    const now = DateTime.formatIso(yield* DateTime.now);
    const cycle = apiCreditCycle(config.cycleEnd, Date.parse(now));
    if (row === undefined) {
      yield* sql`INSERT INTO api_credit_balances
        (instance_id, linked_plan_instance_id, grant_usd, cycle_anchor, cycle_start, cycle_end, balance_state, checked_at, metering_started_at)
        VALUES (${instanceId}, ${config.linkedPlanInstanceId}, ${config.grantUsd}, ${config.cycleEnd}, ${cycle.cycleStart}, ${cycle.cycleEnd}, 'available', ${now}, ${now})
        ON CONFLICT(instance_id) DO NOTHING`.pipe(Effect.orDie);
    } else {
      const advanced = Date.parse(cycle.cycleStart) >= Date.parse(row.cycle_end);
      const uncertain =
        !advanced && cycle.cycleStart !== row.cycle_start && row.check_spend_usd > 0;
      yield* sql`UPDATE api_credit_balances SET linked_plan_instance_id = ${config.linkedPlanInstanceId},
        grant_usd = ${config.grantUsd}, cycle_anchor = ${config.cycleEnd}, cycle_start = ${cycle.cycleStart}, cycle_end = ${cycle.cycleEnd},
        balance_state = ${advanced ? "available" : row.balance_state},
        exhausted_at = ${advanced ? null : row.exhausted_at}, reason = ${advanced ? null : row.reason},
        check_spend_usd = ${advanced ? 0 : row.check_spend_usd},
        unpriced_checks = ${advanced ? 0 : row.unpriced_checks + (uncertain ? 1 : 0)}
        WHERE instance_id = ${instanceId}`.pipe(Effect.orDie);
    }
  });
  const record = Effect.fn("ApiCreditBalance.record")(function* (
    instanceId: ProviderInstanceId,
    state: "available" | "exhausted",
    reason: string | null,
  ) {
    if ((yield* snapshot(instanceId)) === undefined) return;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`UPDATE api_credit_balances SET balance_state = ${state}, checked_at = ${now},
      exhausted_at = ${state === "exhausted" ? now : null}, reason = ${reason} WHERE instance_id = ${instanceId}`.pipe(
      Effect.orDie,
    );
    yield* PubSub.publish(changes, undefined);
  });
  return ApiCreditBalance.of({
    configure,
    snapshot,
    assertAvailable: Effect.fn("ApiCreditBalance.assertAvailable")(function* (instanceId) {
      const balance = yield* snapshot(instanceId);
      if (balance === undefined || balance.balanceState === "exhausted")
        return yield* new ApiCreditExhausted({
          instanceId,
          reason: balance?.reason ?? "API credit is not configured or is exhausted.",
        });
    }),
    recordFailure: Effect.fn("ApiCreditBalance.recordFailure")(
      function* (instanceId, driver, error) {
        const reason = apiCreditExhaustion(driver, error);
        if (reason !== null) yield* record(instanceId, "exhausted", reason);
      },
    ),
    recordSuccess: Effect.fn("ApiCreditBalance.recordSuccess")((instanceId) =>
      record(instanceId, "available", null),
    ),
    recordCheckSpend: Effect.fn("ApiCreditBalance.recordCheckSpend")(
      function* (instanceId, costUsd) {
        if ((yield* snapshot(instanceId)) === undefined) return;
        yield* sql`UPDATE api_credit_balances SET check_spend_usd = check_spend_usd + ${costUsd ?? 0},
        unpriced_checks = unpriced_checks + ${costUsd === null ? 1 : 0} WHERE instance_id = ${instanceId}`.pipe(
          Effect.orDie,
        );
        yield* PubSub.publish(changes, undefined);
      },
    ),
    changes: Stream.fromPubSub(changes),
  });
});
export const layer = Layer.effect(ApiCreditBalance, make);
