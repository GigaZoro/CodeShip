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
}

type KeyedUsageRecord = UsageRecord & { readonly dedupeKey: string };

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
  /** Prior reads in the retention window, so a late peer can date a previously unknown record's replacement. */
  readonly priorReads?: readonly number[];
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
  const fileInfo = (entry: CachedFile) =>
    JSON.stringify([
      entry.provider,
      entry.mtimeMs,
      entry.needsReparse,
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

function firstReadAfter(priorReads: readonly number[], seenMs: number, lastRead: number) {
  let low = 0;
  let high = priorReads.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (priorReads[mid]! <= seenMs) low = mid + 1;
    else high = mid;
  }
  return priorReads[low] ?? lastRead;
}

function sameItems<T>(own: readonly T[] | undefined, next: readonly T[]) {
  return (own?.length ?? 0) === next.length && next.every((item, index) => item === own?.[index]);
}

interface ReadEvidence {
  /** Only the original parsed row proves the committed prefix survived a verified append. */
  readonly retainedPrefix?: CachedFile;
  readonly liveKeys?: ReadonlySet<string>;
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
  const times = new Set(winner.priorReads);
  if (sameProvider) {
    for (const time of loser.priorReads ?? []) times.add(time);
    times.add(loser.observedAtMs);
  }
  const priorReads = [...times]
    .filter(
      (time) =>
        time > floor && time > (otherProviderAtMs ?? -Infinity) && time < winner.observedAtMs,
    )
    .sort((a, b) => a - b);

  const retained = new Map<string, SupersededRecord>();
  let liveKeys = read?.liveKeys;
  let simultaneousRecords: Map<string | null, UsageRecord> | undefined;
  const tailKeys = new Set(winner.tailRecords.map((record) => record.dedupeKey));
  function consider(
    record: KeyedUsageRecord,
    seenMs: number,
    sinceMs: number,
    original?: SupersededRecord,
  ) {
    if (seenMs < floor || seenMs <= (otherProviderAtMs ?? -Infinity)) return;
    liveKeys ??= new Set(
      winner.records.map((live) => live.dedupeKey).filter((key) => key !== null),
    );
    const key = record.dedupeKey;
    if (liveKeys.has(key) && !tailKeys.has(key)) {
      if (seenMs !== winner.observedAtMs) return;
      // A later snapshot that lacks this call must pick the same value even if it met both peers separately.
      simultaneousRecords ??= new Map(winner.records.map((live) => [live.dedupeKey, live]));
      const live = simultaneousRecords.get(key);
      if (live && (sameRecord(live, record) || recordIdentity(live) <= recordIdentity(record)))
        return;
    }
    const held = retained.get(key);
    if (held !== undefined && held.seenMs > seenMs) return;
    sinceMs = Math.min(sinceMs, firstReadAfter(priorReads, seenMs, winner.observedAtMs));
    if (held?.seenMs === seenMs) {
      sinceMs = Math.min(sinceMs, held.sinceMs);
      if (
        held.record === record ||
        sameRecord(held.record, record) ||
        recordIdentity(held.record) <= recordIdentity(record)
      ) {
        record = held.record;
        original = held;
      }
    }
    retained.set(key, original?.sinceMs === sinceMs ? original : { record, seenMs, sinceMs });
  }
  function carryHistory(entry: CachedFile) {
    for (const item of entry.superseded ?? []) {
      // Concurrent sightings count as present until the next distinct read.
      const sinceMs = item.seenMs === entry.observedAtMs ? Infinity : item.sinceMs;
      consider(item.record, item.seenMs, sinceMs, item);
    }
  }
  carryHistory(winner);
  if (sameProvider) carryHistory(loser);
  if (
    sameProvider &&
    read?.retainedPrefix !== loser &&
    loser.observedAtMs >= floor &&
    loser.observedAtMs > (otherProviderAtMs ?? -Infinity)
  ) {
    for (const record of loser.records) {
      if (canRetainUsageRecord(record)) consider(record, loser.observedAtMs, Infinity);
    }
    // Only a full re-read proves the tentative line was replaced rather than completed.
    if (read !== undefined && read.retainedPrefix === undefined) {
      for (const record of loser.tailRecords) {
        if (canRetainUsageRecord(record)) consider(record, loser.observedAtMs, Infinity);
      }
    }
  }
  const superseded = [...retained.values()].sort((a, b) =>
    a.record.dedupeKey < b.record.dedupeKey ? -1 : 1,
  );
  if (
    sameItems(winner.superseded, superseded) &&
    sameItems(winner.priorReads, priorReads) &&
    winner.expiredThroughMs === expiredThroughMs &&
    winner.otherProviderAtMs === otherProviderAtMs
  )
    return winner;
  const { superseded: _old, priorReads: _times, ...entry } = winner;
  return {
    ...entry,
    ...(superseded.length ? { superseded } : {}),
    ...(priorReads.length ? { priorReads } : {}),
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
  readonly pr?: readonly number[];
  readonly ex?: number;
  readonly op?: number;
  readonly sp?: readonly (readonly [seenMs: number, sinceMs: number, record: SerializedRecord])[];
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
    ...(entry.expiredThroughMs === undefined ? {} : { ex: entry.expiredThroughMs }),
    ...(entry.otherProviderAtMs === undefined ? {} : { op: entry.otherProviderAtMs }),
    ...(entry.superseded === undefined
      ? {}
      : {
          sp: entry.superseded.map(
            ({ record, seenMs, sinceMs }) => [seenMs, sinceMs, serializeRecord(record)] as const,
          ),
        }),
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
    const superseded: SupersededRecord[] = [];
    if (entry.sp !== undefined) {
      if (!isRecordArray(entry.sp)) continue;
      const valid = entry.sp.every((item) => {
        if (!isRecordArray(item) || item.length !== 3) return false;
        const [seenMs, sinceMs, rawRecord] = item;
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
        superseded.push({ record, seenMs, sinceMs });
        return true;
      });
      if (!valid) continue;
    }
    const priorReads = entry.pr;
    if (
      priorReads !== undefined &&
      (!Array.isArray(priorReads) ||
        priorReads.some(
          (time, i) =>
            !Number.isFinite(time) ||
            time >= observedAtMs ||
            time <= (entry.ex ?? -Infinity) ||
            (i > 0 && time <= priorReads[i - 1]!),
        ))
    )
      continue;
    if (
      [entry.ex, entry.op].some(
        (time) => time !== undefined && (!Number.isFinite(time) || time > observedAtMs),
      )
    )
      continue;
    const decoded: CachedFile = {
      ...(superseded.length ? { superseded } : {}),
      ...(priorReads?.length ? { priorReads } : {}),
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

/** A replaced version's usage counts from when a read found it gone, as a deleted file's does. */
export const retainedSuperseded = (
  entry: CachedFile,
  retentionCutoffMs: number,
  provider: UsageProviderKind,
): readonly UsageRecord[] => {
  if (entry.superseded === undefined || entry.provider !== provider) return [];
  const candidates = entry.superseded.filter((item) => item.sinceMs >= retentionCutoffMs);
  if (candidates.length === 0) return [];
  const matcher = makeUsageRetentionMatcher(provider, entry.records);
  for (const record of entry.tailRecords) matcher.add(record);
  candidates.sort((a, b) => b.seenMs - a.seenMs);
  const kept: UsageRecord[] = [];
  let start = 0;
  while (start < candidates.length) {
    let end = start;
    const batchStart = kept.length;
    do {
      const { record } = candidates[end++]!;
      if (!matcher.matches(record)) kept.push(record);
    } while (end < candidates.length && candidates[end]!.seenMs === candidates[start]!.seenMs);
    // Distinct IDs seen together can be separate calls even when they would be ambiguous across reads.
    for (let i = batchStart; i < kept.length; i++) matcher.add(kept[i]!);
    start = end;
  }
  return kept;
};

export const hasRetainedSuperseded = (entry: CachedFile, retentionCutoffMs: number): boolean =>
  entry.superseded?.some(({ sinceMs }) => sinceMs >= retentionCutoffMs) ?? false;

export function pruneSuperseded(
  entry: CachedFile,
  nowMs: number,
  retentionCutoffMs: number,
): CachedFile {
  if (entry.priorReads === undefined && entry.superseded === undefined) return entry;
  const reads = entry.priorReads ?? [];
  const retained = entry.superseded ?? [];
  let floor = entry.expiredThroughMs ?? -Infinity;
  for (const time of reads) {
    if (time >= retentionCutoffMs) break;
    floor = Math.max(floor, time);
  }
  if (entry.observedAtMs < retentionCutoffMs) floor = entry.observedAtMs;
  for (const item of retained) {
    if (item.sinceMs < retentionCutoffMs)
      floor = Math.max(floor, firstReadAfter(reads, item.seenMs, entry.observedAtMs));
  }
  const priorReads = reads.filter((time) => time > floor);
  const superseded = retained
    .filter((item) => item.sinceMs >= retentionCutoffMs)
    .map((item) => (item.sinceMs <= nowMs ? item : { ...item, sinceMs: nowMs }));
  if (
    sameItems(reads, priorReads) &&
    sameItems(retained, superseded) &&
    floor === (entry.expiredThroughMs ?? -Infinity)
  )
    return entry;
  const { superseded: _old, priorReads: _times, ...rest } = entry;
  return {
    ...rest,
    ...(superseded.length ? { superseded } : {}),
    ...(priorReads.length ? { priorReads } : {}),
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
