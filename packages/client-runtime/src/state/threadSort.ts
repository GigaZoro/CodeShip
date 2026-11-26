import { getFormattingLocale, msg } from "@t3tools/shared/i18n";
import * as Schema from "effect/Schema";

import type { ProjectId } from "@t3tools/contracts";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import {
  generateSpreadPinOrderKeys,
  LEADING_ORDER_TIER,
  pinOrderKeyBetween,
} from "@t3tools/shared/pinOrderKey";
import { scopedThreadKey } from "../environment/scoped.ts";
import type { EnvironmentThreadShell } from "./models.ts";

export const ThreadListSort = Schema.Literals(["default", "last-activity", "created", "name"]);
export type ThreadListSort = typeof ThreadListSort.Type;

export const THREAD_LIST_SORT_LABELS = {
  default: msg("Default"),
  "last-activity": msg("Last activity"),
  created: msg("Created"),
  name: msg("Name"),
} as const;

export type ThreadLastActivityOrder = ReadonlyMap<string, number>;

export function threadActivityKey(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) {
  return scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id });
}

export function sortThreadList<
  T extends Pick<
    EnvironmentThreadShell,
    "id" | "environmentId" | "title" | "createdAt" | "updatedAt"
  >,
>(
  threads: readonly T[],
  sort: Exclude<ThreadListSort, "default">,
  lastActivityOrder?: ThreadLastActivityOrder,
): T[] {
  const compareIdentity = (left: T, right: T) =>
    left.id.localeCompare(right.id, "en") ||
    left.environmentId.localeCompare(right.environmentId, "en");
  if (sort === "name") {
    const collator = new Intl.Collator(getFormattingLocale(), {
      sensitivity: "base",
      numeric: true,
    });
    return [...threads].sort(
      (left, right) => collator.compare(left.title, right.title) || compareIdentity(left, right),
    );
  }
  return threads
    .map((thread) => ({
      thread,
      rank:
        sort === "last-activity"
          ? (lastActivityOrder?.get(threadActivityKey(thread)) ?? Infinity)
          : Infinity,
      timestamp: Date.parse(sort === "created" ? thread.createdAt : thread.updatedAt),
    }))
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        (Number.isFinite(right.timestamp) ? right.timestamp : -Infinity) -
          (Number.isFinite(left.timestamp) ? left.timestamp : -Infinity) ||
        compareIdentity(left.thread, right.thread),
    )
    .map(({ thread }) => thread);
}

export { generateSpreadPinOrderKeys, pinOrderKeyBetween } from "@t3tools/shared/pinOrderKey";

export interface ThreadSortInput {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestUserMessageAt?: string | null;
  readonly latestUserAuthoredMessageAt?: string | null;
  readonly messages?: ReadonlyArray<{
    readonly createdAt: string;
    readonly role: string;
  }>;
}

export function toSortableTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export type SettledThreadTimestampInput = Pick<
  EnvironmentThreadShell,
  "settledAt" | "latestUserMessageAt" | "latestRun" | "updatedAt"
>;

export function resolveSettledThreadTimestamp(thread: SettledThreadTimestampInput): string | null {
  if (thread.settledAt != null && toSortableTimestamp(thread.settledAt) !== null) {
    return thread.settledAt;
  }
  return resolveThreadActivityTimestamp(thread);
}

export function resolveThreadActivityTimestamp(
  thread: Pick<EnvironmentThreadShell, "latestUserMessageAt" | "latestRun" | "updatedAt">,
): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of [
    thread.latestUserMessageAt,
    thread.latestRun?.requestedAt,
    thread.latestRun?.startedAt,
    thread.latestRun?.completedAt,
  ]) {
    const parsed = toSortableTimestamp(candidate ?? undefined);
    if (candidate != null && parsed !== null && parsed > latestMs) {
      latest = candidate;
      latestMs = parsed;
    }
  }
  if (latest !== null) return latest;
  return toSortableTimestamp(thread.updatedAt) === null ? null : thread.updatedAt;
}

export function sortSettledThreads<T extends SettledThreadTimestampInput & { readonly id: string }>(
  threads: readonly T[],
): T[] {
  return threads
    .map((thread) => {
      const timestamp = resolveSettledThreadTimestamp(thread);
      return { thread, timestampMs: timestamp === null ? 0 : Date.parse(timestamp) };
    })
    .sort(
      (left, right) =>
        right.timestampMs - left.timestampMs ||
        // Plain order, as the server pages ties (ids mix upper and lower case).
        (left.thread.id < right.thread.id ? -1 : left.thread.id > right.thread.id ? 1 : 0),
    )
    .map(({ thread }) => thread);
}

function getFirstSortableTimestamp(...values: Array<string | null | undefined>): number | null {
  for (const value of values) {
    const timestamp = toSortableTimestamp(value ?? undefined);
    if (timestamp !== null) {
      return timestamp;
    }
  }

  return null;
}

