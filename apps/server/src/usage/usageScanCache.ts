import type { UsageProviderKind } from "@t3tools/contracts";
import type {
  TranscriptUsageFormat,
  UsageRecord,
  UsageSpeed,
} from "@t3tools/provider-core/server/usage";
import * as Schema from "effect/Schema";

import { CLAUDE_SYNTHETIC_MODEL } from "../provider/Drivers/claudeUsage.ts";
import {
  canRetainUsageRecord,
  makeUsageRetentionMatcher,
  supportsUsageRetention,
} from "./usageRetentionIdentity.ts";
import { GUARD_LENGTH, type TranscriptParsePosition } from "./usageTranscriptReader.ts";

export const USAGE_SCAN_CACHE_VERSION = 12 as const;
const SPEED_COMPATIBLE_SINCE_VERSION = 4;

/**
 * Snapshots here are written once and never changed, so processes sharing a state directory need
 * no lock. A save holds the rows changed since its writer's last save; only a full save, which
 * holds every live row, deletes what it covers. A newer format only reads these: a running
 * writer's later saves hold just the rows they changed and need its earlier snapshots beside them.
 */
export const PREVIOUS_SCAN_CACHE_DIRECTORY_NAME = "usage-scan-cache-v11";
export const SCAN_CACHE_DIRECTORY_NAME = `usage-scan-cache-v${USAGE_SCAN_CACHE_VERSION}`;
/** Single-file caches of older builds, which a sync moves into the store as legacy inputs. */
const LEGACY_SCAN_CACHE_FILE_NAMES = [
  "usage-scan-cache-v10.json",
  "usage-scan-cache-v9.json",
  "usage-scan-cache-v8.json",
  "usage-scan-cache-v7.json",
  "usage-scan-cache-v6.json",
  "usage-scan-cache-v5.json",
  "usage-scan-cache.json",
] as const;

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SNAPSHOT_NAME = new RegExp(`^${UUID_PATTERN}-\\d+\\.json$`);
const CLAIMED_LEGACY_NAME = new RegExp(`^legacy-${UUID_PATTERN}-(.+)$`);

export const isLegacyScanCacheFileName = (name: string): boolean =>
  (LEGACY_SCAN_CACHE_FILE_NAMES as readonly string[]).includes(name);
export const scanCacheSnapshotName = (writerId: string, seq: number) => `${writerId}-${seq}.json`;
export const claimedLegacyScanCacheName = (claimId: string, legacyName: string) =>
  `legacy-${claimId}-${legacyName}`;
/** Temporary files of an atomic write never match, so a sync cannot read a half-written file. */
export function isScanCacheInput(name: string): boolean {
  if (SNAPSHOT_NAME.test(name)) return true;
  const legacyName = CLAIMED_LEGACY_NAME.exec(name)?.[1];
  return legacyName !== undefined && isLegacyScanCacheFileName(legacyName);
}

const SPEEDS: readonly UsageSpeed[] = ["standard", "fast", "ultrafast"];

/** A record the file at a path held until a read found a version without it. */
interface SupersededRecord {
  readonly record: KeyedUsageRecord;
  /** Latest observation of the path that still held the record. */
  readonly seenMs: number;
  /** Observation after seenMs that found it gone; its retention counts from here. */
  readonly sinceMs: number;
  /** Groups of potentially overlapping native keys proved distinct by one version of the file. */
  readonly readGroups?: readonly string[];
}

type KeyedUsageRecord = UsageRecord & { readonly dedupeKey: string };
type PriorRead = number | readonly [time: number, size: number];
type PeerTail = Omit<SupersededRecord, "sinceMs"> & { readonly size: number };

export interface CachedFile {
  readonly size: number;
  readonly needsReparse?: true;
  /** Decoded from an older format: it loses to a current row observed at the same time. */
  readonly legacy?: true;
  readonly mtimeMs: number;
  /** Wall-clock time a scan stored this row, compared across processes when rows meet. */
  readonly observedAtMs: number;
  /** Wall-clock time the service first found the file gone; its retention counts from here. */
  readonly missingSinceMs?: number;
  /** Wall-clock time a listing last found the file back after it went missing. */
  readonly presentSinceMs?: number;
  readonly provider: UsageProviderKind;
  readonly records: readonly UsageRecord[];
  /** Unterminated tail records stay separate because incremental parsing rereads them. */
  readonly tailRecords: readonly UsageRecord[];
  /** Whole-file count, including diagnostics from the tentative tail. */
  readonly malformedRecords: number;
  readonly position: TranscriptParsePosition;
  /**
   * Keyed records earlier versions of the file held that this one lacks, sorted by key. Only a
   * qualifying provider identity can distinguish a displaced call from the current contents.
   */
  readonly superseded?: readonly SupersededRecord[];
  /** Earlier observations date replacement and prove truncation of a peer's final line. */
  readonly priorReads?: readonly PriorRead[];
  /** A peer may report the intervening shorter version after we discard its old row. */
  readonly peerTails?: readonly PeerTail[];
  /** Most recent expired read. A peer's earlier sighting cannot revive history absent by this read. */
  readonly expiredThroughMs?: number;
  /** The last read by a different provider invalidates earlier identities for this path. */
  readonly otherProviderAtMs?: number;
}

export type ScanCache = Map<string, CachedFile>;

export interface CachedSource {
  readonly dir: string;
  readonly volumeId: string;
  /** Wall-clock time a scan recorded this directory or its volume. */
  readonly seenAtMs?: number;
}

const isCurrentRow = (entry: CachedFile) => entry.legacy === undefined && !entry.needsReparse;

const unresolvedTurns = (entry: CachedFile) => {
  const turns: string[] = [];
  for (const records of [entry.records, entry.tailRecords]) {
    for (const { unresolvedServiceTierTurnId: turn } of records) {
      if (turn !== undefined) turns.push(turn);
    }
  }
  return turns;
};

/**
 * Every place rows for one transcript meet uses this order, so any merge order of the same
 * snapshots gives the same rows: the later observation, then a current-format row, then the
 * larger file, then fewer unresolved speed tiers (resolving one keeps the read time), then the
 * lower list of unresolved turns. Equal-time rewrites use their contents as a final tiebreak.
 */
