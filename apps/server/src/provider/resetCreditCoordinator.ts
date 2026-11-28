/** Instances sharing a login directory share credits; serialize redemptions and reads on it. */
import type { ProviderConsumeResetCreditOutcome } from "@t3tools/contracts/providerUsageLimits";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

interface AccountRedemptionState {
  readonly lock: Semaphore.Semaphore;
  readonly pendingKey: Ref.Ref<string | null>;
  readonly redemptions: Ref.Ref<number>;
}

export class ResetCreditCoordinator extends Context.Service<
  ResetCreditCoordinator,
  {
    /**
     * Reuse the idempotency key until an outcome or settled failure; timeouts keep it for retry.
     * A `fixedKey` names one run-out for every redeemer of the account, so it replaces that key.
     */
    readonly redeem: <E, R>(
      accountKey: string,
      consume: (idempotencyKey: string) => Effect.Effect<ProviderConsumeResetCreditOutcome, E, R>,
      isSettled?: (error: E) => boolean,
      fixedKey?: string,
    ) => Effect.Effect<ProviderConsumeResetCreditOutcome, E | PlatformError.PlatformError, R>;
    /** Runs `effect` under the same lock, after any redemption or other run holding it. */
    readonly runLocked: <A, E, R>(
      accountKey: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /** Redemptions ended on the account, however they ended, so a reading can tell it predates one. */
    readonly redemptions: (accountKey: string) => Effect.Effect<number>;
  }
>()("t3/provider/resetCreditCoordinator") {}

/** @public */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const statesRef = yield* Ref.make<ReadonlyMap<string, AccountRedemptionState>>(new Map());

  // Create account locks atomically so concurrent first redemptions cannot use separate locks.
  const stateFor = Effect.fn("ResetCreditCoordinator.stateFor")(function* (accountKey: string) {
    const existing = (yield* Ref.get(statesRef)).get(accountKey);
    if (existing) return existing;
    const candidate = {
      lock: yield* Semaphore.make(1),
      pendingKey: yield* Ref.make<string | null>(null),
      redemptions: yield* Ref.make(0),
    };
    return yield* Ref.modify(statesRef, (states) => {
      const current = states.get(accountKey);
      if (current) return [current, states] as const;
      const next = new Map(states);
      next.set(accountKey, candidate);
      return [candidate, next] as const;
    });
  });

  const redeem: ResetCreditCoordinator["Service"]["redeem"] = Effect.fn(
    "resetCreditCoordinator.redeem",
  )(function* (accountKey, consume, isSettled, fixedKey) {
    const state = yield* stateFor(accountKey);
    return yield* state.lock.withPermits(1)(
      Effect.gen(function* () {
        if (fixedKey !== undefined) return yield* consume(fixedKey);
        const existing = yield* Ref.get(state.pendingKey);
        const idempotencyKey = existing ?? (yield* crypto.randomUUIDv4());
        yield* Ref.set(state.pendingKey, idempotencyKey);
        const outcome = yield* consume(idempotencyKey).pipe(
          Effect.tapError((error) =>
            isSettled?.(error) ? Ref.set(state.pendingKey, null) : Effect.void,
          ),
        );
        yield* Ref.set(state.pendingKey, null);
        return outcome;
      }).pipe(Effect.ensuring(Ref.update(state.redemptions, (count) => count + 1))),
    );
  });

  const runLocked: ResetCreditCoordinator["Service"]["runLocked"] = (accountKey, effect) =>
    Effect.flatMap(stateFor(accountKey), (state) => state.lock.withPermits(1)(effect));

  const redemptions: ResetCreditCoordinator["Service"]["redemptions"] = (accountKey) =>
    Effect.flatMap(stateFor(accountKey), (state) => Ref.get(state.redemptions));

  return { redeem, runLocked, redemptions } satisfies ResetCreditCoordinator["Service"];
});

/**
 * Runs `redeem`, then reads usage, which alone confirms a reset: also after a failure or an
 * interrupt that may have used it, unless `usedNothing` says it did not. An unconfirmed reset
 * still succeeds, with a warning.
 */
export const redeemThenReadUsage = Effect.fn("redeemThenReadUsage")(function* <E, R>(input: {
  readonly redeem: Effect.Effect<ProviderConsumeResetCreditOutcome, E, R>;
  /** Starts the read; it outlives a caller that stops waiting for it. */
  readonly readUsage: Effect.Effect<Fiber.Fiber<boolean>>;
  readonly usedNothing?: (error: E) => boolean;
  readonly provider: string;
}) {
  // Masked so an interrupt cannot land between the redemption ending and the read starting.
  const { redeemed, usageRead } = yield* Effect.uninterruptibleMask((restore) =>
    restore(input.redeem).pipe(
      Effect.onInterrupt(() => Effect.asVoid(input.readUsage)),
      Effect.result,
      Effect.flatMap((redeemed) => {
        const usedNothing =
          Result.isFailure(redeemed) && input.usedNothing?.(redeemed.failure) === true;
        const startRead: Effect.Effect<Option.Option<Fiber.Fiber<boolean>>> = usedNothing
          ? Effect.succeedNone
          : Effect.asSome(input.readUsage);
        return Effect.map(startRead, (usageRead) => ({ redeemed, usageRead }));
      }),
    ),
  );
  const confirmed = Option.isNone(usageRead) || (yield* Fiber.join(usageRead.value));
  const outcome = yield* Effect.fromResult(redeemed);
  return outcome === "reset" && !confirmed
    ? {
        outcome,
        warning: `The reset was applied, but ${input.provider} could not confirm the new limits. Refresh to check.`,
      }
    : { outcome };
});

export const layer = Layer.effect(ResetCreditCoordinator, make);

export const layerTest = Layer.effect(
  ResetCreditCoordinator,
  Effect.gen(function* () {
    let counter = 0;
    return yield* make.pipe(
      Effect.provideService(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => {
            counter += 1;
            return new Uint8Array(size).fill(counter);
          },
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    );
  }),
);
