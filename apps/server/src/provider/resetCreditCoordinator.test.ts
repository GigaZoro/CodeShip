import { assert, describe, it } from "@effect/vitest";
import type { ProviderConsumeResetCreditOutcome } from "@t3tools/contracts/providerUsageLimits";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";

describe("ResetCreditCoordinator", () => {
  it.effect("re-sends the same idempotency key after a failed attempt, then clears it", () =>
    Effect.gen(function* () {
      const { redeem, redemptions } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const keys = yield* Ref.make<ReadonlyArray<string>>([]);
      const attempts = yield* Ref.make(0);
      const consume = (key: string) =>
        Effect.gen(function* () {
          yield* Ref.update(keys, (seen) => [...seen, key]);
          const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1);
          if (attempt === 1) return yield* Effect.fail("timed out" as const);
          return "reset" as const;
        });

      const first = yield* redeem("acct", consume).pipe(Effect.result);
      assert.isTrue(first._tag === "Failure");
      const second = yield* redeem("acct", consume);
      assert.strictEqual(second, "reset");
      yield* redeem("acct", consume);

      const seen = yield* Ref.get(keys);
      assert.strictEqual(seen.length, 3);
      assert.strictEqual(seen[0], seen[1]);
      assert.notStrictEqual(seen[1], seen[2]);
      // The failed attempt counts too: it may have used the credit.
      assert.strictEqual(yield* redemptions("acct"), 3);
      assert.strictEqual(yield* redemptions("acct-b"), 0);
    }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );

  it.effect("starts a fresh attempt after a settled failure", () =>
    Effect.gen(function* () {
      const { redeem } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const keys = yield* Ref.make<ReadonlyArray<string>>([]);
      const consume = (key: string) =>
        Ref.update(keys, (seen) => [...seen, key]).pipe(
          Effect.andThen(Effect.fail("cooldown" as const)),
        );
      const isSettled = (error: "cooldown") => error === "cooldown";

      yield* redeem("acct", consume, isSettled).pipe(Effect.result);
      yield* redeem("acct", consume, isSettled).pipe(Effect.result);

      const seen = yield* Ref.get(keys);
      assert.strictEqual(seen.length, 2);
      assert.notStrictEqual(seen[0], seen[1]);
    }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );

  it.effect("sends a fixed key as given and leaves the pending key alone", () =>
    Effect.gen(function* () {
      const { redeem } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const keys = yield* Ref.make<ReadonlyArray<string>>([]);
      const consume = (key: string) =>
        Ref.update(keys, (seen) => [...seen, key]).pipe(Effect.as("reset" as const));

      yield* redeem("acct", consume, undefined, "banked-reset:a:codex:1");
      yield* redeem("acct", consume, undefined, "banked-reset:a:codex:1");
      yield* redeem("acct", consume);

      const seen = yield* Ref.get(keys);
      assert.deepStrictEqual(seen.slice(0, 2), [
        "banked-reset:a:codex:1",
        "banked-reset:a:codex:1",
      ]);
      assert.notStrictEqual(seen[2], "banked-reset:a:codex:1");
    }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );

  it.effect("serialises concurrent redemptions on the same account, not per caller", () =>
    Effect.gen(function* () {
      const { redeem } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const release = yield* Deferred.make<void>();
      const inFlight = yield* Ref.make(0);
      const peak = yield* Ref.make(0);
      const consume = () =>
        Effect.gen(function* () {
          const now = yield* Ref.updateAndGet(inFlight, (n) => n + 1);
          yield* Ref.update(peak, (p) => Math.max(p, now));
          yield* Deferred.await(release);
          yield* Ref.update(inFlight, (n) => n - 1);
          return "reset" as const;
        });

      const a = yield* redeem("acct", consume).pipe(Effect.forkChild);
      const b = yield* redeem("acct", consume).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(a);
      yield* Fiber.join(b);

      assert.strictEqual(yield* Ref.get(peak), 1);
    }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );

  it.effect("runs work on an account after the redemption holding it, and on another at once", () =>
    Effect.gen(function* () {
      const { redeem, runLocked } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const order = yield* Ref.make<ReadonlyArray<string>>([]);
      const log = (event: string) => Ref.update(order, (seen) => [...seen, event]);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const redemption = yield* redeem("acct", () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(log("redeemed")),
          Effect.as("reset" as const),
        ),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);

      const read = yield* runLocked("acct", log("read")).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* runLocked("acct-b", log("other account"));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(redemption);
      yield* Fiber.join(read);
      assert.deepStrictEqual(yield* Ref.get(order), ["other account", "redeemed", "read"]);
    }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );

  it.effect("keeps different accounts independent", () =>
    Effect.gen(function* () {
      const { redeem } = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const release = yield* Deferred.make<void>();
      const peak = yield* Ref.make(0);
      const inFlight = yield* Ref.make(0);
      const consume = () =>
        Effect.gen(function* () {
          const now = yield* Ref.updateAndGet(inFlight, (n) => n + 1);
          yield* Ref.update(peak, (p) => Math.max(p, now));
          yield* Deferred.await(release);
          return "reset" as const;
        });
      const a = yield* redeem("acct-a", consume).pipe(Effect.forkChild);
      const b = yield* redeem("acct-b", consume).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(a);
      yield* Fiber.join(b);
      assert.strictEqual(yield* Ref.get(peak), 2);
    }).pipe(Effect.provide(ResetCreditCoordinator.layerTest)),
  );
});

describe("redeemThenReadUsage", () => {
  const WARNING =
    "The reset was applied, but Claude could not confirm the new limits. Refresh to check.";
  const redeemThenRead = (
    reads: Ref.Ref<number>,
    redeem: Effect.Effect<ProviderConsumeResetCreditOutcome, "nothing used" | "lost">,
    confirmed = true,
  ) =>
    ResetCreditCoordinator.redeemThenReadUsage({
      redeem,
      readUsage: Ref.update(reads, (count) => count + 1).pipe(
        Effect.andThen(Effect.forkChild(Effect.succeed(confirmed))),
      ),
      usedNothing: (error) => error === "nothing used",
      provider: "Claude",
    }).pipe(Effect.result);

  it.effect.each([
    ["a confirmed reset", "reset", true, { outcome: "reset" }],
    ["an unconfirmed reset", "reset", false, { outcome: "reset", warning: WARNING }],
    ["an unconfirmed other outcome", "noCredit", false, { outcome: "noCredit" }],
  ] as const)("reads usage after %s", ([, outcome, confirmed, expected]) =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      const result = yield* redeemThenRead(reads, Effect.succeed(outcome), confirmed);
      assert.deepStrictEqual(result, Result.succeed(expected));
      assert.strictEqual(yield* Ref.get(reads), 1);
    }),
  );

  it.effect.each([
    ["may have used a reset", "lost", 1],
    ["used nothing", "nothing used", 0],
  ] as const)(
    "fails as a redemption that %s did, reading usage only if it may have",
    ([, error, expectedReads]) =>
      Effect.gen(function* () {
        const reads = yield* Ref.make(0);
        const result = yield* redeemThenRead(reads, Effect.fail(error));
        assert.deepStrictEqual(result, Result.fail(error));
        assert.strictEqual(yield* Ref.get(reads), expectedReads);
      }),
  );

  it.effect("reads usage when the redemption is interrupted", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      const started = yield* Deferred.make<void>();
      const redemption = yield* redeemThenRead(
        reads,
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(redemption);
      assert.strictEqual(yield* Ref.get(reads), 1);
    }),
  );
});