function getLatestUserMessageTimestamp(thread: ThreadSortInput): number {
  // Agents also post in the user role; only what the user wrote counts. A thread
  // the user never wrote in counts from its creation; older servers omit the field.
  if (thread.latestUserAuthoredMessageAt !== undefined) {
    return (
      getFirstSortableTimestamp(
        thread.latestUserAuthoredMessageAt,
        thread.createdAt,
        thread.updatedAt,
      ) ?? Number.NEGATIVE_INFINITY
    );
  }

  if (thread.latestUserMessageAt) {
    const latestUserMessageTimestamp = toSortableTimestamp(thread.latestUserMessageAt);
    if (latestUserMessageTimestamp !== null) {
      return latestUserMessageTimestamp;
    }
  }

  let latestUserMessageTimestamp: number | null = null;

  for (const message of thread.messages ?? []) {
    if (message.role !== "user") continue;
    const messageTimestamp = toSortableTimestamp(message.createdAt);
    if (messageTimestamp === null) continue;
    latestUserMessageTimestamp =
      latestUserMessageTimestamp === null
        ? messageTimestamp
        : Math.max(latestUserMessageTimestamp, messageTimestamp);
  }

  if (latestUserMessageTimestamp !== null) {
    return latestUserMessageTimestamp;
  }

  return getFirstSortableTimestamp(thread.updatedAt, thread.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function getThreadSortTimestamp(
  thread: ThreadSortInput,
  sortOrder: SidebarThreadSortOrder,
): number {
  if (sortOrder === "created_at") {
    return (
      getFirstSortableTimestamp(thread.createdAt, thread.updatedAt) ?? Number.NEGATIVE_INFINITY
    );
  }
  return getLatestUserMessageTimestamp(thread);
}

function activeThreadAnchorTimestampMs(thread: {
  readonly createdAt: string;
  readonly unsettledAt?: string | null | undefined;
}): number {
  return Math.max(
    toSortableTimestamp(thread.createdAt) ?? 0,
    toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
  );
}

export function sortThreads<T extends { readonly id: string } & ThreadSortInput>(
  threads: readonly T[],
  sortOrder: SidebarThreadSortOrder,
): T[] {
  if (threads.length < 2) return [...threads];
  return threads
    .map((thread) => ({ thread, timestamp: getThreadSortTimestamp(thread, sortOrder) }))
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp ||
        (left.thread.id < right.thread.id ? 1 : left.thread.id > right.thread.id ? -1 : 0),
    )
    .map(({ thread }) => thread);
}

export function getLatestThreadForProject<
  T extends {
    readonly id: string;
    readonly projectId: ProjectId;
    readonly archivedAt: string | null;
  } & ThreadSortInput,
>(threads: readonly T[], projectId: ProjectId, sortOrder: SidebarThreadSortOrder): T | null {
  let latest: T | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  for (const thread of threads) {
    if (thread.projectId !== projectId || thread.archivedAt !== null) continue;
    const timestamp = getThreadSortTimestamp(thread, sortOrder);
    if (
      latest === null ||
      timestamp > latestTimestamp ||
      (timestamp === latestTimestamp && thread.id > latest.id)
    ) {
      latest = thread;
      latestTimestamp = timestamp;
    }
  }
  return latest;
}

/** Keys that put `count` new pins at the top of the shelf, first to last. A head key with no
    room above it, such as an imported `a0`, rekeys the whole shelf in its current order. */
export function planPinsAtTop<
  T extends { readonly pinOrderKey?: string | null | undefined },
>(input: {
  /** Every pinned thread, in shelf order. */
  readonly shelf: ReadonlyArray<T>;
  readonly count: number;
}): {
  readonly pinKeys: ReadonlyArray<string>;
  readonly rekeyed: ReadonlyArray<{ readonly thread: T; readonly orderKey: string }>;
} {
  const pinKeys: string[] = [];
  let bound = input.shelf[0]?.pinOrderKey ?? null;
  while (pinKeys.length < input.count) {
    const key = pinOrderKeyBetween(null, bound);
    if (key === null) break;
    pinKeys.unshift(key);
    bound = key;
  }
  if (pinKeys.length === input.count) return { pinKeys, rekeyed: [] };
  const keys = generateSpreadPinOrderKeys(input.count + input.shelf.length);
  return {
    pinKeys: keys.slice(0, input.count),
    rekeyed: input.shelf.flatMap((thread, index) => {
      const orderKey = keys[input.count + index]!;
      return thread.pinOrderKey === orderKey ? [] : [{ thread, orderKey }];
    }),
  };
}

export function planPinnedReorder(input: {
  readonly orderedIds: readonly string[];
  /** Include retained keys from hidden rows; only orderedIds receive writes. */
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly movedId: string;
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> {
  const { orderedIds, keysById, movedId } = input;
  const visibleIds = new Set(orderedIds);
  const reservedKeys = new Set(
    [...keysById].flatMap(([id, key]) => (!visibleIds.has(id) && key != null ? [key] : [])),
  );
  const movedIndex = orderedIds.indexOf(movedId);
  if (movedIndex === -1) return [];
  const beforeId = movedIndex > 0 ? orderedIds[movedIndex - 1] : null;
  const afterId = movedIndex < orderedIds.length - 1 ? orderedIds[movedIndex + 1] : null;
  const beforeKey = beforeId != null ? (keysById.get(beforeId) ?? null) : null;
  const afterKey = afterId != null ? (keysById.get(afterId) ?? null) : null;
  const beforeUsable = beforeId === null || beforeKey != null;
  const afterUsable = afterId === null || afterKey != null;
  if (beforeUsable && afterUsable) {
    let key = pinOrderKeyBetween(beforeKey, afterKey);
    while (key !== null && reservedKeys.has(key)) key = pinOrderKeyBetween(key, afterKey);
    if (key !== null) return [{ id: movedId, orderKey: key }];
  }
  const keys = generateSpreadPinOrderKeys(orderedIds.length + reservedKeys.size)
    .filter((key) => !reservedKeys.has(key))
    .slice(0, orderedIds.length);
  return orderedIds.flatMap((id, index) => {
    const key = keys[index]!;
    return keysById.get(id) === key ? [] : [{ id, orderKey: key }];
  });
}

export function sortPinnedThreadsByOrderKey<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly pinOrderKey?: string | null | undefined;
    /** Thread ids are only unique within an environment, and the pinned
        block merges environments — the tiebreak needs both parts or two
        clients could render equal-key threads in stream-arrival order. */
    readonly environmentId?: string | undefined;
  },
>(threads: readonly T[]): T[] {
  if (threads.length < 2) return [...threads];
  const keyed: T[] = [];
  const keyless: T[] = [];
  for (const thread of threads) {
    (thread.pinOrderKey != null ? keyed : keyless).push(thread);
  }
  const identityTiebreak = (left: T, right: T) =>
    left.id.localeCompare(right.id) ||
    (left.environmentId ?? "").localeCompare(right.environmentId ?? "");
  keyed.sort((left, right) => {
    const leftKey = left.pinOrderKey!;
    const rightKey = right.pinOrderKey!;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : identityTiebreak(left, right);
  });
  const timestamps = new Map(
    keyless.map((thread) => [thread, toSortableTimestamp(thread.createdAt) ?? 0]),
  );
  keyless.sort(
    (left, right) =>
      timestamps.get(right)! - timestamps.get(left)! || identityTiebreak(left, right),
  );
  return [...keyed, ...keyless];
}

const IMPLIED_KEY_WIDTH = 10;
const IMPLIED_KEY_MAX_MS = 26 ** IMPLIED_KEY_WIDTH - 1;

/**
 * Sort key for the Active section. A thread nobody arranged takes an implied key from its
 * anchor time, newest first, in a tier ahead of every arranged key. A move then only writes
 * the moved thread, even beside threads whose server is offline.
 */
export function activeThreadSortKey(thread: {
  readonly createdAt: string;
  readonly unsettledAt?: string | null | undefined;
  readonly activeOrderKey?: string | null | undefined;
}): string {
  if (thread.activeOrderKey != null) return thread.activeOrderKey;
  let value =
    IMPLIED_KEY_MAX_MS -
    Math.min(Math.max(activeThreadAnchorTimestampMs(thread), 0), IMPLIED_KEY_MAX_MS);
  let digits = "";
  for (let index = 0; index < IMPLIED_KEY_WIDTH; index += 1) {
    digits = String.fromCharCode(97 + (value % 26)) + digits;
    value = Math.floor(value / 26);
  }
  // A trailing "a" leaves no room to place a thread directly above this one.
  return `${LEADING_ORDER_TIER}${digits}n`;
}

export function sortActiveThreadsByOrderKey<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly unsettledAt?: string | null | undefined;
    readonly activeOrderKey?: string | null | undefined;
    readonly environmentId?: string | undefined;
  },
>(threads: readonly T[]): T[] {
  if (threads.length < 2) return [...threads];
  const keys = new Map(threads.map((thread) => [thread, activeThreadSortKey(thread)]));
  return [...threads].sort((left, right) => {
    const leftKey = keys.get(left)!;
    const rightKey = keys.get(right)!;
    return (
      (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0) ||
      left.id.localeCompare(right.id) ||
      (left.environmentId ?? "").localeCompare(right.environmentId ?? "")
    );
  });
}
