import * as Schema from "effect/Schema";
import { msg, type Message } from "@t3tools/shared/i18n";
import { quietPastLimit } from "@t3tools/shared/threadQuiet";
import {
  backgroundWorkHoldsCompletion,
  type PendingBackgroundWorkTask,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import type { EnvironmentThreadShell } from "./models.ts";

/** What a thread is doing, as every client's thread list classifies it. */
export type ThreadStatus =
  | "approval"
  | "input"
  | "request"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

export type ThreadStatusInput = Pick<
  EnvironmentThreadShell,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "runtime"
  | "blockedOnThreadWait"
> & {
  readonly latestRun: Pick<NonNullable<EnvironmentThreadShell["latestRun"]>, "status"> | null;
};

export function resolveThreadStatus(thread: ThreadStatusInput): ThreadStatus {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  // A guest is waiting on the owner; the agent's own requests come first.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return "request";
  }
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
    return "waiting";
  }
  if (
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return thread.latestRun?.status === "failed" ? "failed" : "ready";
}

export type ThreadStallInput = ThreadStatusInput &
  Pick<EnvironmentThreadShell, "updatedAt" | "stalledAfterMs">;

export interface ThreadStall {
  /** The thread's last event, in epoch milliseconds. */
  readonly lastEventAt: number;
  /** When the thread reads as Stalled if nothing else happens first. */
  readonly stalledAt: number;
}

/**
 * A working thread that emits nothing for `stalledAfterMs` reads as Stalled until its next event.
 * A thread waiting on another thread or on its background work is not working, nor is a queued
 * run: CodeShip holds those, not the agent. Tools that report progress emit events as they run.
 */
export function resolveThreadStall(thread: ThreadStallInput): ThreadStall | null {
  if (
    thread.stalledAfterMs === undefined ||
    thread.runtime?.status === "queued" ||
    resolveThreadStatus(thread) !== "working"
  ) {
    return null;
  }
  const lastEventAt = Date.parse(thread.updatedAt);
  if (Number.isNaN(lastEventAt)) return null;
  return { lastEventAt, stalledAt: lastEventAt + thread.stalledAfterMs };
}

/** A snooze-only stand-in (no stall limit) or a thread shell. */
export type ThreadListDeadlineInput = { readonly snoozedUntil?: string | null | undefined } & (
  | ThreadStallInput
  | { readonly stalledAfterMs?: undefined }
);

/**
 * When time alone moves the thread in a list, in epoch milliseconds: its snooze ends or it stalls.
 * List clocks wake at these so a section changes on time rather than on the next minute tick.
 */
export function threadListDeadlines(thread: ThreadListDeadlineInput): ReadonlyArray<number> {
  const deadlines: number[] = [];
  const snoozeEndsAt = thread.snoozedUntil == null ? Number.NaN : Date.parse(thread.snoozedUntil);
  if (Number.isFinite(snoozeEndsAt)) deadlines.push(snoozeEndsAt);
  const stall = thread.stalledAfterMs === undefined ? null : resolveThreadStall(thread);
  if (stall !== null) deadlines.push(stall.stalledAt);
  return deadlines;
}

export function isThreadStalled(thread: ThreadStallInput, now: number): boolean {
  const stall = resolveThreadStall(thread);
  const limitMs = thread.stalledAfterMs;
  return (
    stall !== null &&
    limitMs !== undefined &&
    quietPastLimit({ lastEventAt: stall.lastEventAt, now, limitMs }) !== null
  );
}

/**
 * The agent waits on work it started: another thread its running turn awaits, or background work
 * holding its run. A failed run stays failed, as the shell keeps it, whatever it left running.
 */
export function isThreadWaitingOnWork(thread: {
  readonly runtime: Pick<NonNullable<EnvironmentThreadShell["runtime"]>, "status"> | null;
  readonly blockedOnThreadWait?: boolean | undefined;
  readonly pendingBackgroundTasks?:
    | ReadonlyArray<Pick<PendingBackgroundWorkTask, "kind" | "awaited">>
    | undefined;
}): boolean {
  return (
    (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) ||
    (thread.runtime?.status !== "failed" &&
      backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []))
  );
}

/**
 * The colour role of a status. Each client maps it to its own classes, so a status
 * keeps one meaning everywhere while each platform keeps its palette.
 */
export type ThreadStatusTone =
  | "attention"
  | "question"
  | "guest"
  | "active"
  | "muted"
  | "error"
  | "success"
  | "plan";

