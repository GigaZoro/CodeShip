import type { UsageProviderKind } from "@t3tools/contracts";
import type {
  TranscriptUsageFormat,
  UsageRecord,
  UsageSpeed,
} from "@t3tools/provider-core/server/usage";
import * as Schema from "effect/Schema";

import { CLAUDE_SYNTHETIC_MODEL } from "../provider/Drivers/claudeUsage.ts";
import { GUARD_LENGTH, type TranscriptParsePosition } from "./usageTranscriptReader.ts";

export const USAGE_SCAN_CACHE_VERSION = 11 as const;
const SPEED_COMPATIBLE_SINCE_VERSION = 4;

/**
 * Saved usage is a directory of snapshots that are written once and never changed, so processes
 * sharing a state directory need no lock: each reads every name once and merges rows. A future
 * format uses a new directory and claims this one's snapshots as legacy inputs.
 */
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
  readonly provider: UsageProviderKind;
  readonly records: readonly UsageRecord[];
  /** Unterminated tail records stay separate because incremental parsing rereads them. */
  readonly tailRecords: readonly UsageRecord[];
  /** Whole-file count, including diagnostics from the tentative tail. */
  readonly malformedRecords: number;
  readonly position: TranscriptParsePosition;
}

export type ScanCache = Map<string, CachedFile>;

export interface CachedSource {
  readonly dir: string;
  readonly volumeId: string;
  /** Wall-clock time a scan recorded this directory or its volume. */
  readonly seenAtMs?: number;
}

const isCurrentRow = (entry: CachedFile) => entry.legacy === undefined && !entry.needsReparse;

/**
 * Every place rows for one transcript meet uses this order, so any merge order of the same
 * snapshots gives the same rows: the later observation, then a current-format row, then the
 * larger file, then the row already held.
 */
function pickScanEntry(held: CachedFile, incoming: CachedFile): CachedFile {
  if (incoming.observedAtMs !== held.observedAtMs) {
    return incoming.observedAtMs > held.observedAtMs ? incoming : held;
  }
  const heldCurrent = isCurrentRow(held);
  if (heldCurrent !== isCurrentRow(incoming)) return heldCurrent ? held : incoming;
  return incoming.size > held.size ? incoming : held;
}

/**
 * A missing time says nothing about a file's contents, so it never picks the winning row. The
 * winner takes the latest one from a row read at the same time or found gone after its own read;
 * an earlier one predates a read that found the file back.
 */
export function mergeScanEntry(held: CachedFile, incoming: CachedFile): CachedFile {
  const winner = pickScanEntry(held, incoming);
  const missingTimes = [held, incoming].flatMap(({ observedAtMs, missingSinceMs }) =>
    missingSinceMs !== undefined &&
    (observedAtMs === winner.observedAtMs || missingSinceMs > winner.observedAtMs)
      ? [missingSinceMs]
      : [],
  );
  const missingSinceMs = missingTimes.length === 0 ? undefined : Math.max(...missingTimes);
  if (missingSinceMs === winner.missingSinceMs) return winner;
  const { missingSinceMs: _, ...contents } = winner;
  return missingSinceMs === undefined ? contents : { ...contents, missingSinceMs };
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
  readonly p: UsageProviderKind;
  readonly r: readonly SerializedRecord[];
  readonly t: readonly SerializedRecord[];
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
    p: entry.provider,
    r: entry.records.map(serializeRecord),
    t: entry.tailRecords.map(serializeRecord),
    mr: entry.malformedRecords,
    o: entry.position.resumeOffset,
    gl: entry.position.guardLength,
    gh: entry.position.guardHash,
    cs: entry.position.state,
  };
}

/** Memoizes immutable entries by identity; growing intern tables preserve indexes, retaining unused strings until restart. */
export function makeScanCacheWriter(): (
  cache: ScanCache,
  extra: Readonly<Record<string, unknown>>,
) => string {
  const tables = makeInternTables();
  const fragments = new WeakMap<CachedFile, string>();
  return (cache, extra) => {
    const files: string[] = [];
    for (const [path, entry] of cache) {
      let fragment = fragments.get(entry);
      if (fragment === undefined) {
        fragment = JSON.stringify(serializeFile(entry, tables));
        fragments.set(entry, fragment);
      }
      files.push(`${JSON.stringify(path)}:${fragment}`);
    }
    // Encoded after the files, which may have added to the intern tables.
    const head = JSON.stringify({
      ...extra,
      version: USAGE_SCAN_CACHE_VERSION,
      models: tables.models,
      sessions: tables.sessions,
    });
    return `${head.slice(0, -1)},"files":{${files.join(",")}}}`;
  };
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

    cache.set(path, {
      size: entry.s,
      ...(needsReparse ? { needsReparse: true } : {}),
      ...(version < USAGE_SCAN_CACHE_VERSION || entry.lg === true ? { legacy: true } : {}),
      mtimeMs: entry.m,
      observedAtMs,
      ...(typeof entry.ms === "number" && Number.isFinite(entry.ms)
        ? { missingSinceMs: entry.ms }
        : {}),
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
    });
  }

  return cache;
}

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
