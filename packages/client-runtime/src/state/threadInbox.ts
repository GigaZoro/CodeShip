// @effect-diagnostics globalTimers:off - Shelf placement timers run in web and native clients, outside an Effect runtime.
import * as DateTime from "effect/DateTime";

import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import { toSortableTimestamp } from "./threadSort.ts";
import { effectiveSnoozed, type ThreadSnoozeShell } from "./threadSettled.ts";
import {
  isThreadStalled,
  resolveThreadStall,
  resolveThreadStatus,
  type ThreadStatusInput,
} from "./threadStatus.ts";

type WorkingThreadInput = Pick<
  EnvironmentThreadShell,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "interactionMode"
  | "latestRun"
  | "runtime"
>;

export function isThreadWorking(thread: WorkingThreadInput): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.pendingSubagentRequest != null) return false;
  if (!threadRuntimeIsActive(thread.runtime) && thread.runtime?.status !== "idle") return false;
  const run = thread.latestRun;
  const runSettled =
    run !== null &&
    run.status !== "preparing" &&
    run.status !== "queued" &&
    run.status !== "starting" &&
    run.status !== "running" &&
    run.status !== "waiting" &&
    thread.runtime?.activeRunId !== run.runId;
  return !(thread.interactionMode === "plan" && thread.hasActionableProposedPlan && runSettled);
}

/** An approval, a question, a subagent's request, or a guest's message is waiting on the user. */
export function threadAwaitsUser(
  thread: Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "pendingGuestMessageCount"
  >,
): boolean {
  return (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.pendingSubagentRequest != null ||
    (thread.pendingGuestMessageCount ?? 0) > 0
  );
}

/** Why a thread cannot go on without the user. */
export type NeedsYouReason = "approval" | "input" | "request" | "failed" | "limited" | "stalled";

export type NeedsYouInput = ThreadStatusInput &
  ThreadSnoozeShell &
  Pick<
    EnvironmentThreadShell,
    "createdBy" | "settledOverride" | "updatedAt" | "stalledAfterMs" | "laterAt" | "latestRun"
  > &
  Partial<Pick<EnvironmentThreadShell, "limitRecovery">>;

/**
 * A failure or a stall is the user's to act on only in a thread they started. Agents and Chat
 * Doctor recover the threads agents started, scheduled task runs included, so those stay out of
 * Needs you and only show Failed or Stalled in the thread list.
 */
function outcomeWaitsOnUser(thread: Pick<NeedsYouInput, "createdBy" | "settledOverride">) {
  return thread.createdBy === "user" && thread.settledOverride !== "settled";
}

/**
 * Requests always need the user, settled or not, except a question while it is snoozed. A failure
 * or a stall in a thread the user started does until they settle, snooze, or retry it, a stalled
 * thread's next event clears it, or a usage-limited run is set to resume by itself.
 */
export function threadNeedsYouReason(
  thread: NeedsYouInput,
  options: { readonly now: string },
): NeedsYouReason | null {
  const status = resolveThreadStatus(thread);
  if (status === "approval" || status === "request") return status;
  if (status === "input") return effectiveSnoozed(thread, options) ? null : status;
  if (!outcomeWaitsOnUser(thread) || effectiveSnoozed(thread, options)) return null;
  if (status === "working") {
    return isThreadStalled(thread, Date.parse(options.now)) ? "stalled" : null;
  }
  if (status !== "failed" && status !== "limited") return null;
  const recovery = thread.limitRecovery;
  if (
    status === "limited" &&
    recovery?.autoResume === true &&
    recovery.runId === thread.latestRun?.runId
  ) {
    return null;
  }
  return status;
}

/** When the thread started waiting on the user, in epoch milliseconds. */
function threadNeedsYouSince(thread: NeedsYouInput, reason: NeedsYouReason): number {
  const request = thread.source?.pendingRuntimeRequest;
  const exact =
    (reason === "approval" || reason === "input") && request != null
      ? DateTime.toEpochMillis(request.createdAt)
      : reason === "failed" || reason === "limited"
        ? toSortableTimestamp(thread.latestRun?.completedAt ?? undefined)
        : reason === "stalled"
          ? resolveThreadStall(thread)?.lastEventAt
          : undefined;
  // Subagent and guest requests carry no time of their own; the thread's last change stands in.
  return exact ?? toSortableTimestamp(thread.updatedAt) ?? 0;
}

export interface NeedsYouThreads<T> {
  /** What needs the user now, longest wait first. Badges count these. */
  readonly threads: readonly T[];
  /** Put off with "Decide later" before their wait began; they still wait, longest first. */
  readonly later: readonly T[];
  /** When the thread started waiting on the user, in epoch milliseconds. */
  readonly sinceOf: (thread: T) => number;
  /** When a snoozed failure or question wakes or a working thread stalls, so a caller can recompute then. */
  readonly nextChangeAt: number | null;
}

export function collectNeedsYouThreads<
  T extends NeedsYouInput & Pick<EnvironmentThreadShell, "id" | "environmentId">,