function pickScanEntry(held: CachedFile, incoming: CachedFile): CachedFile | undefined {
  if (incoming.observedAtMs !== held.observedAtMs) {
    return incoming.observedAtMs > held.observedAtMs ? incoming : held;
  }
  const heldCurrent = isCurrentRow(held);
  if (heldCurrent !== isCurrentRow(incoming)) return heldCurrent ? held : incoming;
  if (incoming.size !== held.size) return incoming.size > held.size ? incoming : held;
  const heldTurns = unresolvedTurns(held);
  const incomingTurns = unresolvedTurns(incoming);
  if (incomingTurns.length !== heldTurns.length) {
    return incomingTurns.length < heldTurns.length ? incoming : held;
  }
  const left = JSON.stringify(heldTurns);
  const right = JSON.stringify(incomingTurns);
  if (left !== right) return right < left ? incoming : held;
  // Tied older snapshots cannot cancel a required live reparse recorded during migration.
  if (held.needsReparse !== incoming.needsReparse) return held.needsReparse ? held : incoming;
  const fileInfo = (entry: CachedFile) =>
    JSON.stringify([
      entry.provider,
      entry.mtimeMs,
      entry.legacy,
      entry.malformedRecords,
      entry.position.resumeOffset,
      entry.position.guardLength,
      entry.position.guardHash,
      entry.position.state,
    ]);
  const heldInfo = fileInfo(held);
  const incomingInfo = fileInfo(incoming);
  if (heldInfo !== incomingInfo) return incomingInfo < heldInfo ? incoming : held;
  for (const field of ["records", "tailRecords"] as const) {
    const a = held[field];
    const b = incoming[field];
    if (a === b) continue;
    if (a.length !== b.length) return b.length > a.length ? incoming : held;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (!sameRecord(a[i]!, b[i]!))
        return recordIdentity(b[i]!) < recordIdentity(a[i]!) ? incoming : held;
    }
  }
  return undefined;
}

const latest = (...times: readonly (number | undefined)[]) => {
  const known = times.filter((time) => time !== undefined);
  return known.length === 0 ? undefined : Math.max(...known);
};

function sameRecord(a: UsageRecord, b: UsageRecord) {
  return (
    a.dedupeKey === b.dedupeKey &&
    a.timestampMs === b.timestampMs &&
    a.model === b.model &&
    a.rateModel === b.rateModel &&
    a.sessionId === b.sessionId &&
    a.reportedCostUsd === b.reportedCostUsd &&
    a.speed === b.speed &&
    a.unresolvedServiceTierTurnId === b.unresolvedServiceTierTurnId &&
    a.totals.uncachedInputTokens === b.totals.uncachedInputTokens &&
    a.totals.cachedInputTokens === b.totals.cachedInputTokens &&
    a.totals.cacheCreationTokens === b.totals.cacheCreationTokens &&
    a.totals.outputTokens === b.totals.outputTokens &&
    a.totals.reasoningTokens === b.totals.reasoningTokens
  );
}

const recordIdentity = (record: UsageRecord) =>
  JSON.stringify([
    record.dedupeKey,
    record.timestampMs,
    record.model,
    record.rateModel ?? null,
    record.sessionId,
    record.totals.uncachedInputTokens,
    record.totals.cachedInputTokens,
    record.totals.cacheCreationTokens,
    record.totals.outputTokens,
    record.totals.reasoningTokens,
    record.reportedCostUsd,
    record.speed,
    record.unresolvedServiceTierTurnId ?? null,
  ]);

const readTime = (read: PriorRead) => (typeof read === "number" ? read : read[0]);
const readSize = (read: PriorRead) => (typeof read === "number" ? undefined : read[1]);
const isPriorRead = (value: unknown): value is PriorRead =>
  (typeof value === "number" && Number.isFinite(value)) ||
  (Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    Number.isSafeInteger(value[1]) &&
    value[1] >= 0);

function firstReadAfter(priorReads: readonly PriorRead[], seenMs: number, lastRead: PriorRead) {
  let low = 0;
  let high = priorReads.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (readTime(priorReads[mid]!) <= seenMs) low = mid + 1;
    else high = mid;
  }
  return priorReads[low] ?? lastRead;
}

function mergePriorReads(winner: CachedFile, loser: CachedFile, minimum: number) {
  const oldReads = loser.priorReads ?? [];
  if (
    winner.priorReads === undefined &&
    winner.provider === loser.provider &&
    loser.observedAtMs < winner.observedAtMs &&
    readTime(oldReads[0] ?? loser.observedAtMs) > minimum
  ) {
    return [...oldReads, [loser.observedAtMs, loser.size] as const];
  }
  const times = new Map(winner.priorReads?.map((read) => [readTime(read), read]));
  const add = (read: PriorRead) => {
    const time = readTime(read);
    const held = times.get(time);
    if (held === undefined || (readSize(read) ?? -1) > (readSize(held) ?? -1)) {
      times.set(time, read);
    }
  };
  if (winner.provider === loser.provider) {
    for (const read of oldReads) add(read);
    add([loser.observedAtMs, loser.size]);
  }
  return [...times.values()]
    .filter((read) => readTime(read) > minimum && readTime(read) < winner.observedAtMs)
    .sort((a, b) => readTime(a) - readTime(b));
}

function sameItems<T>(own: readonly T[] | undefined, next: readonly T[]) {
  return (own?.length ?? 0) === next.length && next.every((item, index) => item === own?.[index]);
}

type ReadGroups = { keys: Set<string>; groups: readonly string[] };
const committedReadGroups = new WeakMap<CachedFile, ReadGroups>();
const readGroupsWithTail = new WeakMap<CachedFile, ReadGroups>();

function readGroupsOf(entry: CachedFile, key: string, includeTail = false): readonly string[] {
  // A tentative tail can witness coexistence only once its replacement is confirmed.
  const useTail = includeTail && entry.tailRecords.length > 0;
  const cache = useTail ? readGroupsWithTail : committedReadGroups;
  let cached = cache.get(entry);
  if (cached === undefined) {
    const keys = new Set<string>();
    const records = (useTail ? [...entry.records, ...entry.tailRecords] : entry.records).filter(
      canRetainUsageRecord,
    );
    // Index both directions so each ambiguous call sees its sibling without comparing every pair.
    for (let pass = 0; pass < 2 && records.length > 1; pass++) {
      const matcher = makeUsageRetentionMatcher(entry.provider, []);
      for (const record of records) {
        if (matcher.matches(record)) keys.add(record.dedupeKey);
        matcher.add(record);
      }
      records.reverse();
    }
    cached = { keys, groups: keys.size > 1 ? [JSON.stringify([...keys].sort())] : [] };
    cache.set(entry, cached);
  }
  return cached.keys.has(key) ? cached.groups : [];
}

function groupMembers(group: string): readonly string[] | undefined {
  if (!group.startsWith("[")) return undefined;
  try {
    const keys: unknown = JSON.parse(group);
    if (isRecordArray(keys) && keys.length > 1 && keys.every((key) => typeof key === "string"))
      return keys;
  } catch {
    return undefined;
  }
}

