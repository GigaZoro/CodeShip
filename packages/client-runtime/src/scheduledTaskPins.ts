import type {
  EnvironmentId,
  ScheduledTask,
  ScheduledTaskNoWorkSkip,
  ScheduledTaskPlacement,
} from "@t3tools/contracts";

import { getFormattingLocale, msg, t, type Message } from "@t3tools/shared/i18n";
import { noWorkSkipText, shownNoWorkSkip } from "./scheduledTaskRunCondition.ts";
import { planPinnedReorder } from "./state/threadSort.ts";
import { THREAD_STATUS_DISPLAY, type ThreadStatus } from "./state/threadStatus.ts";

export type PinnedTaskStatus =
  | "starting"
  | "working"
  | "approval"
  | "input"
  | "request"
  | "failed"
  | "limited"
  | "paused"
  | "idle";

/** The run thread as each client's thread list already classifies it. */
export interface PinnedTaskRunThread {
  readonly status: ThreadStatus;
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
  if (
    threadStatus === "approval" ||
    threadStatus === "input" ||
    threadStatus === "request" ||
    threadStatus === "limited"
  ) {
    return threadStatus;
  }
  if (task.lastRunStatus === "failed" || threadStatus === "failed") return "failed";
  return task.enabled ? "idle" : "paused";
}

/**
 * Tasks whose latest run failed, once each: a shared task's copies share its id. The next run
 * that starts clears a task, and pausing it counts as dealing with it.
 */
export function failedScheduledTaskCount(
  lists: ReadonlyArray<ReadonlyArray<Pick<ScheduledTask, "id" | "enabled" | "lastRunStatus">>>,
): number {
  return new Set(
    lists.flatMap((tasks) =>
      tasks.flatMap((task) => (task.enabled && task.lastRunStatus === "failed" ? [task.id] : [])),
    ),
  ).size;
}

/** The thread a pinned task opens: the one its last run used, else the one it is bound to. */
export function pinnedTaskRunThreadId(
  task: Pick<ScheduledTask, "lastRunThreadId" | "threadId">,
): ScheduledTask["threadId"] {
  return task.lastRunThreadId ?? task.threadId;
}

/**
 * The tasks a thread row marks as scheduled. A bound task marks its thread even after
 * a rebind leaves `lastRunThreadId` stale; a fresh-thread task marks only its latest
 * run. A one-time task stops marking once it has no run left.
 */
export function scheduledTasksForThread(
  tasks: ReadonlyArray<ScheduledTask>,
  threadId: string,
): ScheduledTask[] {
  return tasks.filter(
    (task) =>
      (task.threadId ?? task.lastRunThreadId) === threadId &&
      (task.schedule.type !== "once" || task.nextRunAt !== null),
  );
}

/** Seconds matter for short intervals, so under an hour reads as a m:ss countdown. */
function formatCountdown(
  nextRunAt: string,
  nowMs: number,
  phrase: (duration: string) => string,
): string {
  const remainingMs = Date.parse(nextRunAt) - nowMs;
  if (Number.isNaN(remainingMs)) return "";
  if (remainingMs <= 0) return t("due now");
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return phrase(
    hours === 0
      ? `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`
      : hours >= 24
        ? t("{days}d", { days: Math.round(hours / 24) })
        : minutes === 0
          ? t("{hours}h", { hours })
          : t("{hours}h {minutes}m", { hours, minutes }),
  );
}

/** "next in 2h 30m", "due now", or empty for an unreadable time. */
export function formatNextRunCountdown(nextRunAt: string, nowMs: number): string {
  return formatCountdown(nextRunAt, nowMs, (duration) => t("next in {duration}", { duration }));
}

/** The short form for a one-line row: "in 2h 30m". */
export function formatNextRunIn(nextRunAt: string, nowMs: number): string {
  return formatCountdown(nextRunAt, nowMs, (duration) => t("in {duration}", { duration }));
}

