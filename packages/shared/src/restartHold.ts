import type {
  OrchestrationV2RestartHold,
  OrchestrationV2RestartHoldWork,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

// Servers that predate hold ids name the work by its kind and label.
const restartHoldWorkKey = (work: OrchestrationV2RestartHoldWork): string =>
  `${work.threadId}\u0000${work.id ?? `${work.kind}\u0000${work.label}`}`;

/**
 * "clear" once the work in the first hold has ended. Work that starts later does not extend the
 * wait; the restart stops it, and its chat restarts it. `onWaiting` gets the listed work left.
 * Every update that waits on a restart hold, whoever starts it, shares this rule.
 */
export function untilListedRestartHoldWorkEnds<E, R>(
  holds: Stream.Stream<OrchestrationV2RestartHold, E, R>,
  onWaiting: (work: ReadonlyArray<OrchestrationV2RestartHoldWork>) => Effect.Effect<void>,
): Stream.Stream<"clear", E, R> {
  return holds.pipe(
    Stream.mapAccum(
      (): ReadonlySet<string> | null => null,
      (listed, hold) => {
        const keys = listed ?? new Set(hold.work.map(restartHoldWorkKey));
        return [keys, [hold.work.filter((work) => keys.has(restartHoldWorkKey(work)))]] as const;
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