function mergePeerTails(
  winner: CachedFile,
  loser: CachedFile,
  floor: number,
  otherProviderAtMs: number | undefined,
  peer: boolean,
) {
  const loseTail = peer && loser.tailRecords.length > 0;
  if (!winner.peerTails && !loser.peerTails && !loseTail) return [];
  const candidates = new Map<string, PeerTail>();
  function add(item: PeerTail) {
    if (item.seenMs < floor || item.seenMs <= (otherProviderAtMs ?? -Infinity)) return;
    const id = JSON.stringify([item.seenMs, item.record.dedupeKey, item.readGroups ?? []]);
    const held = candidates.get(id);
    if (
      held === undefined ||
      item.size > held.size ||
      (item.size === held.size && recordIdentity(item.record) < recordIdentity(held.record))
    )
      candidates.set(id, item);
  }
  for (const item of winner.peerTails ?? []) add(item);
  if (winner.provider === loser.provider) {
    for (const item of loser.peerTails ?? []) add(item);
    if (loseTail) {
      for (const record of loser.tailRecords) {
        if (!canRetainUsageRecord(record)) continue;
        const readGroups = readGroupsOf(loser, record.dedupeKey, true);
        add({
          record,
          seenMs: loser.observedAtMs,
          size: loser.size,
          ...(readGroups.length ? { readGroups } : {}),
        });
      }
    }
  }
  return [...candidates.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, item]) => item);
}

function provedTailReplacement(entry: CachedFile, tail: PeerTail) {
  const next = firstReadAfter(entry.priorReads ?? [], tail.seenMs, [
    entry.observedAtMs,
    entry.size,
  ]);
  return readTime(next) > tail.seenMs && (readSize(next) ?? Infinity) < tail.size
    ? readTime(next)
    : undefined;
}

function provedPeerTails(entry: CachedFile, throughMs = Infinity): readonly SupersededRecord[] {
  return (
    entry.peerTails?.flatMap((tail) => {
      const sinceMs = provedTailReplacement(entry, tail);
      if (sinceMs === undefined || sinceMs > throughMs) return [];
      const { size: _size, ...record } = tail;
      return [{ ...record, sinceMs }];
    }) ?? []
  );
}

interface ReadEvidence {
  /** Only the original parsed row proves the committed prefix survived a verified append. */
  readonly retainedPrefix?: CachedFile;
  readonly liveKeys?: ReadonlySet<string>;
}

function collectHistory(
  winner: CachedFile,
  priorReads: readonly PriorRead[] = winner.priorReads ?? [],
  floor = winner.expiredThroughMs ?? -Infinity,
  otherProviderAtMs = winner.otherProviderAtMs,
  liveKeys?: ReadonlySet<string>,
) {
  const members = new Map<string, Set<string>>();
  const covered = new Map<string, Map<string, boolean>>();
  function keysOf(group: string) {
    let keys = members.get(group);
    if (!keys) {
      keys = new Set(groupMembers(group));
      members.set(group, keys);
    }
    return keys;
  }
  function covers(group: string, other: string) {
    if (group === other) return true;
    let tested = covered.get(group);
    if (!tested) {
      tested = new Map();
      covered.set(group, tested);
    }
    const known = tested.get(other);
    if (known !== undefined) return known;
    const small = keysOf(other);
    const large = keysOf(group);
    const contains =
      small.size > 0 && large.size > small.size && [...small].every((key) => large.has(key));
    tested.set(other, contains);
    return contains;
  }
  const retained = new Map<string, SupersededRecord>();
  let simultaneousRecords: Map<string | null, UsageRecord> | undefined;
  const tailKeys = new Set(winner.tailRecords.map((record) => record.dedupeKey));
  function consider(
    record: KeyedUsageRecord,
    seenMs: number,
    sinceMs: number,
    source: CachedFile | SupersededRecord,
    includeTail = false,
  ) {
    if (seenMs < floor || seenMs <= (otherProviderAtMs ?? -Infinity)) return;
    liveKeys ??= new Set(
      winner.records.map((live) => live.dedupeKey).filter((key) => key !== null),
    );
    const key = record.dedupeKey;
    const liveCommitted = liveKeys.has(key) && !tailKeys.has(key);
    let original = "record" in source ? source : undefined;
    let groups =
      "record" in source ? (source.readGroups ?? []) : readGroupsOf(source, key, includeTail);
    if (liveCommitted) {
      // A surviving exact key can still witness that a missing sibling was a different call.
      if (groups.length)
        groups = groups.filter(
          (group) => !readGroupsOf(winner, key).some((own) => covers(own, group)),
        );
      if (seenMs !== winner.observedAtMs && groups.length === 0) return;
      simultaneousRecords ??= new Map(winner.records.map((live) => [live.dedupeKey, live]));
      const live = simultaneousRecords.get(key);
      if (
        live &&
        canRetainUsageRecord(live) &&
        (seenMs !== winner.observedAtMs ||
          sameRecord(live, record) ||
          recordIdentity(live) <= recordIdentity(record))
      ) {
        if (groups.length === 0) return;
        record = live;
        if (seenMs < winner.observedAtMs) {
          seenMs = winner.observedAtMs;
          sinceMs = seenMs;
        }
      }
    }
    const held = retained.get(key);
    sinceMs = Math.min(sinceMs, readTime(firstReadAfter(priorReads, seenMs, winner.observedAtMs)));
    if (held !== undefined) {
      if (held.readGroups?.length && !sameItems(held.readGroups, groups)) {
        const all = [...new Set([...groups, ...held.readGroups])].sort();
        groups = all.filter(
          (group) => !all.some((other) => other !== group && covers(other, group)),
        );
      }
      if (held.seenMs === seenMs) sinceMs = Math.min(sinceMs, held.sinceMs);
      if (
        held.seenMs > seenMs ||
        (held.seenMs === seenMs &&
          (sameRecord(held.record, record) ||
            recordIdentity(held.record) <= recordIdentity(record)))
      ) {
        if (held.seenMs > seenMs) sinceMs = held.sinceMs;
        seenMs = held.seenMs;
        record = held.record;
        original = held;
      }
    }
    retained.set(
      key,
      original?.record === record &&
        original.sinceMs === sinceMs &&
        sameItems(original.readGroups, groups)
        ? original
        : { record, seenMs, sinceMs, ...(groups.length ? { readGroups: groups } : {}) },
    );
  }
  function carryHistory(entry: CachedFile) {
    for (const item of entry.superseded ?? []) {
      // Concurrent sightings count as present until the next distinct read.
      const sinceMs = item.seenMs === entry.observedAtMs ? Infinity : item.sinceMs;
      consider(item.record, item.seenMs, sinceMs, item);
    }
  }
  carryHistory(winner);
  function sorted() {
    // A late peer may supply one member after only its sibling kept the proof they coexisted.
    const groups = new Set<string>();
    for (const item of retained.values()) {
      for (const group of item.readGroups ?? []) groups.add(group);
    }
    for (const group of groups) {
      for (const key of keysOf(group)) {
        const held = retained.get(key);
        if (held?.readGroups?.some((own) => covers(own, group))) continue;
        let source = held;
        if (source === undefined) {
          simultaneousRecords ??= new Map(
            winner.records.map((record) => [record.dedupeKey, record]),
          );
          const live = simultaneousRecords.get(key);
          if (!live || !canRetainUsageRecord(live)) continue;
          source = { record: live, seenMs: winner.observedAtMs, sinceMs: winner.observedAtMs };
        }
        consider(source.record, source.seenMs, source.sinceMs, { ...source, readGroups: [group] });
      }
    }
    return [...retained.values()].sort((a, b) =>
      a.record.dedupeKey < b.record.dedupeKey ? -1 : 1,
    );
  }
  return { consider, carryHistory, sorted };
}

