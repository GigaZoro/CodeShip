import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  drainUntilClosed,
  holdInBackgroundRef,
  isDraining,
  tryAdmitStart,
  UpdateDrain,
  watchDraining,
  whileDraining,
} from "./updateDrain.ts";

describe("update drain barrier", () => {
  it.effect("keeps overlapping drain holders active until all release", () =>
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make({ holders: 0, admitting: 0 });
      const drainLayer = Layer.succeed(UpdateDrain, ref);

      expect(yield* isDraining().pipe(Effect.provide(drainLayer))).toBe(false);

      const scope1 = yield* Scope.make();
      yield* drainUntilClosed.pipe(Scope.provide(scope1), Effect.provide(drainLayer));
      expect(yield* isDraining().pipe(Effect.provide(drainLayer))).toBe(true);

      const scope2 = yield* Scope.make();
      yield* drainUntilClosed.pipe(Scope.provide(scope2), Effect.provide(drainLayer));
      expect(yield* isDraining().pipe(Effect.provide(drainLayer))).toBe(true);

      yield* Scope.close(scope1, Exit.void);
      expect(yield* isDraining().pipe(Effect.provide(drainLayer))).toBe(true);

      yield* Scope.close(scope2, Exit.void);
      expect(yield* isDraining().pipe(Effect.provide(drainLayer))).toBe(false);
    }),
  );

  it.effect("streams draining transitions reactively and deduplicates overlapping holders", () =>
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make({ holders: 0, admitting: 0 });
      const drainLayer = Layer.succeed(UpdateDrain, ref);
      const events = yield* Queue.unbounded<boolean>();

      const fiber = yield* watchDraining.pipe(
        Stream.tap((value) => Queue.offer(events, value)),
        Stream.runDrain,
        Effect.provide(drainLayer),
        Effect.forkChild,
      );

      expect(yield* Queue.take(events)).toBe(false);

      const scope1 = yield* Scope.make();
      yield* drainUntilClosed.pipe(Scope.provide(scope1), Effect.provide(drainLayer));
      expect(yield* Queue.take(events)).toBe(true);

      const scope2 = yield* Scope.make();
      yield* drainUntilClosed.pipe(Scope.provide(scope2), Effect.provide(drainLayer));

      yield* Scope.close(scope1, Exit.void);
      expect(yield* Queue.size(events)).toBe(0);

      yield* Scope.close(scope2, Exit.void);
      expect(yield* Queue.take(events)).toBe(false);

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect(
    "releases whileDraining on success, failure, and interruption and blocks tryAdmitStart",
    () =>
      Effect.gen(function* () {
        const ref = yield* SubscriptionRef.make({ holders: 0, admitting: 0 });
        const drainLayer = Layer.succeed(UpdateDrain, ref);

        const value = yield* whileDraining(
          Effect.gen(function* () {
            expect(yield* isDraining()).toBe(true);
            expect(yield* Effect.scoped(tryAdmitStart)).toBe(false);
            return "done";
          }),
        ).pipe(Effect.provide(drainLayer));
        expect(value).toBe("done");
        expect(yield* isDraining().pipe(Effect.provide(drainLayer))).toBe(false);

        const failed = yield* whileDraining(Effect.fail("boom")).pipe(
          Effect.provide(drainLayer),
          Effect.flip,
        );
        expect(failed).toBe("boom");
        expect(yield* isDraining().pipe(Effect.provide(drainLayer))).toBe(false);

        const entered = yield* Deferred.make<void>();
        const fiber = yield* whileDraining(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        ).pipe(Effect.provide(drainLayer), Effect.forkChild);
        yield* Deferred.await(entered);
        expect(yield* isDraining().pipe(Effect.provide(drainLayer))).toBe(true);
        yield* Fiber.interrupt(fiber);
        expect(yield* isDraining().pipe(Effect.provide(drainLayer))).toBe(false);
      }),
  );

  it.effect(
    "holdInBackgroundRef acquires immediately, bridges closing outer drains, and releases on expiry or scope close",
    () =>
      Effect.gen(function* () {
        const ref = yield* SubscriptionRef.make({ holders: 0, admitting: 0 });
        const drainLayer = Layer.succeed(UpdateDrain, ref);
        const outerScope = yield* Scope.make();
        const serviceScope = yield* Scope.make();
        let expired = 0;

        yield* drainUntilClosed.pipe(Scope.provide(outerScope), Effect.provide(drainLayer));
        expect((yield* SubscriptionRef.get(ref)).holders).toBe(1);

        yield* holdInBackgroundRef(
          ref,
          serviceScope,
          "5 minutes",
          Effect.sync(() => {
            expired += 1;
          }),
        ).pipe(Effect.asVoid);
        expect((yield* SubscriptionRef.get(ref)).holders).toBe(2);

        // Closing the outer client drain must not drop holders to 0.
        yield* Scope.close(outerScope, Exit.void);
        expect((yield* SubscriptionRef.get(ref)).holders).toBe(1);
        expect(yield* isDraining().pipe(Effect.provide(drainLayer))).toBe(true);

        // Expiry releases the background holder and invokes onExpired.
        yield* TestClock.adjust("5 minutes");
        expect(expired).toBe(1);
        expect((yield* SubscriptionRef.get(ref)).holders).toBe(0);
        expect(yield* isDraining().pipe(Effect.provide(drainLayer))).toBe(false);

        // Calling the returned release handle drops the holder immediately and suppresses expiry.
        const releaseExplicit = yield* holdInBackgroundRef(
          ref,
          serviceScope,
          "5 minutes",
          Effect.sync(() => {
            expired += 1;
          }),
        );
        expect((yield* SubscriptionRef.get(ref)).holders).toBe(1);
        yield* releaseExplicit;
        expect((yield* SubscriptionRef.get(ref)).holders).toBe(0);
        yield* TestClock.adjust("5 minutes");
        expect(expired).toBe(1);

        // Closing the owning service scope releases an active background holder early.
        yield* holdInBackgroundRef(ref, serviceScope, "5 minutes").pipe(Effect.asVoid);
        expect((yield* SubscriptionRef.get(ref)).holders).toBe(1);
        yield* Scope.close(serviceScope, Exit.void);
        expect((yield* SubscriptionRef.get(ref)).holders).toBe(0);
      }),
  );
});