/** How long ago `at` was, such as "5m ago". Empty for an unreadable time. */
export function formatTimeAgo(at: string, nowMs: number): string {
  const elapsedMs = nowMs - Date.parse(at);
  if (Number.isNaN(elapsedMs)) return "";
  const minutes = Math.floor(elapsedMs / 60_000);
  const hours = Math.floor(minutes / 60);
  return minutes < 1
    ? t("just now")
    : minutes < 60
      ? t("{minutes}m ago", { minutes })
      : hours < 24
        ? t("{hours}h ago", { hours })
        : t("{days}d ago", { days: Math.floor(hours / 24) });
}

export function formatLastRunAgo(lastRunAt: string, nowMs: number): string {
  const ago = formatTimeAgo(lastRunAt, nowMs);
  return ago === "" ? "" : t("last run {ago}", { ago });
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

/** A run's start, with the year only when it is not this year's. */
export function formatScheduledTaskRunTime(iso: string): string {
  // @effect-diagnostics-next-line globalDate:off - Clients format during render, outside an Effect runtime.
  const value = new Date(iso);
  // @effect-diagnostics-next-line globalDate:off - Compared with the viewer's current year.
  const currentYear = new Date().getFullYear();
  return value.toLocaleString(getFormattingLocale(), {
    month: "short",
    day: "numeric",
    ...(value.getFullYear() !== currentYear ? { year: "numeric" as const } : {}),
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Every part of its state a pinned task row shows. Each part carries the words a screen
 * reader speaks for it, with absolute times, so a label built once never goes stale; the
 * visible relative times come from `pinnedTaskTimingText` and `pinnedTaskSkippedText`.
 * A new part needs `spoken` too: `pinnedTaskStatusLabel` speaks every field.
 */
export type PinnedTaskRowStatus = {
  readonly run: {
    readonly status: Exclude<PinnedTaskStatus, "idle">;
    readonly text: string;
    readonly spoken: string;
  } | null;
  /** The next run while the task is on and has one, else the last run. */
  readonly timing: {
    readonly kind: "next" | "last";
    readonly at: string;
    readonly spoken: string;
  } | null;
  readonly skipped: { readonly skip: ScheduledTaskNoWorkSkip; readonly spoken: string } | null;
};

function pinnedTaskRunPart(
  status: Exclude<PinnedTaskStatus, "idle">,
): NonNullable<PinnedTaskRowStatus["run"]> {
  const text = t(THREAD_STATUS_DISPLAY[status].label);
  return { status, text, spoken: text };
}

export function pinnedTaskRowStatus(
  task: Pick<ScheduledTask, "enabled" | "nextRunAt" | "lastRunAt" | "lastNoWorkSkip">,
  status: PinnedTaskStatus,
): PinnedTaskRowStatus {
  const skip = shownNoWorkSkip(task);
  return {
    run: status === "idle" ? null : pinnedTaskRunPart(status),
    timing:
      task.enabled && task.nextRunAt !== null
        ? {
            kind: "next",
            at: task.nextRunAt,
            spoken: t("Next run {when}", { when: formatScheduledTaskRunTime(task.nextRunAt) }),
          }
        : task.lastRunAt !== null
          ? {
              kind: "last",
              at: task.lastRunAt,
              spoken: t("Last run {when}", { when: formatScheduledTaskRunTime(task.lastRunAt) }),
            }
          : null,
    skipped:
      skip === null
        ? null
        : { skip, spoken: noWorkSkipText(skip, formatScheduledTaskRunTime(skip.at)) },
  };
}

/** The row's screen-reader status: the spoken words of every part it shows, or null for none. */
export function pinnedTaskStatusLabel(status: PinnedTaskRowStatus): string | null {
  const parts: ReadonlyArray<{ readonly spoken: string } | null> = Object.values(status);
  const spoken = parts.flatMap((part) => (part === null ? [] : [part.spoken]));
  return spoken.length === 0 ? null : spoken.join(", ");
}

/** The timing part as the row shows it: "next in 2h" or "last run 5m ago", or "in 2h" or "5m ago" when short. */
export function pinnedTaskTimingText(
  timing: NonNullable<PinnedTaskRowStatus["timing"]>,
  nowMs: number,
  form: "long" | "short",
): string {
  if (timing.kind === "next") {
    return form === "long"
      ? formatNextRunCountdown(timing.at, nowMs)
      : formatNextRunIn(timing.at, nowMs);
  }
  return form === "long" ? formatLastRunAgo(timing.at, nowMs) : formatTimeAgo(timing.at, nowMs);
}

/** The skipped part as the row shows it: "Skipped 5m ago: No open PRs". */
export function pinnedTaskSkippedText(
  skipped: NonNullable<PinnedTaskRowStatus["skipped"]>,
  nowMs: number,
): string {
  return noWorkSkipText(skipped.skip, formatTimeAgo(skipped.skip.at, nowMs));
}

const SCHEDULED_TASK_PLACEMENTS = [
  { value: "none", label: msg("None") },
  { value: "chat", label: msg("Regular chat") },
  { value: "pinned", label: msg("Scheduled section") },
] as const satisfies ReadonlyArray<{
  readonly value: ScheduledTaskPlacement;
  readonly label: Message;
}>;

/** The placement choices, labelled in the active language. */
export function scheduledTaskPlacementOptions(): ReadonlyArray<{
  readonly value: ScheduledTaskPlacement;
  readonly label: string;
}> {
  return SCHEDULED_TASK_PLACEMENTS.map(({ value, label }) => ({ value, label: t(label) }));
}

export function scheduledTaskPlacementLabel(placement: ScheduledTaskPlacement): string {
  return t(SCHEDULED_TASK_PLACEMENTS.find((option) => option.value === placement)!.label);
}

/** Servers that predate placements only know pinned tasks. */
export function resolveScheduledTaskPlacement(
  task: Pick<ScheduledTask, "placement" | "pinnedAt">,
): ScheduledTaskPlacement {
  return task.placement ?? (task.pinnedAt != null ? "pinned" : "chat");
}

export interface PinnedTaskEntry {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
}

export function pinnedTaskKey(entry: {
  readonly environmentId: EnvironmentId;
  readonly task: Pick<ScheduledTask, "id">;
}): string {
  return `${entry.environmentId}:${entry.task.id}`;
}

/**
 * Tasks moved by hand first, in their order, then the rest oldest pin first,
 * so pinning another task does not move the ones already there.
 */
function sortPinnedTasks(entries: ReadonlyArray<PinnedTaskEntry>): PinnedTaskEntry[] {
  return [...entries].sort((left, right) => {
    const leftKey = left.task.pinOrderKey ?? null;
    const rightKey = right.task.pinOrderKey ?? null;
    if (leftKey !== rightKey) {
      if (leftKey === null) return 1;
      if (rightKey === null) return -1;
      return leftKey < rightKey ? -1 : 1;
    }
    return (
      (left.task.pinnedAt ?? "").localeCompare(right.task.pinnedAt ?? "") ||
      left.task.id.localeCompare(right.task.id) ||
      left.environmentId.localeCompare(right.environmentId)
    );
  });
}

/** The pinned tasks across these environments, in sidebar order. */
export function collectPinnedTasks(
  environmentIds: ReadonlyArray<EnvironmentId>,
  tasksFor: (environmentId: EnvironmentId) => ReadonlyArray<ScheduledTask>,
): PinnedTaskEntry[] {
  return sortPinnedTasks(
    environmentIds.flatMap((environmentId) =>
      tasksFor(environmentId)
        .filter((task) => resolveScheduledTaskPlacement(task) === "pinned")
        .map((task) => ({ environmentId, task })),
    ),
  );
}

export interface PinnedTaskOrderAssignment {
  readonly environmentId: EnvironmentId;
  readonly id: ScheduledTask["id"];
  readonly orderKey: string;
}

/**
 * The order keys that put `movedKey` where `visibleOrder` has it. Tasks a project
 * filter hides keep their keys and are never written.
 */
export function planPinnedTaskMove(input: {
  readonly pinned: ReadonlyArray<PinnedTaskEntry>;
  readonly visibleOrder: readonly string[];
  readonly movedKey: string;
}): PinnedTaskOrderAssignment[] {
  const byKey = new Map(input.pinned.map((entry) => [pinnedTaskKey(entry), entry]));
  return planPinnedReorder({
    orderedIds: input.visibleOrder,
    keysById: new Map(
      input.pinned.map((entry) => [pinnedTaskKey(entry), entry.task.pinOrderKey ?? null]),
    ),
    movedId: input.movedKey,
  }).flatMap(({ id, orderKey }) => {
    const entry = byKey.get(id);
    return entry === undefined
      ? []
      : [{ environmentId: entry.environmentId, id: entry.task.id, orderKey }];
  });
}

interface HeldPinOrderKey {
  readonly orderKey: string;
  /** Server keys this client has written over; the held key shows while the server has one. */
  readonly replaces: ReadonlyArray<string | null>;
  readonly pinnedAt: string | null | undefined;
}

/** Keys this client sent, by `pinnedTaskKey`, shown until the server's list catches up. */
export type HeldPinOrder = ReadonlyMap<string, HeldPinOrderKey>;

function isHeldKeyPending(task: ScheduledTask, hold: HeldPinOrderKey): boolean {
  // A re-pin or another client's move replaces the key, so the server's wins.
  return task.pinnedAt === hold.pinnedAt && hold.replaces.includes(task.pinOrderKey ?? null);
}

export function holdPinOrder(
  pinned: ReadonlyArray<PinnedTaskEntry>,
  held: HeldPinOrder | null,
  assignments: ReadonlyArray<PinnedTaskOrderAssignment>,
): HeldPinOrder {
  const byKey = new Map(pinned.map((entry) => [pinnedTaskKey(entry), entry]));
  const next = new Map<string, HeldPinOrderKey>();
  for (const [key, hold] of held ?? []) {
    const entry = byKey.get(key);
    if (entry !== undefined && isHeldKeyPending(entry.task, hold)) next.set(key, hold);
  }
  for (const assignment of assignments) {
    const key = pinnedTaskKey({
      environmentId: assignment.environmentId,
      task: { id: assignment.id },
    });
    const entry = byKey.get(key);
    if (entry === undefined) continue;
    const earlier = next.get(key);
    next.set(key, {
      orderKey: assignment.orderKey,
      replaces:
        earlier === undefined
          ? [entry.task.pinOrderKey ?? null]
          : [...earlier.replaces, earlier.orderKey],
      pinnedAt: entry.task.pinnedAt,
    });
  }
  return next;
}

/** `pinned` from the server, with the keys this client is still waiting on, re-sorted. */
export function applyHeldPinOrder(
  pinned: ReadonlyArray<PinnedTaskEntry>,
  held: HeldPinOrder,
): PinnedTaskEntry[] {
  return sortPinnedTasks(
    pinned.map((entry) => {
      const hold = held.get(pinnedTaskKey(entry));
      return hold !== undefined && isHeldKeyPending(entry.task, hold)
        ? { ...entry, task: { ...entry.task, pinOrderKey: hold.orderKey } }
        : entry;
    }),
  );
}

/**
 * `environmentId:threadId` keys of the threads that tasks placed nowhere own: the bound thread,
 * else the latest run. Returns `previous` when nothing changed, so thread lists keep their memo.
 */
export function scheduledTaskHiddenThreadKeys(
  environmentIds: ReadonlyArray<EnvironmentId>,
  tasksFor: (environmentId: EnvironmentId) => ReadonlyArray<ScheduledTask>,
  previous: ReadonlySet<string>,
): ReadonlySet<string> {
  const next = new Set<string>();
  for (const environmentId of environmentIds) {
    for (const task of tasksFor(environmentId)) {
      const threadId = task.threadId ?? task.lastRunThreadId;
      if (threadId != null && resolveScheduledTaskPlacement(task) === "none") {
        next.add(`${environmentId}:${threadId}`);
      }
    }
  }
  return next.size === previous.size && [...next].every((key) => previous.has(key))
    ? previous
    : next;
}