function historyWithProvedTails(entry: CachedFile, proved: readonly SupersededRecord[]) {
  if (proved.length === 0) return entry.superseded ?? [];
  const history = collectHistory(entry);
  for (const item of proved) history.consider(item.record, item.seenMs, item.sinceMs, item);
  return history.sorted();
}

export function carrySuperseded(
  winner: CachedFile,
  loser: CachedFile,
  read?: ReadEvidence,
): CachedFile {
  if (loser === winner || !supportsUsageRetention(winner.provider)) return winner;
  const sameProvider = loser.provider === winner.provider;
  const otherProviderAtMs = latest(
    winner.otherProviderAtMs,
    sameProvider ? loser.otherProviderAtMs : loser.observedAtMs,
  );
  const expiredThroughMs = latest(
    winner.expiredThroughMs,
    sameProvider ? loser.expiredThroughMs : undefined,
  );
  const floor = expiredThroughMs ?? -Infinity;
  const priorReads = mergePriorReads(
    winner,
    loser,
    Math.max(floor, otherProviderAtMs ?? -Infinity),
  );
  const peerTails = mergePeerTails(winner, loser, floor, otherProviderAtMs, read === undefined);

  const { consider, carryHistory, sorted } = collectHistory(
    winner,
    priorReads,
    floor,
    otherProviderAtMs,
    read?.liveKeys,
  );
  if (sameProvider) carryHistory(loser);
  if (
    sameProvider &&
    read?.retainedPrefix !== loser &&
    loser.observedAtMs >= floor &&
    loser.observedAtMs > (otherProviderAtMs ?? -Infinity)
  ) {
    for (const record of loser.records) {
      if (canRetainUsageRecord(record)) consider(record, loser.observedAtMs, Infinity, loser);
    }
    // A local full re-read proves replacement immediately. Peer tails wait for size evidence.
    if (read !== undefined && read.retainedPrefix === undefined) {
      for (const record of loser.tailRecords) {
        if (canRetainUsageRecord(record))
          consider(record, loser.observedAtMs, Infinity, loser, true);
      }
    }
  }
  const superseded = sorted();
  if (
    sameItems(winner.superseded, superseded) &&
    sameItems(winner.priorReads, priorReads) &&
    sameItems(winner.peerTails, peerTails) &&
    winner.expiredThroughMs === expiredThroughMs &&
    winner.otherProviderAtMs === otherProviderAtMs
  )
    return winner;
  const { superseded: _old, priorReads: _times, peerTails: _tails, ...entry } = winner;
  return {
    ...entry,
    ...(superseded.length ? { superseded } : {}),
    ...(priorReads.length ? { priorReads } : {}),
    ...(peerTails.length ? { peerTails } : {}),
    ...(expiredThroughMs === undefined ? {} : { expiredThroughMs }),
    ...(otherProviderAtMs === undefined ? {} : { otherProviderAtMs }),
  };
}

/**
 * Presence says nothing about a file's contents, so it never picks the winning row. The winner
 * takes the latest missing time from a row read at the same time or found gone after its own
 * read, unless a listing found the file back after it: an earlier one is stale. A listing does
 * not change observedAtMs, so only the time it found the file back can show that.
 */
export function mergeScanEntry(held: CachedFile, incoming: CachedFile): CachedFile {
  if (held === incoming) return held;
  const picked = pickScanEntry(held, incoming);
  const winner =
    picked === undefined
      ? carrySuperseded(held, incoming, { retainedPrefix: incoming })
      : carrySuperseded(picked, picked === held ? incoming : held);
  const presentSinceMs = latest(held.presentSinceMs, incoming.presentSinceMs);
  const missingSinceMs = latest(
    ...[held, incoming].map(({ observedAtMs, missingSinceMs }) =>
      missingSinceMs !== undefined &&
      (observedAtMs === winner.observedAtMs || missingSinceMs > winner.observedAtMs) &&
      missingSinceMs > (presentSinceMs ?? -Infinity)
        ? missingSinceMs
        : undefined,
    ),
  );
  if (missingSinceMs === winner.missingSinceMs && presentSinceMs === winner.presentSinceMs) {
    return winner;
  }
  const { missingSinceMs: _missing, presentSinceMs: _present, ...contents } = winner;
  return {
    ...contents,
    ...(missingSinceMs === undefined ? {} : { missingSinceMs }),
    ...(presentSinceMs === undefined ? {} : { presentSinceMs }),
  };
}

export function mergeCachedSource(held: CachedSource, incoming: CachedSource): CachedSource {
  const incomingWins = (incoming.seenAtMs ?? -Infinity) > (held.seenAtMs ?? -Infinity);
  const [winner, other] = incomingWins ? [incoming, held] : [held, incoming];
  if (winner.volumeId !== "" || other.volumeId === "" || other.dir !== winner.dir) return winner;
  return { ...winner, volumeId: other.volumeId };
}

type SerializedRecord = readonly [
  timestampMs: number,
  modelIndex: number,
  sessionIndex: number,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  dedupeKey: string | null,
  reportedCostUsd: number | null,
  speed: number,
  rateModelIndex?: number | null,
  unresolvedServiceTierTurnId?: string,
];