>(threads: readonly T[], options: { readonly now: string }): NeedsYouThreads<T> {
  const sinceByThread = new Map<T, number>();
  let nextChangeAt: number | null = null;
  for (const thread of threads) {
    const reason = threadNeedsYouReason(thread, options);
    if (reason !== null) {
      sinceByThread.set(thread, threadNeedsYouSince(thread, reason));
      continue;
    }
    const status = resolveThreadStatus(thread);
    let changeAt: number | undefined;
    if (status === "input") {
      changeAt = thread.snoozedUntil != null ? Date.parse(thread.snoozedUntil) : undefined;
    } else if (outcomeWaitsOnUser(thread)) {
      const stalledAt = resolveThreadStall(thread)?.stalledAt;
      changeAt =
        thread.snoozedUntil != null &&
        (status === "failed" || status === "limited" || stalledAt !== undefined)
          ? Math.max(Date.parse(thread.snoozedUntil), stalledAt ?? 0)
          : stalledAt;
    }
    if (
      changeAt !== undefined &&
      changeAt > Date.parse(options.now) &&
      (nextChangeAt === null || changeAt < nextChangeAt)
    ) {
      nextChangeAt = changeAt;
    }
  }
  const sorted = [...sinceByThread.keys()].sort(
    (left, right) =>
      sinceByThread.get(left)! - sinceByThread.get(right)! ||
      left.id.localeCompare(right.id) ||
      left.environmentId.localeCompare(right.environmentId),
  );
  const putOff = (thread: T) =>
    thread.laterAt != null && sinceByThread.get(thread)! <= Date.parse(thread.laterAt);
  return {
    threads: sorted.filter((thread) => !putOff(thread)),
    later: sorted.filter(putOff),
    sinceOf: (thread) => sinceByThread.get(thread) ?? 0,
    nextChangeAt,
  };
}

/**
 * Where "next thread that needs you" goes: the one after `current` in Needs you order,
 * wrapping around, or the longest wait when the open thread is not listed.
 */
export function nextNeedsYouThread<T extends Pick<EnvironmentThreadShell, "environmentId" | "id">>(
  threads: readonly T[],
  current: { readonly environmentId: string; readonly threadId: string } | null,
): T | null {
  const index =
    current === null
      ? -1
      : threads.findIndex(
          (thread) =>
            thread.environmentId === current.environmentId && thread.id === current.threadId,
        );
  if (index === -1) return threads[0] ?? null;
  return threads.length > 1 ? threads[(index + 1) % threads.length]! : null;
}

/**
 * A thread its own client is launching reads as preparing until its first run lands.
 * The server commits the thread before its run, so the list would otherwise place it twice.
 */
export function asLaunchingThread<T extends EnvironmentThreadShell>(thread: T): T {
  if (thread.latestRun !== null || thread.runtime !== null) return thread;
  return {
    ...thread,
    runtime: {
      status: "preparing",
      activeRunId: null,
      providerInstanceId: thread.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: thread.updatedAt,
    },
  };
}

type InboxThreadInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "unsettledAt" | "latestRun"
>;

export function sortInboxThreadsByReturn<T extends InboxThreadInput>(
  threads: readonly T[],
  observedReturnAt?: (thread: T) => number | undefined,
): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.requestedAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.completedAt ?? undefined) ?? 0,
        observedReturnAt?.(thread) ?? 0,
      ),
    ]),
  );
  return sortNewestFirst(threads, timestamps);
}

type WorkingSortInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "latestUserMessageAt" | "latestUserAuthoredMessageAt"
>;

/**
 * When the user last sent to the thread or created it, in epoch ms; streamed output never moves it.
 * An older server omits `latestUserAuthoredMessageAt`, so its latest user-role message stands in, which an agent wake also moves.
 */
export function threadLastSendAt(thread: WorkingSortInput): number {
  const authored = thread.latestUserAuthoredMessageAt;
  return Math.max(
    toSortableTimestamp(thread.createdAt) ?? 0,
    toSortableTimestamp(
      (authored === undefined ? thread.latestUserMessageAt : authored) ?? undefined,
    ) ?? 0,
  );
}

export function sortWorkingThreadsBySend<T extends WorkingSortInput>(threads: readonly T[]): T[] {
  return sortNewestFirst(
    threads,
    new Map(threads.map((thread) => [thread, threadLastSendAt(thread)])),
  );
}

function sortNewestFirst<T extends Pick<EnvironmentThreadShell, "id" | "environmentId">>(
  threads: readonly T[],
  timestamps: ReadonlyMap<T, number>,
): T[] {
  return [...threads].sort(
    (left, right) =>
      timestamps.get(right)! - timestamps.get(left)! ||
      left.id.localeCompare(right.id) ||
      left.environmentId.localeCompare(right.environmentId),
  );
}

type TrackedInboxThread = WorkingThreadInput &
  InboxThreadInput &
  Partial<
    Pick<
      EnvironmentThreadShell,
      | "archivedAt"
      | "deletedAt"
      | "pinnedAt"
      | "settledOverride"
      | "settledAt"
      | "snoozedAt"
      | "snoozedUntil"
      | "activeOrderKey"
      | "pendingGuestMessageCount"
    >
  >;

