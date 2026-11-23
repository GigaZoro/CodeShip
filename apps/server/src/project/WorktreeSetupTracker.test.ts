import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as WorktreeSetupTracker from "./WorktreeSetupTracker.ts";

const threadId = ThreadId.make("thread-1");

describe("WorktreeSetupTracker", () => {
  it.effect("records stage transitions, checkout progress, and the final phase", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      const owner = yield* tracker.begin({
        threadId,
        branch: "feature",
        baseRef: "main",
        stages: ["checkout", "fetch", "agent"],
        fiber: null,
      });

      const initial = yield* tracker.get(threadId);
      expect(initial?.stages.map((stage) => stage.id)).toEqual(["fetch", "checkout", "agent"]);
      expect(initial?.phase).toBe("running");

      yield* tracker.stageStatus(owner, "fetch", "running");
      yield* tracker.stageStatus(owner, "fetch", "done", "origin/main at abc1234");
      yield* tracker.stageStatus(owner, "checkout", "running");
      yield* tracker.stage(owner, "checkout", { percent: 42, detail: "42 / 100 files" });
      yield* tracker.finish(owner, "failed", "boom");

      const final = yield* tracker.get(threadId);
      expect(final?.phase).toBe("failed");
      expect(final?.error).toBe("boom");
      const [fetch, checkout, agent] = final?.stages ?? [];
      expect(fetch).toMatchObject({ status: "done", detail: "origin/main at abc1234" });
      expect(fetch?.startedAt).not.toBeNull();
      expect(fetch?.endedAt).not.toBeNull();
      expect(checkout).toMatchObject({ status: "failed", percent: 42 });
      expect(agent?.status).toBe("pending");
      expect(final?.sequence).toBeGreaterThan(initial?.sequence ?? 0);
    }),
  );

  it.effect("stream emits the current snapshot first and then only newer ones", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      const owner = yield* tracker.begin({
        threadId,
        branch: null,
        baseRef: null,
        stages: ["agent"],
        fiber: null,
      });

      const collected = yield* tracker.stream(threadId).pipe(
        Stream.takeUntil((snapshot) => snapshot?.sequence === 2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* tracker.stageStatus(owner, "agent", "running");
      yield* tracker.appendTail(owner, "agent", "line 1");

      const snapshots = yield* Fiber.join(collected);
      const sequences = snapshots.map((snapshot) => snapshot?.sequence ?? -1);
      expect(sequences.at(-1)).toBe(2);
      expect(sequences).toEqual([...sequences].toSorted((a, b) => a - b));
      expect(snapshots.at(-1)?.stages[0]?.tail).toEqual(["line 1"]);
    }),
  );

  it.effect("a new setup on the same thread keeps sequences increasing", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      const owner = yield* tracker.begin({
        threadId,
        branch: "first",
        baseRef: null,
        stages: ["agent"],
        fiber: null,
      });
      yield* tracker.finish(owner, "failed", "boom");
      const failedSequence = (yield* tracker.get(threadId))?.sequence ?? -1;

      const collected = yield* tracker.stream(threadId).pipe(
        Stream.takeUntil((snapshot) => snapshot?.branch === "second"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* tracker.begin({
        threadId,
        branch: "second",
        baseRef: null,
        stages: ["agent"],
        fiber: null,
      });

      const snapshots = yield* Fiber.join(collected);
      const last = snapshots.at(-1);
      expect(last?.phase).toBe("running");
      expect(last?.sequence).toBeGreaterThan(failedSequence);
    }),
  );

  it.effect("late progress, completion and retention cannot touch a replacement setup", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      const input = {
        threadId,
        branch: "first",
        baseRef: null,
        stages: ["checkout"] as const,
        fiber: null,
      };
      const first = yield* tracker.begin(input);
      yield* tracker.finish(first, "done");
      yield* TestClock.adjust("20 seconds");
      const fiber = yield* Effect.forkChild(Effect.never);
      const second = yield* tracker.begin({ ...input, branch: "second", fiber });
      const initial = yield* tracker.get(threadId);
      yield* tracker.appendTail(first, "checkout", "late output");
      yield* tracker.markUncancellable(first);
      yield* tracker.finish(first, "failed", "late failure");
      yield* TestClock.adjust("11 seconds");
      expect(yield* tracker.get(threadId)).toEqual(initial);
      expect(yield* tracker.cancel(threadId)).toBe(true);
      yield* tracker.finish(second, "cancelled");
      const cancelled = yield* tracker.get(threadId);
      expect(cancelled?.phase).toBe("cancelled");
      yield* tracker.finish(second, "done");
      expect(yield* tracker.get(threadId)).toEqual(cancelled);
      yield* TestClock.adjust("30 seconds");
      expect(yield* tracker.get(threadId)).toBeNull();
    }),
  );

  it.effect("cancel interrupts the bootstrap fiber and reports whether one was running", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      const started = yield* Deferred.make<void>();
      const fiber = yield* Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      const owner = yield* tracker.begin({
        threadId,
        branch: null,
        baseRef: null,
        stages: ["agent"],
        fiber,
      });

      expect(yield* tracker.cancel(threadId)).toBe(true);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.hasInterrupts(exit)).toBe(true);

      yield* tracker.finish(owner, "cancelled");
      expect(yield* tracker.cancel(threadId)).toBe(false);
      expect(yield* tracker.cancel(ThreadId.make("unknown"))).toBe(false);
    }),
  );

  it.effect("markUncancellable makes a later cancel a no-op while the setup keeps running", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      const fiber = yield* Effect.forkChild(Effect.never);
      const owner = yield* tracker.begin({
        threadId,
        branch: null,
        baseRef: null,
        stages: ["agent"],
        fiber,
      });

      yield* tracker.markUncancellable(owner);
      expect(yield* tracker.cancel(threadId)).toBe(false);
      expect((yield* tracker.get(threadId))?.phase).toBe("running");
      yield* Fiber.interrupt(fiber);
    }),
  );
});
