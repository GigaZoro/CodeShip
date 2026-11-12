import type {
  OrchestrationV2RestartHold,
  OrchestrationV2RestartHoldWork,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

// Servers that predate hold ids name the work by its kind and label.
const restartHoldWorkKey = (work: OrchestrationV2RestartHoldWork): string =>
  `${work.threadId}\u0000${work.id ?? `${work.kind}\u0000${work.label}`}`;

interface ListedRestartHoldWork {
  /** Work the update has waited on. A call that outlives its turn stays listed as background work. */
  readonly keys: ReadonlySet<string>;
  /** Chats whose turn was running calls when the wait began and has not been seen without one. */
  readonly callingThreads: ReadonlySet<string>;
}

/**
 * "clear" once the first hold's work has ended and each chat then running tool calls was seen
 * running none, so calls it queued meanwhile are not cut. Other later work does not extend the
 * wait. Every manual update that waits on a restart hold shares this rule.
 */
export function untilListedRestartHoldWorkEnds<E, R>(
  holds: Stream.Stream<OrchestrationV2RestartHold, E, R>,
  onWaiting: (work: ReadonlyArray<OrchestrationV2RestartHoldWork>) => Effect.Effect<void>,
): Stream.Stream<"clear", E, R> {
  return holds.pipe(
    Stream.mapAccum(
      (): ListedRestartHoldWork | null => null,
      (listed, hold) => {
        const calling = new Set<string>(
          hold.work.flatMap((work) => (work.turnCall === true ? [work.threadId] : [])),
        );
        const callingThreads =
          listed === null
            ? calling
            : new Set([...listed.callingThreads].filter((threadId) => calling.has(threadId)));
        const waiting =
          listed === null
            ? hold.work
            : hold.work.filter(
                (work) =>
                  listed.keys.has(restartHoldWorkKey(work)) ||
                  (work.turnCall === true && callingThreads.has(work.threadId)),
              );
        const keys = new Set(listed?.keys);
        for (const work of waiting) keys.add(restartHoldWorkKey(work));
        return [{ keys, callingThreads }, [waiting]] as const;
      },
    ),
    Stream.tap((work) => (work.length === 0 ? Effect.void : onWaiting(work))),
    Stream.filter((work) => work.length === 0),
    Stream.as("clear" as const),
  );
}

/** Whether a restart would cut nothing a chat is doing: no background work and no running turn. */
export function isRestartHoldEmpty(hold: OrchestrationV2RestartHold): boolean {
  return hold.work.length === 0 && (hold.runningTurns?.length ?? 0) === 0;
}

/**
 * "clear" once a hold lists no work and no running turn, including any that started while waiting.
 * An automatic update waits like this, since nobody chose to cut what a chat is doing. `onWaiting`
 * gets each hold that still lists some.
 */
export function untilRestartHoldIsEmpty<E, R>(
  holds: Stream.Stream<OrchestrationV2RestartHold, E, R>,
  onWaiting: (hold: OrchestrationV2RestartHold) => Effect.Effect<void>,
): Stream.Stream<"clear", E, R> {
  return holds.pipe(
    Stream.tap((hold) => (isRestartHoldEmpty(hold) ? Effect.void : onWaiting(hold))),
    Stream.filter(isRestartHoldEmpty),
    Stream.as("clear" as const),
  );
}