type ThreadKeyInput = Pick<EnvironmentThreadShell, "environmentId" | "id">;

/**
 * How long a thread that stopped working keeps reading as working. An orchestrator
 * run can end moments before its continuation starts, so clients wait this long
 * before treating the thread as done.
 */
const WORKING_EXIT_GRACE_MS = 2_000;

/**
 * A run that ended this long ago has no continuation about to start, so its thread gets no
 * grace. A client sees this for work that ended while it was closed or disconnected; the
 * margin is wide so a client clock that runs ahead of the server does not cancel the grace.
 */
const STALE_EXIT_MS = 60_000;

/**
 * Keep one at module scope so placement survives routes that unmount the list. Call
 * `observe` when the shells or the snapshot version change, or with null while the beta
 * is off. Its result stays fixed, so a list built from it can be cached. A memoized caller
 * passes the version it read: the React Compiler keys memos only on values the callback reads.
 */
export function createInboxReturnTracker() {
  const keyOf = (thread: ThreadKeyInput) => `${thread.environmentId}:${thread.id}`;
  const states = new Map<
    string,
    { working: boolean; deadline: number | null; placement: string | null }
  >();
  const returns = new Map<string, number>();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let version = 0;
  const now = () => {
    // @effect-diagnostics-next-line globalDate:off - The grace deadline is wall-clock time shared by web and native clients.
    return Date.now();
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    let next = Infinity;
    for (const state of states.values()) {
      if (state.deadline !== null) next = Math.min(next, state.deadline);
    }
    if (next === Infinity) return;
    timer = setTimeout(
      () => {
        const at = now();
        for (const [key, state] of states) {
          if (state.deadline !== null && state.deadline <= at) {
            state.working = false;
            state.deadline = null;
            returns.set(key, at);
          }
        }
        schedule();
        version++;
        for (const listener of listeners) listener();
      },
      Math.max(0, next - now()),
    );
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => version,
    observe(
      threads: readonly TrackedInboxThread[] | null,
      _version?: number,
    ): {
      readonly isWorking: (thread: WorkingThreadInput & ThreadKeyInput) => boolean;
      readonly returnedAt: (thread: ThreadKeyInput) => number | undefined;
    } {
      if (threads === null) {
        clearTimeout(timer);
        timer = undefined;
        states.clear();
        returns.clear();
        return { isWorking: isThreadWorking, returnedAt: () => undefined };
      }
      const present = new Set<string>();
      const at = now();
      // @effect-diagnostics-next-line globalDate:off - Snooze checks compare wall-clock ISO times.
      const observedAt = new Date(at).toISOString();
      for (const thread of threads) {
        const key = keyOf(thread);
        present.add(key);
        const previous = states.get(key);
        const actual = isThreadWorking(thread);
        const placement =
          actual || previous?.working
            ? JSON.stringify([
                thread.archivedAt,
                thread.deletedAt,
                thread.pinnedAt,
                thread.settledOverride,
                thread.settledAt,
                thread.snoozedAt,
                thread.snoozedUntil,
                thread.activeOrderKey,
              ])
            : null;
        const actionable =
          thread.hasPendingApprovals ||
          thread.hasPendingUserInput ||
          thread.pendingSubagentRequest != null ||
          (thread.pendingGuestMessageCount ?? 0) > 0 ||
          (thread.interactionMode === "plan" && thread.hasActionableProposedPlan) ||
          thread.runtime?.lastError != null ||
          thread.latestRun?.status === "failed";
        const moved = previous !== undefined && previous.placement !== placement;
        const excluded =
          thread.archivedAt != null ||
          thread.deletedAt != null ||
          thread.pinnedAt != null ||
          thread.settledOverride === "settled" ||
          effectiveSnoozed(thread, { now: observedAt });
        // Only shelf placement is held: execution state and attention requests stay authoritative.
        const endedAt = toSortableTimestamp(thread.latestRun?.completedAt ?? undefined);
        const endedLongAgo = endedAt !== null && endedAt <= at - STALE_EXIT_MS;
        const deadline =
          !actual && previous?.working && !actionable && !moved && !excluded && !endedLongAgo
            ? (previous.deadline ?? at + WORKING_EXIT_GRACE_MS)
            : null;
        const working = actual || (deadline !== null && deadline > at);
        if (previous?.working && !working) returns.set(key, at);
        states.set(key, { working, deadline: working ? deadline : null, placement });
      }
      for (const key of states.keys()) {
        if (!present.has(key)) {
          states.delete(key);
          returns.delete(key);
        }
      }
      schedule();
      const observedWorking = new Map<string, boolean>();
      states.forEach((state, key) => observedWorking.set(key, state.working));
      const observedReturns = new Map(returns);
      return {
        isWorking: (thread) => observedWorking.get(keyOf(thread)) ?? isThreadWorking(thread),
        returnedAt: (thread) => observedReturns.get(keyOf(thread)),
      };
    },
    isWorking: (thread: WorkingThreadInput & ThreadKeyInput) =>
      states.get(keyOf(thread))?.working ?? isThreadWorking(thread),
    returnedAt: (thread: ThreadKeyInput) => returns.get(keyOf(thread)),
  };
}
