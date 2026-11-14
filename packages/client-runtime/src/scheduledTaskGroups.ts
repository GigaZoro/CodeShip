import {
  compareScheduledTaskSharedRevisions,
  type EnvironmentId,
  type ScheduledTask,
  type ScheduledTaskId,
  type ScheduledTaskRunStats,
  threadFolderKey,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type { ScheduledTaskCopy, SharedScheduledTaskGroup } from "./scheduledTaskSharing.ts";

export interface ScheduledTaskGroupSection<T> {
  /** Null for the tasks without a group. */
  readonly key: string | null;
  /** The first label seen for the group; null for the tasks without one. */
  readonly label: string | null;
  readonly items: ReadonlyArray<T>;
}

function groupLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

const byLabel = (left: string, right: string) =>
  left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });

/**
 * Groups by label, in label order, with the tasks without a group last. Items keep their order.
 * A list where no item has a group comes back as one section with a null key.
 */
export function groupScheduledTaskItems<T>(
  items: ReadonlyArray<T>,
  labelOf: (item: T) => string | null | undefined,
): ReadonlyArray<ScheduledTaskGroupSection<T>> {
  const groups = new Map<string, { label: string; items: T[] }>();
  const ungrouped: T[] = [];
  for (const item of items) {
    const label = groupLabel(labelOf(item));
    if (label === null) {
      ungrouped.push(item);
      continue;
    }
    const key = threadFolderKey(label);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { label, items: [item] });
    else group.items.push(item);
  }
  const sections: ScheduledTaskGroupSection<T>[] = [...groups.entries()]
    .map(([key, group]) => ({ key, label: group.label, items: group.items }))
    .sort((left, right) => byLabel(left.label, right.label));
  if (ungrouped.length > 0 || sections.length === 0) {
    sections.push({ key: null, label: null, items: ungrouped });
  }
  return sections;
}

/** What the Scheduled tasks page lists: a shared task once, however many machines hold it. */
export type ScheduledTaskListItem =
  | { readonly kind: "shared"; readonly group: SharedScheduledTaskGroup }
  | { readonly kind: "local"; readonly environmentId: EnvironmentId; readonly task: ScheduledTask };

/**
 * The copy a shared task's group is read from and group pauses go to: the newest copy whose server
 * has groups. A server without them leaves `group` out, and the other machines keep theirs when its
 * edits sync, so its copy can be the newest while the group lives on.
 */
export function scheduledTaskGroupCopy(group: SharedScheduledTaskGroup): ScheduledTaskCopy {
  if (group.primary.task.group !== undefined) return group.primary;
  let best: ScheduledTaskCopy | null = null;
  for (const copy of group.copies) {
    const revision = copy.task.shared?.revision;
    if (copy.task.group === undefined || revision === undefined) continue;
    const bestRevision = best?.task.shared?.revision;
    if (
      bestRevision === undefined ||
      compareScheduledTaskSharedRevisions(revision, bestRevision) > 0
    ) {
      best = copy;
    }
  }
  return best ?? group.primary;
}

export function scheduledTaskListItemGroupCopy(item: ScheduledTaskListItem): ScheduledTaskCopy {
  return item.kind === "shared" ? scheduledTaskGroupCopy(item.group) : item;
}

/** Every machine's copy, whose numbers add up in the group's summary. */
export function scheduledTaskListItemCopies(
  item: ScheduledTaskListItem,
): ReadonlyArray<ScheduledTaskCopy> {
  return item.kind === "shared" ? item.group.copies : [item];
}

/**
 * The upsert input's `group`: the trimmed label, null to clear one the task had, and absent
 * otherwise, so a machine without groups never receives the field and an untouched task keeps
 * its stored group.
 */
export function scheduledTaskGroupUpsertField(input: {
  readonly supported: boolean;
  readonly group: string;
  readonly hadGroup: boolean;
}): { readonly group?: string | null } {
  if (!input.supported) return {};
  const group = input.group.trim();
  if (group !== "") return { group };
  return input.hadGroup ? { group: null } : {};
}

/** One label per group in use, sorted, for the editor's suggestions. */
export function scheduledTaskGroupLabels(
  labels: Iterable<string | null | undefined>,
): ReadonlyArray<string> {
  const byKey = new Map<string, string>();
  for (const value of labels) {
    const label = groupLabel(value);
    if (label === null) continue;
    const key = threadFolderKey(label);
    if (!byKey.has(key)) byKey.set(key, label);
  }
  return [...byKey.values()].sort(byLabel);
}

/**
 * Resume while any task is off because its group was paused; otherwise pause while any task is
 * on. Null when neither applies.
 */
export function scheduledTaskGroupAction(
  tasks: ReadonlyArray<Pick<ScheduledTask, "enabled" | "pausedWithGroup">>,
): "pause" | "resume" | null {
  if (tasks.some((task) => !task.enabled && task.pausedWithGroup === true)) return "resume";
  if (tasks.some((task) => task.enabled)) return "pause";
  return null;
}

/**
 * The ids each machine gets for a group pause or resume. Pass a shared task once, as its newest
 * copy: that machine changes it, and sync carries the change to the other copies.
 */
export function scheduledTaskGroupPausePlan(
  tasks: ReadonlyArray<ScheduledTaskCopy>,
  paused: boolean,
): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly ids: ScheduledTaskId[] }> {
  const byEnvironment = new Map<EnvironmentId, ScheduledTaskId[]>();
  for (const { environmentId, task } of tasks) {
    const changes = paused ? task.enabled : !task.enabled && task.pausedWithGroup === true;
    if (!changes) continue;
    const ids = byEnvironment.get(environmentId);
    if (ids === undefined) byEnvironment.set(environmentId, [task.id]);
    else ids.push(task.id);
  }
  return [...byEnvironment.entries()].map(([environmentId, ids]) => ({ environmentId, ids }));
}