interface SerializedFile {
  readonly s: number;
  readonly nr?: true;
  readonly lg?: true;
  readonly m: number;
  readonly oa?: number;
  readonly ms?: number;
  readonly ps?: number;
  readonly p: UsageProviderKind;
  readonly r: readonly SerializedRecord[];
  readonly t: readonly SerializedRecord[];
  readonly pr?: readonly PriorRead[];
  readonly pt?: readonly (readonly [
    seenMs: number,
    size: number,
    record: SerializedRecord,
    groups?: readonly number[],
  ])[];
  readonly ex?: number;
  readonly op?: number;
  readonly groups?: readonly string[];
  readonly sp?: readonly (readonly [
    seenMs: number,
    sinceMs: number,
    record: SerializedRecord,
    groups?: readonly number[],
  ])[];
  readonly mr: number;
  readonly o: number;
  readonly gl: number;
  readonly gh: number;
  readonly cs: unknown;
}

interface SerializedCache {
  readonly version: number;
  readonly models: readonly string[];
  readonly sessions: readonly string[];
  readonly files: Readonly<Record<string, SerializedFile>>;
}

interface InternTables {
  readonly models: string[];
  readonly sessions: string[];
  readonly modelIndex: Map<string, number>;
  readonly sessionIndex: Map<string, number>;
}

function makeInternTables(): InternTables {
  return { models: [], sessions: [], modelIndex: new Map(), sessionIndex: new Map() };
}

function intern(table: string[], index: Map<string, number>, value: string): number {
  const existing = index.get(value);
  if (existing !== undefined) return existing;
  const next = table.length;
  table.push(value);
  index.set(value, next);
  return next;
}

function serializeFile(entry: CachedFile, tables: InternTables): SerializedFile {
  const groups: string[] = [];
  let groupIndex: Map<string, number> | undefined;
  const serializeRecord = (record: UsageRecord): SerializedRecord => [
    record.timestampMs,
    intern(tables.models, tables.modelIndex, record.model),
    intern(tables.sessions, tables.sessionIndex, record.sessionId),
    record.totals.uncachedInputTokens,
    record.totals.cachedInputTokens,
    record.totals.cacheCreationTokens,
    record.totals.outputTokens,
    record.totals.reasoningTokens,
    record.dedupeKey,
    record.reportedCostUsd,
    SPEEDS.indexOf(record.speed),
    record.rateModel === undefined
      ? null
      : intern(tables.models, tables.modelIndex, record.rateModel),
    ...(record.unresolvedServiceTierTurnId === undefined
      ? ([] as const)
      : ([record.unresolvedServiceTierTurnId] as const)),
  ];
  return {
    s: entry.size,
    ...(entry.needsReparse ? { nr: true } : {}),
    ...(entry.legacy ? { lg: true } : {}),
    m: entry.mtimeMs,
    oa: entry.observedAtMs,
    ...(entry.missingSinceMs === undefined ? {} : { ms: entry.missingSinceMs }),
    ...(entry.presentSinceMs === undefined ? {} : { ps: entry.presentSinceMs }),
    p: entry.provider,
    r: entry.records.map(serializeRecord),
    t: entry.tailRecords.map(serializeRecord),
    ...(entry.priorReads === undefined ? {} : { pr: entry.priorReads }),
    ...(entry.peerTails === undefined
      ? {}
      : {
          pt: entry.peerTails.map(
            ({ record, seenMs, size, readGroups }) =>
              [
                seenMs,
                size,
                serializeRecord(record),
                ...(readGroups === undefined
                  ? ([] as const)
                  : ([
                      readGroups.map((group) => intern(groups, (groupIndex ??= new Map()), group)),
                    ] as const)),
              ] as const,
          ),
        }),
    ...(entry.expiredThroughMs === undefined ? {} : { ex: entry.expiredThroughMs }),
    ...(entry.otherProviderAtMs === undefined ? {} : { op: entry.otherProviderAtMs }),
    ...(entry.superseded === undefined
      ? {}
      : {
          sp: entry.superseded.map(
            ({ record, seenMs, sinceMs, readGroups }) =>
              [
                seenMs,
                sinceMs,
                serializeRecord(record),
                ...(readGroups === undefined
                  ? ([] as const)
                  : ([
                      readGroups.map((group) => intern(groups, (groupIndex ??= new Map()), group)),
                    ] as const)),
              ] as const,
          ),
        }),
    ...(groups.length ? { groups } : {}),
    mr: entry.malformedRecords,
    o: entry.position.resumeOffset,
    gl: entry.position.guardLength,
    gh: entry.position.guardHash,
    cs: entry.position.state,
  };
}

/** Characters a save encodes before it lets the event loop run again; a larger row is one piece. */
export const SCAN_CACHE_PIECE_CHARS = 1 << 20;

/**
 * Encodes one snapshot a piece at a time, for a caller that writes each piece before asking for
 * the next. Each snapshot interns only the models and sessions its own rows use, so a pruned
 * row's session leaves later snapshots; the tables come after the files because only then are
 * they complete. `extra` must not hold `files`.
 */
export function* scanCacheDocumentPieces(
  rows: Iterable<readonly [string, CachedFile]>,
  extra: Readonly<Record<string, unknown>>,
): Generator<string, void, undefined> {
  const tables = makeInternTables();
  let piece = '{"files":{';
  let separator = "";
  for (const [path, entry] of rows) {
    piece += `${separator}${JSON.stringify(path)}:${JSON.stringify(serializeFile(entry, tables))}`;
    separator = ",";
    if (piece.length >= SCAN_CACHE_PIECE_CHARS) {
      yield piece;
      piece = "";
    }
  }
  const head = JSON.stringify({
    ...extra,
    version: USAGE_SCAN_CACHE_VERSION,
    models: tables.models,
    sessions: tables.sessions,
  });
  yield `${piece}},${head.slice(1)}`;
}

/** More snapshots than this cost a startup more to read than one full save costs to write. */
const MAX_RETIRABLE_SNAPSHOTS = 64;

/**
 * A save writes every live row, so it may retire every snapshot it read or wrote, when its
 * changed and dropped rows are over half the live rows, or when those snapshots number more than
 * MAX_RETIRABLE_SNAPSHOTS or hold more characters outside the largest one than in it. The bounds
 * keep a startup's reads under about twice the live rows while most saves write a few rows.
 */
export function isFullSaveDue(input: {
  readonly liveRows: number;
  readonly staleRows: number;
  /** Characters in each snapshot a full save would retire. */
  readonly retirableChars: readonly number[];
}): boolean {
  if (input.staleRows * 2 > input.liveRows) return true;
  if (input.retirableChars.length > MAX_RETIRABLE_SNAPSHOTS) return true;
  let total = 0;
  let largest = 0;
  for (const chars of input.retirableChars) {
    total += chars;
    largest = Math.max(largest, chars);
  }
  return total - largest > largest;
}

function isRecordArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export function decodeScanCache(
  document: unknown,
  formats: ReadonlyMap<UsageProviderKind, TranscriptUsageFormat<unknown>>,
): ScanCache {
  const cache: ScanCache = new Map();
  const isValidState = makeStateValidators(formats);
  if (typeof document !== "object" || document === null) return cache;

  const root = document as Partial<SerializedCache>;
  const version = root.version;
  if (
    typeof version !== "number" ||
    version < SPEED_COMPATIBLE_SINCE_VERSION ||
    version > USAGE_SCAN_CACHE_VERSION
  ) {
    return cache;
  }
  if (!isRecordArray(root.models) || !isRecordArray(root.sessions)) return cache;
  if (typeof root.files !== "object" || root.files === null) return cache;

  if (!root.models.every((value) => typeof value === "string")) return cache;
  if (!root.sessions.every((value) => typeof value === "string")) return cache;
  const models = root.models as readonly string[];
  const sessions = root.sessions as readonly string[];

  // Reject entire corrupt entries; partial survivors would appear warm and hide usage until the file changes.
  const decodeRecords = (
    rows: readonly unknown[],
    provider: UsageProviderKind,
  ): UsageRecord[] | null => {
    const records: UsageRecord[] = [];
    for (const row of rows) {
      if (!isRecordArray(row) || row.length < 11) return null;
      const [
        timestampMs,
        modelIndex,
        sessionIndex,
        uncached,
        cached,
        cacheCreation,
        output,
        reasoning,
        dedupeKey,
        reportedCostUsd,
        speedIndex,
        rateModelIndex,
        unresolvedServiceTierTurnId,
      ] = row as SerializedRecord;
      const speed = typeof speedIndex === "number" ? SPEEDS[speedIndex] : undefined;

      const model = typeof modelIndex === "number" ? models[modelIndex] : undefined;
      const rateModel = typeof rateModelIndex === "number" ? models[rateModelIndex] : undefined;
      if (
        typeof timestampMs !== "number" ||
        !Number.isFinite(timestampMs) ||
        model === undefined ||
        (unresolvedServiceTierTurnId !== undefined &&
          typeof unresolvedServiceTierTurnId !== "string") ||
        (rateModelIndex != null && rateModel === undefined) ||
        !Number.isFinite(uncached) ||
        !Number.isFinite(cached) ||
        !Number.isFinite(cacheCreation) ||
        !Number.isFinite(output) ||
        !Number.isFinite(reasoning) ||
        speed === undefined
      ) {
        return null;
      }

      // Unchanged and deleted transcripts may only exist in the cache, so the
      // parser cannot remove their previously saved local placeholders.
      if (provider === "claude" && model === CLAUDE_SYNTHETIC_MODEL) continue;

      records.push({
        provider,
        timestampMs,
        model,
        ...(rateModel === undefined ? {} : { rateModel }),
        sessionId: (typeof sessionIndex === "number" ? sessions[sessionIndex] : undefined) ?? "",
        totals: {
          uncachedInputTokens: uncached,
          cachedInputTokens: cached,
          cacheCreationTokens: cacheCreation,
          outputTokens: output,
          reasoningTokens: reasoning,
        },
        reportedCostUsd: typeof reportedCostUsd === "number" ? reportedCostUsd : null,
        speed,
        ...(version >= 7 && unresolvedServiceTierTurnId !== undefined
          ? { unresolvedServiceTierTurnId }
          : {}),
        dedupeKey: typeof dedupeKey === "string" ? dedupeKey : null,
      });
    }
    return records;
  };

  for (const [path, raw] of Object.entries(root.files)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Partial<SerializedFile>;
    if (typeof entry.s !== "number" || typeof entry.m !== "number") continue;
    if (entry.p === undefined) continue;
    const format = formats.get(entry.p);
    if (format === undefined) continue;
    if (!isRecordArray(entry.r) || !isRecordArray(entry.t)) continue;
    const malformedRecords = entry.mr === undefined ? 0 : entry.mr;
    if (!Number.isSafeInteger(malformedRecords) || malformedRecords < 0) continue;
    // Position fields feed byte offsets and a Buffer allocation in the reader,
    // so anything outside their real ranges must reject the entry: a bogus
    // guard length would otherwise fail every parse of the file, silently
    // dropping its usage instead of costing the documented cold re-parse.
    if (
      typeof entry.o !== "number" ||
      !Number.isSafeInteger(entry.o) ||
      entry.o < 0 ||
      typeof entry.gl !== "number" ||
      !Number.isSafeInteger(entry.gl) ||
      entry.gl < 0 ||
      entry.gl > GUARD_LENGTH ||
      entry.gl > entry.o ||
      typeof entry.gh !== "number" ||
      !Number.isFinite(entry.gh)
    ) {
      continue;
    }
    // Keep history for deleted rollouts, but re-parse incompatible reducer state.
    // v9 repairs skipped initial Codex requests; clean v8 entries can still resume.
    // v10 adds Claude advisor calls, which no older Claude entry holds.
    const needsReparse =
      entry.nr === true ||
      (entry.p === "claude" && version < 10) ||
      (format.state !== undefined &&
        (version < 6 ||
          (entry.p === "codex" && (version < 8 || (version < 9 && malformedRecords > 0)))));
    // A corrupt state disqualifies the entry: resuming with it would attach
    // appended usage to the wrong model or replay fork-copied history.
    if (!needsReparse && !isValidState.get(entry.p)?.(entry.cs)) continue;

    const provider = entry.p;
    const records = decodeRecords(entry.r, provider);
    const tailRecords = decodeRecords(entry.t, provider);
    if (records === null || tailRecords === null) continue;
    // Rows written before observations were recorded count as observed at their mtime.
    const observedAtMs =
      typeof entry.oa === "number" && Number.isFinite(entry.oa) ? entry.oa : entry.m;
    const groups = entry.groups ?? [];
    if (
      !isRecordArray(groups) ||
      !groups.every(
        (group) =>
          typeof group === "string" &&
          (/^[\w-]{43}$/.test(group) || groupMembers(group) !== undefined),
      )
    )
      continue;
    const superseded: SupersededRecord[] = [];
    if (entry.sp !== undefined) {
      if (!isRecordArray(entry.sp)) continue;
      const valid = entry.sp.every((item) => {
        if (!isRecordArray(item) || (item.length !== 3 && item.length !== 4)) return false;
        const [seenMs, sinceMs, rawRecord, refs] = item;
        if (
          refs !== undefined &&
          (!isRecordArray(refs) ||
            !refs.every((i) => Number.isInteger(i) && i >= 0 && i < groups.length))
        )
          return false;
        const readGroups = refs?.map((i) => groups[i]!);
        if (
          typeof seenMs !== "number" ||
          !Number.isFinite(seenMs) ||
          typeof sinceMs !== "number" ||
          !Number.isFinite(sinceMs) ||
          seenMs > observedAtMs ||
          sinceMs > observedAtMs
        )
          return false;
        const rows = decodeRecords([rawRecord], provider);
        if (rows === null) return false;
        const record = rows[0];
        if (record === undefined || !canRetainUsageRecord(record)) return true;
        const last = superseded.at(-1);
        if (last && last.record.dedupeKey >= record.dedupeKey) return false;
        superseded.push({ record, seenMs, sinceMs, ...(readGroups?.length ? { readGroups } : {}) });
        return true;
      });
      if (!valid) continue;
    }
    const priorReads = entry.pr;
    if (
      priorReads !== undefined &&
      (!Array.isArray(priorReads) ||
        priorReads.some(
          (read, i) =>
            !isPriorRead(read) ||
            readTime(read) >= observedAtMs ||
            readTime(read) <= (entry.ex ?? -Infinity) ||
            (i > 0 && readTime(read) <= readTime(priorReads[i - 1]!)),
        ))
    )
      continue;
    const peerTails: PeerTail[] = [];
    if (entry.pt !== undefined) {
      if (!isRecordArray(entry.pt)) continue;
      const valid = entry.pt.every((item) => {
        if (!isRecordArray(item) || (item.length !== 3 && item.length !== 4)) return false;
        const [seenMs, size, rawRecord, refs] = item;
        if (
          typeof seenMs !== "number" ||
          !Number.isFinite(seenMs) ||
          seenMs > observedAtMs ||
          typeof size !== "number" ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          (refs !== undefined &&
            (!isRecordArray(refs) ||
              !refs.every(
                (index) => Number.isInteger(index) && index >= 0 && index < groups.length,
              )))
        )
          return false;
        const decoded = decodeRecords([rawRecord], provider);
        if (decoded === null) return false;
        const record = decoded[0];
        const readGroups = refs?.map((index) => groups[index]!);
        if (record !== undefined && canRetainUsageRecord(record)) {
          peerTails.push({ record, seenMs, size, ...(readGroups?.length ? { readGroups } : {}) });
        }
        return true;
      });
      if (!valid) continue;
    }
    if (
      [entry.ex, entry.op].some(
        (time) => time !== undefined && (!Number.isFinite(time) || time > observedAtMs),
      )
    )
      continue;
    const decoded: CachedFile = {
      ...(superseded.length ? { superseded } : {}),
      ...(priorReads?.length ? { priorReads } : {}),
      ...(peerTails.length ? { peerTails } : {}),
      ...(entry.ex === undefined ? {} : { expiredThroughMs: entry.ex }),
      ...(entry.op === undefined ? {} : { otherProviderAtMs: entry.op }),
      size: entry.s,
      ...(needsReparse ? { needsReparse: true } : {}),
      ...(version < USAGE_SCAN_CACHE_VERSION || entry.lg === true ? { legacy: true } : {}),
      mtimeMs: entry.m,
      observedAtMs,
      ...(isEpochMillis(entry.ms) ? { missingSinceMs: entry.ms } : {}),
      ...(isEpochMillis(entry.ps) ? { presentSinceMs: entry.ps } : {}),
      provider,
      records,
      tailRecords,
      malformedRecords,
      position: needsReparse
        ? { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null }
        : {
            resumeOffset: entry.o,
            guardLength: entry.gl,
            guardHash: entry.gh,
            state: entry.cs,
          },
    };
    cache.set(path, decoded);
  }

  return cache;
}

