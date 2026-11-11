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

  it.effect("an automatic update goes only once no work is left, newer work included", () =>
    Effect.gen(function* () {
      const waitedOn: Array<ReadonlyArray<string>> = [];
      const holds = [
        { work: [work("a", "Review A")] },
        { work: [work("a", "Review A"), work("b", "Review B")] },
        { work: [work("b", "Review B")] },
        { work: [] },
      ];
      const outcome = yield* untilRestartHoldIsEmpty(Stream.fromIterable(holds), (remaining) =>
        Effect.sync(() => waitedOn.push(remaining.map((entry) => entry.label))),
      ).pipe(Stream.runHead);
      expect(Option.getOrNull(outcome)).toBe("clear");
      expect(waitedOn).toEqual([["Review A"], ["Review A", "Review B"], ["Review B"]]);
    }),
  );
});
