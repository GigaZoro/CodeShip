import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";

export type PinnedTaskStatus =
  | "starting"
  | "working"
  | "approval"
  | "input"
  | "failed"
  | "paused"
  | "idle";

/** The run thread as each client's thread list already classifies it. */
export interface PinnedTaskRunThread {
  readonly status:
    | "approval"
    | "input"
    | "request"
    | "waiting"
    | "working"
    | "failed"
    | "limited"
    | "ready";
  readonly runtimeStatus: string | null;
}

/** What a pinned task is doing now: its dispatch first, then the thread its last run used. */
export function resolvePinnedTaskStatus(
  task: Pick<ScheduledTask, "enabled" | "lastRunStatus">,
  runThread: PinnedTaskRunThread | null,
): PinnedTaskStatus {
  if (task.lastRunStatus === "running") return "starting";
  const threadStatus = runThread?.status ?? null;
  // "waiting" also covers a finished turn whose session idles; only a running one is still working.
  if (
    threadStatus === "working" ||
    (threadStatus === "waiting" && runThread?.runtimeStatus === "running")
  ) {
    return "working";
  }
  if (threadStatus === "approval" || threadStatus === "input") return threadStatus;
  if (task.lastRunStatus === "failed" || threadStatus === "failed" || threadStatus === "limited") {
    return "failed";
  }
  return task.enabled ? "idle" : "paused";
}

/** The thread a pinned task opens: the one its last run used, else the one it is bound to. */
export function pinnedTaskRunThreadId(
  task: Pick<ScheduledTask, "lastRunThreadId" | "threadId">,
): ScheduledTask["threadId"] {
  return task.lastRunThreadId ?? task.threadId;
}

/** Seconds matter for short intervals, so under an hour reads as a m:ss countdown. */
export function formatNextRunCountdown(nextRunAt: string, nowMs: number): string {
  const remainingMs = Date.parse(nextRunAt) - nowMs;
  if (Number.isNaN(remainingMs)) return "";
  if (remainingMs <= 0) return "due now";
  const totalSeconds = Math.ceil(remainingMs / 1000);
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `in ${minutes}:${String(seconds).padStart(2, "0")}`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  if (hours < 24) {
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return minutes === 0 ? `in ${hours}h` : `in ${hours}h ${minutes}m`;
  }
  return `in ${Math.round(hours / 24)}d`;
}

/** How far an interval task is through its wait for the next run, from 0 to 1. */
export function intervalWaitProgress(
  task: Pick<ScheduledTask, "schedule" | "nextRunAt">,
  nowMs: number,
): number | null {
  if (task.schedule.type !== "interval" || task.nextRunAt === null) return null;
  const remainingMs = Date.parse(task.nextRunAt) - nowMs;
  if (Number.isNaN(remainingMs)) return null;
  return Math.min(1, Math.max(0, 1 - remainingMs / task.schedule.everyMs));
}

interface PinnedTaskEntry {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
}

/**
 * The pinned tasks across these environments, oldest pin first, so pinning
 * another task does not move the ones already there.
 */
export function collectPinnedTasks(
  environmentIds: ReadonlyArray<EnvironmentId>,
  tasksFor: (environmentId: EnvironmentId) => ReadonlyArray<ScheduledTask>,
): PinnedTaskEntry[] {
  return environmentIds
    .flatMap((environmentId) =>
      tasksFor(environmentId)
        .filter((task) => task.pinnedAt != null)
        .map((task) => ({ environmentId, task })),
    )
    .sort(
      (left, right) =>
        (left.task.pinnedAt ?? "").localeCompare(right.task.pinnedAt ?? "") ||
        left.task.id.localeCompare(right.task.id),
    );
}
