import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as PtyAdapter from "./PtyAdapter.ts";

const INPUT: PtyAdapter.PtySpawnInput = { shell: "fake", cwd: "/", cols: 80, rows: 24, env: {} };
const LISTENERS: PtyAdapter.PtyListeners = { onData: () => {}, onExit: () => {} };

/** A process that exists before `spawn` returns, like a real one whose start is still settling. */
const makeFake = (options: { readonly killFails?: boolean } = {}) =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const state = { kills: 0, listeners: 0 };
    const process: PtyAdapter.PtyProcess = {
      pid: 1,
      write: () => {},
      resize: () => {},
      kill: () => {
        state.kills += 1;
        if (options.killFails) throw new Error("already gone");
      },
      onData: () => (state.listeners++, () => void state.listeners--),
      onExit: () => (state.listeners++, () => void state.listeners--),
    };
    const adapter: PtyAdapter.PtyAdapter["Service"] = {
      spawn: () =>
        Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(process),
        ),
    };
    return { adapter, reached, release, state };
  });

describe("spawnScoped", () => {
  it.effect("stops a process whose start was interrupted", () =>
    Effect.gen(function* () {
      const fake = yield* makeFake();
      const run = yield* Effect.scoped(
        PtyAdapter.spawnScoped(fake.adapter, INPUT, LISTENERS).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(fake.reached);
      // Delivered now, while the start waits; a forked `Fiber.interrupt` would land after it.
      run.interruptUnsafe();
      yield* Deferred.succeed(fake.release, undefined);
      yield* Fiber.await(run);

      assert.deepStrictEqual(fake.state, { kills: 1, listeners: 0 });
    }),
  );

  it.effect("ends the scope even when the process cannot be stopped", () =>
    Effect.gen(function* () {
      const fake = yield* makeFake({ killFails: true });
      yield* Deferred.succeed(fake.release, undefined);
      yield* Effect.scoped(PtyAdapter.spawnScoped(fake.adapter, INPUT, LISTENERS));

      assert.deepStrictEqual(fake.state, { kills: 1, listeners: 0 });
    }),
  );
});
