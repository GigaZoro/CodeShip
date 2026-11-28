import { it } from "@effect/vitest";
import type { DesktopBrowserCommand, DesktopBrowserEvent } from "@t3tools/contracts/desktopBrowser";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import { DesktopBrowserChannel, layerFromPipes } from "./DesktopBrowserChannel.ts";

const tab = (tabId: string) => ({ threadId: "thread-1", tabId });

const connect = (options: { readonly writesWaitFor?: Deferred.Deferred<void> } = {}) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const written = yield* Queue.unbounded<DesktopBrowserCommand>();
    const context = yield* Layer.build(
      layerFromPipes({
        events: Stream.fromQueue(events),
        write: (line) =>
          (options.writesWaitFor ? Deferred.await(options.writesWaitFor) : Effect.void).pipe(
            Effect.andThen(Queue.offer(written, JSON.parse(line) as DesktopBrowserCommand)),
          ),
      }),
    );
    const channel = Context.get(context, DesktopBrowserChannel);
    return {
      channel,
      // Started at once, so the wait has subscribed and armed its deadline when this returns.
      startWait: (tabId: string) =>
        Effect.forkChild(channel.awaitAttached(tab(tabId), "60 seconds"), {
          startImmediately: true,
        }),
      send: (event: DesktopBrowserEvent) =>
        Queue.offer(events, new TextEncoder().encode(`${JSON.stringify(event)}\n`)),
      closePipe: Queue.end(events),
      takeWrites: (count: number) =>
        Effect.gen(function* () {
          const writes: DesktopBrowserCommand[] = [];
          for (let index = 0; index < count; index++) writes.push(yield* Queue.take(written));
          return writes;
        }),
      written,
    };
  });

const awaitingWrites = (writes: ReadonlyArray<DesktopBrowserCommand>, tabId: string) =>
  writes.filter((write) => write.type === "awaiting" && write.tabId === tabId);

const heldThenReleased = (tabId: string) => [
  { type: "awaiting", ...tab(tabId), active: true },
  { type: "awaiting", ...tab(tabId), active: false },
];

describe("DesktopBrowserChannel", () => {
  it.effect("a closed event pipe declines waits and detaches its tabs", () =>
    Effect.gen(function* () {
      const { channel, startWait, send, closePipe, takeWrites, written } = yield* connect();
      const shown = yield* startWait("shown");
      yield* send({ type: "attached", ...tab("shown") });
      expect(yield* Fiber.join(shown)).toBe("attached");
      const pending = yield* startWait("pending");

      yield* closePipe;

      expect(yield* Fiber.join(pending)).toBe("declined");
      expect(yield* channel.isAttached(tab("shown"))).toBe(false);
      expect(yield* channel.awaitAttached(tab("later"), "60 seconds")).toBe("declined");
      const writes = yield* takeWrites(4);
      expect(awaitingWrites(writes, "shown")).toEqual(heldThenReleased("shown"));
      expect(awaitingWrites(writes, "pending")).toEqual(heldThenReleased("pending"));
      expect(yield* Queue.size(written)).toBe(0);
    }),
  );

  it.effect("a stalled control pipe neither delays a wait nor reorders its awaiting writes", () =>
    Effect.gen(function* () {
      const pipeDrains = yield* Deferred.make<void>();
      const { startWait, send, takeWrites } = yield* connect({ writesWaitFor: pipeDrains });

      const unanswered = yield* startWait("unanswered");
      yield* TestClock.adjust("60 seconds");
      expect(yield* Fiber.join(unanswered)).toBe("timedOut");
      const answered = yield* startWait("answered");
      yield* send({ type: "attached", ...tab("answered") });
      expect(yield* Fiber.join(answered)).toBe("attached");

      yield* Deferred.succeed(pipeDrains, undefined);
      const writes = yield* takeWrites(4);
      expect(awaitingWrites(writes, "unanswered")).toEqual(heldThenReleased("unanswered"));
      expect(awaitingWrites(writes, "answered")).toEqual(heldThenReleased("answered"));
    }),
  );
});
