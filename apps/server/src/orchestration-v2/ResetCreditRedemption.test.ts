import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import type { ProviderConsumeResetCreditResult } from "@t3tools/contracts/providerUsageLimits";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

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
                  snapshot: { getSnapshot: Effect.succeed({}) },
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

it.effect("hands the claim's kind and attempt key to the provider", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const layer = ResetCreditRedemption.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: () =>
              Effect.succeed({
                instanceId,
                driverKind: ProviderDriverKind.make("codex"),
                enabled: true,
                snapshot: { getSnapshot: Effect.succeed({}) },
                consumeResetCredit: (request?: unknown) =>
                  Ref.update(requests, (current) => [...current, request]).pipe(
                    Effect.as<ProviderConsumeResetCreditResult>({ outcome: "nothingToReset" }),
                  ),
              } as unknown as ProviderInstance),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        ),
      ),
    );
    const redemption = yield* ResetCreditRedemption.ResetCreditRedemption.pipe(
      Effect.provide(layer),
    );
    yield* redemption.redeem(instanceId, { kind: "weekly", attemptKey: "banked-reset:a:codex:1" });
    assert.deepEqual(yield* Ref.get(requests), [
      { kind: "weekly", attemptKey: "banked-reset:a:codex:1" },
    ]);
  }),
);

const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-15T12:00:00.000Z"));

/** One login whose usage read stamps the clock's time unless `staleRead`; `log` orders the steps. */
const freshReadHarness = Effect.fn("freshReadHarness")(function* (input: {
  readonly staleRead?: boolean;
  /** The reading before the call was made at the call's own time; the clock stands still. */
  readonly readAtCall?: boolean;
  /** The account the login holds, `null` for one it does not report. */
  readonly account?: string | null;
  /** From this step on the login holds another account. */
  readonly switchAt?: "read" | "manual-done";
}) {
  yield* TestClock.setTime(NOW);
  const log = yield* Ref.make<ReadonlyArray<string>>([]);
  const requests = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const account = yield* Ref.make(input.account === undefined ? "account" : input.account);
  const step = (name: string) =>
    Ref.update(log, (current) => [...current, name]).pipe(
      Effect.andThen(name === input.switchAt ? Ref.set(account, "other") : Effect.void),
    );
  const checkedAt = yield* Ref.make(
    DateTime.formatIso(DateTime.makeUnsafe(input.readAtCall ? NOW : NOW - 3_600_000)),
  );
  const manualStarted = yield* Deferred.make<void>();
  const getSnapshot = Effect.all([Ref.get(checkedAt), Ref.get(account)]).pipe(
    Effect.map(([at, accountKey]) => ({
      usageLimits: { checkedAt: at, windows: [], ...(accountKey ? { accountKey } : {}) },
    })),
  );
  const layer = ResetCreditRedemption.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: () =>
            Effect.succeed({
              instanceId,
              driverKind: ProviderDriverKind.make("codex"),
              enabled: true,
              snapshot: {
                getSnapshot,
                refreshUsage: Effect.gen(function* () {
                  yield* step("read");
                  if (!input.staleRead) {
                    yield* Ref.set(checkedAt, DateTime.formatIso(yield* DateTime.now));
                  }
                }),
              },
              consumeResetCredit: (request?: { readonly attemptKey?: string }) =>
                Ref.update(requests, (current) => [...current, request]).pipe(
                  Effect.andThen(
                    request?.attemptKey === undefined
                      ? Effect.gen(function* () {
                          yield* step("manual-start");
                          yield* Deferred.succeed(manualStarted, undefined);
                          yield* Effect.sleep("1 minute");
                          yield* step("manual-done");
                          return { outcome: "reset" as const };
                        })
                      : step("auto").pipe(Effect.as({ outcome: "reset" as const })),
                  ),
                ),
            } as unknown as ProviderInstance),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({ liftUsageLimitHolds: () => Effect.void }),
      ),
    ),
  );
  return { log, step, requests, manualStarted, layer };
});

const autoClaim = { kind: "full", attemptKey: "banked-reset:account:codex:1" } as const;

it.effect("an automatic claim reads and decides only after a manual one on the account ends", () =>
  Effect.gen(function* () {
    const { log, step, manualStarted, layer } = yield* freshReadHarness({});
    yield* Effect.gen(function* () {
      const redemption = yield* ResetCreditRedemption.ResetCreditRedemption;
      const manual = yield* Effect.forkChild(redemption.redeem(instanceId));
      yield* Deferred.await(manualStarted);
      const auto = yield* Effect.forkChild(
        redemption.redeemOnFreshRead(instanceId, () => step("decide").pipe(Effect.as(autoClaim))),
      );
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(manual);
      assert.deepEqual(yield* Fiber.join(auto), Option.some({ outcome: "reset" }));
      assert.deepEqual(yield* Ref.get(log), [
        "manual-start",
        "manual-done",
        "read",
        "decide",
        "auto",
      ]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each([
  { name: "a reading from before the call", staleRead: true },
  { name: "a skipped read in the call's own millisecond", staleRead: true, readAtCall: true },
  { name: "a reading of another account", switchAt: "read" },
] as const)("claims nothing on $name", (harness) =>
  Effect.gen(function* () {
    const { log, step, layer } = yield* freshReadHarness(harness);
    yield* Effect.gen(function* () {
      const redemption = yield* ResetCreditRedemption.ResetCreditRedemption;
      const result = yield* redemption.redeemOnFreshRead(instanceId, () =>
        step("decide").pipe(Effect.as(autoClaim)),
      );
      assert.deepEqual(result, Option.none());
      assert.deepEqual(yield* Ref.get(log), ["read"]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each([
  { account: "account", spends: true },
  { account: null, spends: false },
] as const)(
  "a Use reset that waited spends only the account it waited for ($account)",
  ({ account, spends }) =>
    Effect.gen(function* () {
      const { requests, manualStarted, layer } = yield* freshReadHarness({
        account,
        switchAt: "manual-done",
      });
      yield* Effect.gen(function* () {
        const redemption = yield* ResetCreditRedemption.ResetCreditRedemption;
        const first = yield* Effect.forkChild(redemption.redeem(instanceId));
        yield* Deferred.await(manualStarted);
        const waiting = yield* Effect.forkChild(Effect.result(redemption.redeem(instanceId)));
        yield* TestClock.adjust("1 minute");
        yield* Fiber.join(first);
        yield* TestClock.adjust("1 minute");
        const second = yield* Fiber.join(waiting);
        assert.strictEqual(second._tag === "Success", spends);
        // The provider refuses a request for an account its login no longer holds.
        assert.deepEqual(
          yield* Ref.get(requests),
          spends ? [{ accountKey: account }, { accountKey: account }] : [undefined],
        );
      }).pipe(Effect.provide(layer));
    }),
);