const isEpochMillis = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function makeStateValidators(
  formats: ReadonlyMap<UsageProviderKind, TranscriptUsageFormat<unknown>>,
): ReadonlyMap<UsageProviderKind, (value: unknown) => boolean> {
  return new Map(
    [...formats].map(([provider, format]) => {
      const isState = format.state === undefined ? undefined : Schema.is(format.state.schema);
      return [
        provider,
        (value: unknown) => value === null || (isState !== undefined && isState(value)),
      ] as const;
    }),
  );
}

/** A deleted transcript's usage counts from when it went missing, so deleting it never ends it early. */
export const isRetained = (entry: CachedFile, retentionCutoffMs: number): boolean =>
  (entry.missingSinceMs ?? entry.mtimeMs) >= retentionCutoffMs;

/** Each existing call can represent one compatible member of a group proved distinct in a source file. */
function unmatchedCalls(
  provider: UsageProviderKind,
  calls: readonly KeyedUsageRecord[],
  existing: readonly UsageRecord[],
) {
  const possible = makeUsageRetentionMatcher(provider, calls);
  const slots = existing
    .filter((record) => !canRetainUsageRecord(record) || possible.matches(record))
    .map((record) => makeUsageRetentionMatcher(provider, [record]));
  const occupied = new Map<number, KeyedUsageRecord>();
  return calls.filter((candidate) => {
    if (occupied.size === slots.length) return true;
    const from = new Map<KeyedUsageRecord, number | undefined>([[candidate, undefined]]);
    const via = new Map<number, KeyedUsageRecord>();
    for (const call of from.keys()) {
      for (const [slot, matcher] of slots.entries()) {
        if (via.has(slot) || !matcher.matches(call)) continue;
        via.set(slot, call);
        const previous = occupied.get(slot);
        if (previous !== undefined) {
          from.set(previous, slot);
          continue;
        }
        // Reassign earlier aliases along this path so a call with only one possible match gets it.
        let next: number | undefined = slot;
        while (next !== undefined) {
          const matched: KeyedUsageRecord = via.get(next)!;
          occupied.set(next, matched);
          next = from.get(matched);
        }
        return false;
      }
    }
    return true;
  });
}

