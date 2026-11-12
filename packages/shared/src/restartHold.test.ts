import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { untilListedRestartHoldWorkEnds, untilRestartHoldIsEmpty } from "./restartHold.ts";

const work = (id: string | undefined, label: string) => ({
  threadId: ThreadId.make("thread-1"),
  threadTitle: "Coordinator",
  kind: "subagent" as const,
  label,
  ...(id === undefined ? {} : { id }),
});

describe("update waits for background work", () => {
  it.effect("goes once the work listed at the start ends, even with newer work running", () =>
    Effect.gen(function* () {
      const waitedOn: Array<ReadonlyArray<string>> = [];
      const outcome = yield* untilListedRestartHoldWorkEnds(
        Stream.make(
          { work: [work("a", "Review A"), work(undefined, "Legacy C")] },
          // A relabel keeps its id; B started after the wait did.
          {
            work: [
              work("a", "Review A, round 2"),
              work("b", "Review B"),
              work(undefined, "Legacy C"),
            ],
          },
          { work: [work("b", "Review B"), work(undefined, "Legacy C")] },
          { work: [work("b", "Review B")] },
          { work: [work("b", "Review B")] },
        ),
        (remaining) => Effect.sync(() => waitedOn.push(remaining.map((entry) => entry.label))),
      ).pipe(Stream.runHead);
      expect(Option.getOrNull(outcome)).toBe("clear");
      expect(waitedOn).toEqual([
        ["Review A", "Legacy C"],
        ["Review A, round 2", "Legacy C"],
        ["Legacy C"],
      ]);
    }),
  );

  it.effect("waits until a chat runs no tool call, then not for its next round", () =>
    Effect.gen(function* () {
      const waitedOn: Array<ReadonlyArray<string>> = [];
      const call = (threadId: string, id: string) => ({
        ...work(id, id),
        threadId: ThreadId.make(threadId),
        turnCall: true as const,
      });
      const outcome = yield* untilListedRestartHoldWorkEnds(
        Stream.make(
          { work: [call("thread-1", "Agent A"), call("thread-1", "Edit 1")] },
          // Started before the running calls ended: the restart would cut it too.
          { work: [call("thread-1", "Agent A"), call("thread-1", "Agent B")] },
          { work: [call("thread-1", "Agent B"), call("thread-2", "Bash")] },
          { work: [call("thread-2", "Bash")] },
          // The chat's next round, after it was seen with no call running.
          { work: [call("thread-2", "Bash"), call("thread-1", "Edit 2")] },
          { work: [call("thread-1", "Edit 2")] },
        ),
        (remaining) => Effect.sync(() => waitedOn.push(remaining.map((entry) => entry.label))),
      ).pipe(Stream.runHead);
      expect(Option.getOrNull(outcome)).toBe("clear");
      expect(waitedOn).toEqual([["Agent A", "Edit 1"], ["Agent A", "Agent B"], ["Agent B"]]);
    }),
  );

  it.effect(
    "keeps waiting on a call while it moves between a chat's calls and its background",
    () =>
      Effect.gen(function* () {
        const waitedOn: Array<ReadonlyArray<string>> = [];
        const background = (threadId: string, id: string) => ({
          ...work(id, id),
          threadId: ThreadId.make(threadId),
        });
        const call = (threadId: string, id: string) => ({
          ...background(threadId, id),
          turnCall: true as const,
        });
        const outcome = yield* untilListedRestartHoldWorkEnds(
          Stream.make(
            // Chat 2 waits on an approval, so its running subagent is listed as background work.
            { work: [call("thread-1", "Agent A"), background("thread-2", "Agent X")] },
            {
              work: [
                call("thread-1", "Agent A"),
                call("thread-2", "Agent X"),
                call("thread-2", "Edit"),
              ],
            },
            // Chat 1's turn ends while its subagent still runs.
            { work: [background("thread-1", "Agent A"), call("thread-2", "Agent X")] },
            { work: [background("thread-1", "Agent A")] },
            { work: [] },
          ),
          (remaining) => Effect.sync(() => waitedOn.push(remaining.map((entry) => entry.label))),
        ).pipe(Stream.runHead);
        expect(Option.getOrNull(outcome)).toBe("clear");
        expect(waitedOn).toEqual([
          ["Agent A", "Agent X"],
          ["Agent A", "Agent X"],
          ["Agent A", "Agent X"],
          ["Agent A"],
        ]);
      }),
  );

  it.effect(
    "an automatic update goes only once no work is left and no chat answers, newer included",
    () =>
      Effect.gen(function* () {
        const waitedOn: Array<ReadonlyArray<string>> = [];
        const answering = [{ threadId: ThreadId.make("thread-2"), threadTitle: "Answering" }];
        const holds = [
          { work: [work("a", "Review A")] },
          { work: [work("a", "Review A"), work("b", "Review B")] },
          { work: [work("b", "Review B")], runningTurns: answering },
          { work: [], runningTurns: answering },
          { work: [], runningTurns: [] },
        ];
        const outcome = yield* untilRestartHoldIsEmpty(Stream.fromIterable(holds), (hold) =>
          Effect.sync(() =>
            waitedOn.push([
              ...hold.work.map((entry) => entry.label),
              ...(hold.runningTurns ?? []).map((turn) => turn.threadTitle),
            ]),
          ),
        ).pipe(Stream.runHead);
        expect(Option.getOrNull(outcome)).toBe("clear");
        expect(waitedOn).toEqual([
          ["Review A"],
          ["Review A", "Review B"],
          ["Review B", "Answering"],
          ["Answering"],
        ]);
      }),
  );
});