interface ThreadStatusDisplay {
  /** The short word rows, pills, and task lists show. */
  readonly label: Message;
  /** The sentence notifications and screen readers say, for statuses they announce. */
  readonly summary?: Message;
  readonly tone: ThreadStatusTone;
}

/** Every client names a status with these words, so a thread reads the same on each. */
export const THREAD_STATUS_DISPLAY = {
  approval: { label: msg("Approval"), summary: msg("Approval needed"), tone: "attention" },
  input: { label: msg("Question"), summary: msg("Input needed"), tone: "question" },
  request: { label: msg("Request"), summary: msg("Guest request"), tone: "guest" },
  failed: { label: msg("Failed"), summary: msg("Thread failed"), tone: "error" },
  limited: { label: msg("Limited"), summary: msg("Usage limit reached"), tone: "attention" },
  starting: { label: msg("Starting"), tone: "active" },
  working: { label: msg("Working"), summary: msg("Working"), tone: "active" },
  stalled: { label: msg("Stalled"), summary: msg("Thread stalled"), tone: "attention" },
  goal: { label: msg("Goal"), tone: "active" },
  waiting: { label: msg("Waiting"), tone: "muted" },
  paused: { label: msg("Paused"), tone: "muted" },
  plan: { label: msg("Plan ready"), tone: "plan" },
  woke: { label: msg("Woke"), tone: "attention" },
  done: { label: msg("Done"), summary: msg("Thread completed"), tone: "success" },
} as const satisfies Record<string, ThreadStatusDisplay>;

export type ThreadStatusDisplayKey = keyof typeof THREAD_STATUS_DISPLAY;

export const ThreadListStatusFilter = Schema.Literals([
  "all",
  "attention",
  "working",
  "unread",
  "failed",
]);
export type ThreadListStatusFilter = typeof ThreadListStatusFilter.Type;

export const THREAD_LIST_STATUS_LABELS = {
  all: msg("All"),
  attention: msg("Needs you"),
  working: THREAD_STATUS_DISPLAY.working.label,
  unread: msg("Unread"),
  failed: THREAD_STATUS_DISPLAY.failed.label,
  done: THREAD_STATUS_DISPLAY.done.label,
} satisfies Record<ThreadListStatusFilter | "done", Message>;

export type ProjectThreadState = "attention" | "working" | "done" | "quiet";

type ThreadCompletionInput = {
  readonly latestRun: Pick<NonNullable<EnvironmentThreadShell["latestRun"]>, "completedAt"> | null;
  readonly lastVisitedAt?: string | null | undefined;
};

type ThreadListStatusInput = ThreadStatusInput & ThreadCompletionInput;

export function hasUnseenCompletion(thread: ThreadCompletionInput): boolean {
  if (!thread.latestRun?.completedAt) return false;
  const completedAt = Date.parse(thread.latestRun.completedAt);
  if (Number.isNaN(completedAt) || !thread.lastVisitedAt) return false;
  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  return Number.isNaN(lastVisitedAt) || completedAt > lastVisitedAt;
}

function classifyThreadStatus(
  status: ThreadStatus,
  thread: ThreadCompletionInput,
  flags: {
    readonly woke?: boolean;
    readonly locallyUnread?: boolean;
    /** `isThreadStalled` at the caller's clock: a stalled run waits on the user, not the agent. */
    readonly stalled?: boolean;
  },
): ProjectThreadState {
  switch (status) {
    case "approval":
    case "input":
    case "request":
    case "limited":
    case "failed":
      return "attention";
    case "working":
      return flags.stalled ? "attention" : "working";
    case "ready":
      if (flags.woke) return "attention";
      return flags.locallyUnread || hasUnseenCompletion(thread) ? "done" : "quiet";
    case "waiting":
      if (flags.woke) return "attention";
      return flags.locallyUnread ? "done" : "quiet";
  }
}

export function resolveProjectThreadState(
  thread: ThreadListStatusInput,
  flags: Parameters<typeof classifyThreadStatus>[2] = {},
): ProjectThreadState {
  return classifyThreadStatus(resolveThreadStatus(thread), thread, flags);
}

export function matchesThreadListStatus(
  thread: ThreadListStatusInput,
  filter: ThreadListStatusFilter,
  flags: Parameters<typeof classifyThreadStatus>[2] = {},
): boolean {
  if (filter === "all") return true;
  const status = resolveThreadStatus(thread);
  if (filter === "failed") return status === "failed";
  return classifyThreadStatus(status, thread, flags) === (filter === "unread" ? "done" : filter);
}
