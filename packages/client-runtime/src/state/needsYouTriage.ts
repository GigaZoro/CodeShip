import { shouldNotifyThread } from "@t3tools/shared/threadNotifications";

import type { EnvironmentThreadShell } from "./models.ts";
import { effectiveSnoozed, type ThreadSnoozeShell } from "./threadSettled.ts";
import {
  hasUnseenCompletion,
  resolveThreadStatus,
  type ThreadStatusInput,
} from "./threadStatus.ts";
import { toSortableTimestamp } from "./threadSort.ts";

/** How long the user must be gone before the box shows what changed while they were away. */
export const WHILE_AWAY_MIN_MS = 15 * 60_000;

/**
 * The app icon, dock, and taskbar count. Only what Needs you lists counts: finished results the
 * user has not seen, and failures in threads agents started (scheduled runs included), never do.
 */
export function countNeedsYouBadge(
  needsYou: readonly Pick<EnvironmentThreadShell, "notificationLevel">[],
): number {
  return needsYou.filter((thread) => shouldNotifyThread(true, thread.notificationLevel, "input"))
    .length;
}

export type FinishedNotSeenInput = ThreadStatusInput &
  ThreadSnoozeShell &
  Pick<
    EnvironmentThreadShell,
    "id" | "environmentId" | "createdBy" | "archivedAt" | "deletedAt" | "settledOverride"
  > & {
    readonly latestRun: Pick<
      NonNullable<EnvironmentThreadShell["latestRun"]>,
      "status" | "completedAt"
    > | null;
    readonly lastVisitedAt?: string | null | undefined;
  };

/**
 * Threads the user started whose last turn finished after they last looked, newest first.
 * They wait on nobody, so they never join Needs you or its badge. `locallyUnread` covers
 * servers too old to record visits, which only the client tracks.
 */
export function collectFinishedNotSeen<T extends FinishedNotSeenInput>(
  threads: readonly T[],
  options: { readonly now: string; readonly locallyUnread?: (thread: T) => boolean },
): T[] {
  const finished = threads.filter(
    (thread) =>
      thread.createdBy === "user" &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.settledOverride !== "settled" &&
      resolveThreadStatus(thread) === "ready" &&
      !effectiveSnoozed(thread, options) &&
      (hasUnseenCompletion(thread) ||
        (thread.lastVisitedAt === undefined && options.locallyUnread?.(thread) === true)),
  );
  const completedAt = (thread: T) =>
    toSortableTimestamp(thread.latestRun?.completedAt ?? undefined) ?? 0;
  return finished.sort(
    (left, right) =>
      completedAt(right) - completedAt(left) ||
      left.id.localeCompare(right.id) ||
      left.environmentId.localeCompare(right.environmentId),
  );
}

export interface WhileAwaySummary {
  /** What waits on the user now. */
  readonly blocked: number;
  /** Finished, not seen, and finished after the user left. */
  readonly finished: number;
  /** Threads the user started that hit a usage limit and continued by themselves while away. */
  readonly recovered: number;
}

type WhileAwayInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdBy" | "archivedAt" | "deletedAt" | "limitRecovery"
> & {
  readonly latestRun: Pick<
    NonNullable<EnvironmentThreadShell["latestRun"]>,
    "runId" | "requestedAt" | "completedAt"
  > | null;
};

const keyOf = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
  `${thread.environmentId}:${thread.id}`;

/**
 * What changed since the user left at `awaySince` (epoch ms). A limited run that resumed by
 * itself counts once, as recovered, even when it has finished since.
 */
export function summarizeWhileAway<T extends WhileAwayInput>(input: {
  readonly threads: readonly T[];
  readonly needsYou: readonly unknown[];
  readonly finishedNotSeen: readonly T[];
  readonly awaySince: number;
}): WhileAwaySummary {
  const recovered = new Set<string>();
  for (const thread of input.threads) {
    const recovery = thread.limitRecovery;
    const run = thread.latestRun;
    if (
      thread.createdBy === "user" &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      recovery != null &&
      run !== null &&
      run.runId !== recovery.runId &&
      (toSortableTimestamp(run.requestedAt ?? undefined) ?? 0) >= input.awaySince
    ) {
      recovered.add(keyOf(thread));
    }
  }
  const finished = input.finishedNotSeen.filter(
    (thread) =>
      !recovered.has(keyOf(thread)) &&
      (toSortableTimestamp(thread.latestRun?.completedAt ?? undefined) ?? 0) >= input.awaySince,
  ).length;
  return { blocked: input.needsYou.length, finished, recovered: recovered.size };
}

/**
 * Tracks when the user was last present, so the box can say what changed while they were
 * away. Input and the window coming back count as presence; hiding the window marks when the
 * user left. The times are wall-clock because they span sleep and restarts and are compared
 * with server completion times.
 */
export function createPresenceTracker(options: {
  readonly now: () => number;
  readonly load: () => number | null;
  readonly save: (presentAt: number) => void;
}) {
  let presentAt = options.load();
  let awaySince: number | null = null;
  let savedAt = Number.NEGATIVE_INFINITY;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const persist = (at: number) => {
    savedAt = at;
    options.save(at);
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** When the user left, while the box should show what changed since; otherwise null. */
    getAwaySince: () => awaySince,
    /** The user did something, or the window came back. */
    present() {
      const at = options.now();
      if (presentAt !== null && at - presentAt >= WHILE_AWAY_MIN_MS && awaySince === null) {
        awaySince = presentAt;
        notify();
      }
      presentAt = at;
      // Input arrives often; the stored time only needs to be fresh to the minute.
      if (at - savedAt >= 60_000) persist(at);
    },
    /** The window was hidden or closed: the user left now. */
    left() {
      const at = options.now();
      presentAt = at;
      persist(at);
    },
    /** "Caught up": the strip goes until the user is away again. */
    caughtUp() {
      if (awaySince === null) return;
      awaySince = null;
      notify();
    },
  };
}