/** A replaced version's usage counts from when a read found it gone, as a deleted file's does. */
export const retainedSuperseded = (
  entry: CachedFile,
  retentionCutoffMs: number,
  provider: UsageProviderKind,
): readonly UsageRecord[] => {
  if (entry.provider !== provider) return [];
  const candidates = historyWithProvedTails(entry, provedPeerTails(entry)).filter(
    (item) => item.sinceMs >= retentionCutoffMs,
  );
  if (candidates.length === 0) return [];
  const accepted = [...entry.records, ...entry.tailRecords];
  const acceptedKeys = new Set(accepted.map((record) => record.dedupeKey));
  const matcher = makeUsageRetentionMatcher(provider, accepted);
  const groups = new Map<
    string,
    { id: string; seenMs: number; members: Set<string>; records: Map<string, SupersededRecord> }
  >();
  for (const item of candidates) {
    const key = item.record.dedupeKey;
    for (const witness of item.readGroups ?? [null]) {
      const id = witness?.startsWith("[")
        ? witness
        : JSON.stringify([item.seenMs, witness, witness === null ? key : null]);
      let group = groups.get(id);
      if (group === undefined) {
        group = {
          id,
          seenMs: item.seenMs,
          members: new Set(witness ? groupMembers(witness) : undefined),
          records: new Map(),
        };
        groups.set(id, group);
      }
      group.seenMs = Math.max(group.seenMs, item.seenMs);
      group.members.add(key);
      const old = group.records.get(key);
      if (!old || old.seenMs < item.seenMs) group.records.set(key, item);
    }
  }
  const ordered = [...groups.values()].sort(
    (a, b) => b.seenMs - a.seenMs || b.records.size - a.records.size || (a.id < b.id ? -1 : 1),
  );
  const kept: UsageRecord[] = [];
  for (const group of ordered) {
    const waiting = [...group.records.values()]
      .map((item) => item.record)
      .filter((record) => !acceptedKeys.has(record.dedupeKey));
    if (!waiting.length) continue;
    const distinct = waiting.filter((record) => !matcher.matches(record));
    const ambiguous = waiting.filter((record) => matcher.matches(record));
    if (ambiguous.length && group.members.size > 1) {
      const otherCalls = accepted.filter(
        (record) => record.dedupeKey === null || !group.members.has(record.dedupeKey),
      );
      for (const unmatched of unmatchedCalls(provider, ambiguous, otherCalls))
        distinct.push(unmatched);
    }
    for (const record of distinct) {
      accepted.push(record);
      acceptedKeys.add(record.dedupeKey);
      matcher.add(record);
      kept.push(record);
    }
  }
  return kept;
};

export const hasRetainedSuperseded = (entry: CachedFile, retentionCutoffMs: number): boolean =>
  (entry.superseded?.some(({ sinceMs }) => sinceMs >= retentionCutoffMs) ?? false) ||
  (entry.peerTails?.some(
    (tail) => (provedTailReplacement(entry, tail) ?? -Infinity) >= retentionCutoffMs,
  ) ??
    false);

export function afterEvictedRead(entry: CachedFile, throughMs: number): CachedFile | undefined {
  if (entry.observedAtMs <= throughMs) return undefined;
  const superseded = entry.superseded?.filter(({ seenMs }) => seenMs > throughMs) ?? [];
  const peerTails = entry.peerTails?.filter(({ seenMs }) => seenMs > throughMs) ?? [];
  const priorReads = entry.priorReads?.filter((read) => readTime(read) > throughMs) ?? [];
  if (
    sameItems(entry.superseded, superseded) &&
    sameItems(entry.peerTails, peerTails) &&
    sameItems(entry.priorReads, priorReads)
  )
    return entry;
  const { superseded: _old, peerTails: _tails, priorReads: _reads, ...rest } = entry;
  return {
    ...rest,
    ...(superseded.length ? { superseded } : {}),
    ...(peerTails.length ? { peerTails } : {}),
    ...(priorReads.length ? { priorReads } : {}),
  };
}

export function pruneSuperseded(
  entry: CachedFile,
  nowMs: number,
  retentionCutoffMs: number,
): CachedFile {
  if (
    entry.priorReads === undefined &&
    entry.superseded === undefined &&
    entry.peerTails === undefined
  )
    return entry;
  const reads = entry.priorReads ?? [];
  const retained = entry.superseded ?? [];
  const tails = entry.peerTails ?? [];
  if (
    readTime(reads[0] ?? entry.observedAtMs) >= retentionCutoffMs &&
    retained.every(({ sinceMs }) => sinceMs >= retentionCutoffMs && sinceMs <= nowMs)
  )
    return entry;
  let floor = entry.expiredThroughMs ?? -Infinity;
  for (const read of reads) {
    const time = readTime(read);
    if (time >= retentionCutoffMs) break;
    floor = Math.max(floor, time);
  }
  if (entry.observedAtMs < retentionCutoffMs) floor = entry.observedAtMs;
  for (const item of retained) {
    if (item.sinceMs < retentionCutoffMs)
      floor = Math.max(floor, readTime(firstReadAfter(reads, item.seenMs, entry.observedAtMs)));
  }
  const priorReads = reads.filter((read) => readTime(read) > floor);
  const peerTails = tails.filter(
    ({ seenMs }) => readTime(firstReadAfter(reads, seenMs, entry.observedAtMs)) > floor,
  );
  // Earlier peers cannot reverse a size comparison once its successor is behind the pruning boundary.
  const finalized = provedPeerTails(entry, floor);
  const history = historyWithProvedTails(entry, finalized);
  let liveKeys: Set<string | null> | undefined;
  const superseded = history
    .filter((item) => {
      if (item.sinceMs >= retentionCutoffMs) return true;
      if (item.seenMs !== entry.observedAtMs || !item.readGroups?.length) return false;
      liveKeys ??= new Set(entry.records.map((record) => record.dedupeKey));
      return liveKeys.has(item.record.dedupeKey);
    })
    .map((item) => (item.sinceMs <= nowMs ? item : { ...item, sinceMs: nowMs }));
  if (
    sameItems(reads, priorReads) &&
    sameItems(tails, peerTails) &&
    sameItems(retained, superseded) &&
    floor === (entry.expiredThroughMs ?? -Infinity)
  )
    return entry;
  const { superseded: _old, priorReads: _times, peerTails: _tails, ...rest } = entry;
  return {
    ...rest,
    ...(superseded.length ? { superseded } : {}),
    ...(priorReads.length ? { priorReads } : {}),
    ...(peerTails.length ? { peerTails } : {}),
    ...(Number.isFinite(floor) ? { expiredThroughMs: floor } : {}),
  };
}

/**
 * mergeScanEntry keeps a missing time only when it is after the presence time, so each mark
 * stays after the other even when the clock steps back or both come in the same millisecond.
 */
export const markMissing = (entry: CachedFile, nowMs: number): CachedFile => ({
  ...entry,
  missingSinceMs: Math.max(nowMs, (entry.presentSinceMs ?? -1) + 1),
});

export const markPresent = (entry: CachedFile, nowMs: number): CachedFile => {
  const { missingSinceMs, ...seen } = entry;
  return { ...seen, presentSinceMs: Math.max(nowMs, missingSinceMs ?? -1) };
};

/** Mutates seen; share it across incremental line/tail batches to deduplicate the whole file. */
export function dedupeWithinFile(
  records: readonly UsageRecord[],
  seen: Set<string> = new Set(),
): readonly UsageRecord[] {
  const kept: UsageRecord[] = [];
  for (const record of records) {
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) continue;
      seen.add(record.dedupeKey);
    }
    kept.push(record);
  }
  return kept;
}