export interface ScheduledTaskGroupHealth {
  readonly runs: number;
  readonly failed: number;
  readonly usageLimited: number;
}

export interface ScheduledTaskGroupSummary {
  /** Distinct tasks: a shared task counts once. */
  readonly count: number;
  /** The soonest next run of the group's tasks; null when none has one. */
  readonly nextRunAt: string | null;
  /** Runs of every copy, summed; null when no machine reported its numbers. */
  readonly health: ScheduledTaskGroupHealth | null;
}

/**
 * `statsFor` gives one machine's numbers for a task, or undefined when that machine has not
 * reported them. Each copy of a shared task runs on its own machine, so its numbers add up.
 */
export function summarizeScheduledTaskGroup(
  copies: ReadonlyArray<ScheduledTaskCopy>,
  statsFor: (
    environmentId: EnvironmentId,
    taskId: ScheduledTaskId,
  ) => Pick<ScheduledTaskRunStats, "runs" | "failed" | "usageLimited"> | undefined,
): ScheduledTaskGroupSummary {
  let nextRunAt: string | null = null;
  let health: { runs: number; failed: number; usageLimited: number } | null = null;
  for (const { environmentId, task } of copies) {
    if (
      task.enabled &&
      task.nextRunAt !== null &&
      (nextRunAt === null || Date.parse(task.nextRunAt) < Date.parse(nextRunAt))
    ) {
      nextRunAt = task.nextRunAt;
    }
    const stats = statsFor(environmentId, task.id);
    if (stats === undefined) continue;
    health ??= { runs: 0, failed: 0, usageLimited: 0 };
    health.runs += stats.runs;
    health.failed += stats.failed;
    health.usageLimited += stats.usageLimited;
  }
  return {
    count: new Set(copies.map(({ task }) => task.id)).size,
    nextRunAt,
    health,
  };
}

export interface ScheduledTaskGroupUsage extends ScheduledTaskGroupHealth {
  readonly key: string | null;
  readonly label: string | null;
  /** Distinct tasks that ran in the window. */
  readonly tasks: number;
  readonly costUsd: number;
  readonly unpricedRuns: number;
}

/**
 * Every machine's numbers, summed per group: most spent first, the tasks without a group last.
 * A shared task's copies add up, since each machine pays for its own runs.
 */
export function scheduledTaskGroupUsage(
  lists: ReadonlyArray<ReadonlyArray<ScheduledTaskRunStats>>,
): ReadonlyArray<ScheduledTaskGroupUsage> {
  const sections = groupScheduledTaskItems(lists.flat(), (stats) => stats.group);
  return sections
    .filter((section) => section.items.length > 0)
    .map((section) => ({
      key: section.key,
      label: section.label,
      tasks: new Set(section.items.filter((stats) => stats.runs > 0).map((stats) => stats.id)).size,
      runs: section.items.reduce((total, stats) => total + stats.runs, 0),
      failed: section.items.reduce((total, stats) => total + stats.failed, 0),
      usageLimited: section.items.reduce((total, stats) => total + stats.usageLimited, 0),
      costUsd: section.items.reduce((total, stats) => total + stats.costUsd, 0),
      unpricedRuns: section.items.reduce((total, stats) => total + stats.unpricedRuns, 0),
    }))
    .sort((left, right) =>
      left.key === null
        ? 1
        : right.key === null
          ? -1
          : right.costUsd - left.costUsd || right.runs - left.runs,
    );
}

const STATS_STEP_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** The last 24 hours, moved in 5-minute steps so a query keeps its key between steps. */
export function scheduledTaskLastDayStatsInput(nowMs: number): { readonly since: string } {
  const sinceMs = Math.floor(nowMs / STATS_STEP_MS) * STATS_STEP_MS - DAY_MS;
  return { since: DateTime.formatIso(DateTime.makeUnsafe(sinceMs)) };
}

/** Midnight at the start of `day` (YYYY-MM-DD) in `timeZone`; null for a bad day or zone. */
function zonedDayStart(day: string, timeZone: string): DateTime.Zoned | null {
  const [year = Number.NaN, month = Number.NaN, date = Number.NaN] = day
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  return Option.getOrNull(
    DateTime.makeZoned({ year, month, day: date }, { timeZone, adjustForTimeZone: true }),
  );
}

export interface ScheduledTaskStatsWindow {
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly timeZone: string;
  readonly sinceTime?: string | undefined;
  readonly untilTime?: string | undefined;
}

/**
 * The stats range for a Usage window: its exact times when it has them (hourly windows), else
 * midnight of its first day to midnight after its last day, in the window's time zone.
 */
export function scheduledTaskStatsRange(window: ScheduledTaskStatsWindow): {
  readonly since: string;
  readonly until: string;
} | null {
  if (window.sinceTime !== undefined && window.untilTime !== undefined) {
    return { since: window.sinceTime, until: window.untilTime };
  }
  const lastDay = DateTime.make(`${window.untilDay}T00:00:00Z`);
  const since = zonedDayStart(window.sinceDay, window.timeZone);
  const until = Option.isNone(lastDay)
    ? null
    : zonedDayStart(
        DateTime.formatIsoDateUtc(DateTime.add(lastDay.value, { days: 1 })),
        window.timeZone,
      );
  return since === null || until === null
    ? null
    : { since: DateTime.formatIso(since), until: DateTime.formatIso(until) };
}
