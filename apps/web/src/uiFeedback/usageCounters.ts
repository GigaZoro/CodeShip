import * as Schema from "effect/Schema";

import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "../hooks/useLocalStorage";

export const USAGE_COUNTERS_STORAGE_KEY = "t3code:ui-feedback:counters:v1";
const STORAGE_KEY = USAGE_COUNTERS_STORAGE_KEY;
/** Bounds storage: a new key past this cap is dropped, existing keys keep counting. */
const MAX_USAGE_COUNTER_KEYS = 400;
const FLUSH_DELAY_MS = 2_000;

const UsageCountersDocument = Schema.Struct({
  since: Schema.String,
  counts: Schema.Record(Schema.String, Schema.Number),
});
export type UsageCounters = typeof UsageCountersDocument.Type;

export function incrementUsageCount(
  counters: UsageCounters,
  key: string,
  maxKeys = MAX_USAGE_COUNTER_KEYS,
): UsageCounters {
  const current = counters.counts[key];
  if (current === undefined && Object.keys(counters.counts).length >= maxKeys) return counters;
  return { since: counters.since, counts: { ...counters.counts, [key]: (current ?? 0) + 1 } };
}

let state: UsageCounters | null = null;
/** Clicks not yet saved. Added to what is stored at flush time, so tabs do not overwrite each other. */
let unsaved = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emptyCounters(): UsageCounters {
  return { since: new Date().toISOString(), counts: {} };
}

function readStored(): UsageCounters | null {
  try {
    return getLocalStorageItem(STORAGE_KEY, UsageCountersDocument);
  } catch (cause) {
    console.warn("Could not read UI usage counters; starting over.", cause);
    return null;
  }
}

function load(): UsageCounters {
  state ??= readStored() ?? emptyCounters();
  return state;
}

function publish(next: UsageCounters): void {
  state = next;
  for (const listener of listeners) listener();
}

function flush(): void {
  flushTimer = null;
  if (unsaved.size === 0) return;
  // Nothing stored means another tab cleared the counters, so this tab's older counts go too.
  let merged = readStored() ?? emptyCounters();
  for (const [key, clicks] of unsaved) {
    for (let click = 0; click < clicks; click += 1) merged = incrementUsageCount(merged, key);
  }
  unsaved = new Map();
  try {
    setLocalStorageItem(STORAGE_KEY, merged, UsageCountersDocument);
  } catch (cause) {
    console.warn("Could not save UI usage counters.", cause);
  }
  publish(merged);
}

export function recordUsage(key: string): void {
  const current = load();
  const next = incrementUsageCount(current, key);
  if (next === current) return;
  unsaved.set(key, (unsaved.get(key) ?? 0) + 1);
  publish(next);
  flushTimer ??= setTimeout(flush, FLUSH_DELAY_MS);
}

/** Writes pending counts now; call when the page is hidden so a quit keeps them. */
export function flushUsageCounters(): void {
  if (flushTimer === null) return;
  clearTimeout(flushTimer);
  flush();
}

/** Saves this tab's clicks, then returns the counts every tab saved; for exports, not rendering. */
export function syncUsageCounters(): UsageCounters {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flush();
  const saved = readStored() ?? emptyCounters();
  publish(saved);
  return saved;
}

export function readUsageCounters(): UsageCounters {
  return load();
}

export function clearUsageCounters(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  unsaved = new Map();
  try {
    removeLocalStorageItem(STORAGE_KEY);
  } catch (cause) {
    console.warn("Could not clear UI usage counters.", cause);
  }
  publish(emptyCounters());
}

export function subscribeUsageCounters(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
