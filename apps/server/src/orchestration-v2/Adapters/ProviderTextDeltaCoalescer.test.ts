import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaUpdate,
} from "./ProviderTextDeltaCoalescer.ts";

const makeRecordingCoalescer = Effect.gen(function* () {
  const updates: Array<ProviderTextDeltaUpdate> = [];
  const coalescer = yield* makeProviderTextDeltaCoalescer({
    flushIntervalMs: 1_000,
    emit: (update) =>
      Effect.sync(() => {
        updates.push(update);
      }),
  });
  return { updates, coalescer };
});

describe("ProviderTextDeltaCoalescer", () => {
  it.effect("extends text a taken-over turn already persisted instead of replacing it", () =>
    Effect.gen(function* () {
      const { updates, coalescer } = yield* makeRecordingCoalescer;
      yield* coalescer.seed({ turnId: "turn-1", itemId: "item-1", text: "Persisted " });
      yield* coalescer.append({ turnId: "turn-1", itemId: "item-1", delta: "and new" });
      yield* coalescer.flush;
      assert.deepEqual(updates, [
        { turnId: "turn-1", itemId: "item-1", text: "Persisted and new", completed: false },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("emits buffered text on flush and keeps the item open", () =>
    Effect.gen(function* () {
      const { updates, coalescer } = yield* makeRecordingCoalescer;
      yield* coalescer.append({ turnId: "turn-1", itemId: "item-1", delta: "Hel" });
      yield* coalescer.flush;
      yield* coalescer.flush;
      yield* coalescer.append({ turnId: "turn-1", itemId: "item-1", delta: "lo" });
      const text = yield* coalescer.complete({ turnId: "turn-1", itemId: "item-1" });
      assert.equal(text, "Hello");
      assert.deepEqual(updates, [
        { turnId: "turn-1", itemId: "item-1", text: "Hel", completed: false },
        { turnId: "turn-1", itemId: "item-1", text: "Hello", completed: true },
      ]);
    }).pipe(Effect.scoped),
  );
});
