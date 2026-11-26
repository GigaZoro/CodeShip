import {
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type ServerSettings as ServerSettingsValue,
  USAGE_CONTRACT_VERSION,
  type UsageProviderKind,
  type UsageSource,
  type UsagePricing,
  type UsageSummary,
  type UsageSummaryInput,
  type UsageTokenTotals,
  UsageReadError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The settings stream needs a synchronous opaque key.
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientResponse } from "effect/http";

import { retryWhileWindowsLocked, writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { formatMalformedUsageWarning } from "@t3tools/shared/usageFormat";
import {
  type UsageScanSettings,
  usageScanSettings,
  usageScanSettingsKey,
} from "@t3tools/shared/usageScanSettings";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { BUILT_IN_USAGE_DRIVERS, type BuiltInUsageReadersEnv } from "../provider/builtInDrivers.ts";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type {
  ProviderUsageInstance,
  TranscriptUsageFormat,
  UsageRecord,
} from "@t3tools/provider-core/server/usage";
import {
  canonicalModelFilter,
  resolveModelAliases,
  usageTimestampFilter,
  UsageAggregator,
} from "./usageAggregation.ts";
import {
  createOverrideRateTable,
  parseRateTable,
  priceUsage,
  isUnlistedModel,
  type RateTable,
} from "./usagePricing.ts";
import {
  DESKTOP_HOST_SCOPE_ENV,
  isGone,
  listTranscriptFiles,
  isPathCallPending,
  readDirectoryVolumeId,
  readPhysicalSourceId,
  readTranscriptRecords,
  STAT_CONCURRENCY,
  statTranscriptFiles,
  type TranscriptPathFailure,
} from "./usageTranscriptReader.ts";
import {
  claimedLegacyScanCacheName,
  decodeScanCache,
  dedupeWithinFile,
  LEGACY_SCAN_CACHE_DIRECTORY_NAMES,
  isLegacyScanCacheFileName,
  isRetained,
  isFullSaveDue,
  isScanCacheInput,
  markMissing,
  markPresent,
  mergeCachedSource,
  mergeScanEntry,
  SCAN_CACHE_DIRECTORY_NAME,
  scanCacheDocumentPieces,
  scanCacheSnapshotName,
  USAGE_SCAN_CACHE_VERSION,
  type CachedFile,
  type CachedSource,
  type ScanCache,
} from "./usageScanCache.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const LITELLM_RATES_API_URL =
  "https://api.github.com/repos/BerriAI/litellm/contents/model_prices_and_context_window.json?ref=main";

const RATES_TTL_MS = 24 * 60 * 60 * 1000;

const RATES_REFRESH_FLOOR_MS = 60 * 1000;

// mtime slack includes writes just before local midnight on the window's first day.
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const usageRetentionCutoff = (
  settings: Pick<UsageScanSettings, "usageHistoryRetentionDays">,
  nowMs: number,
) =>
  settings.usageHistoryRetentionDays === "unlimited"
    ? 0
    : Math.max(0, nowMs - settings.usageHistoryRetentionDays * 24 * 60 * 60 * 1000);

// A check on a hung network mount can only be abandoned, not cancelled, so the pass stops
// waiting at its limit and leaves an abandoned path alone for the backoff.
const EXPIRED_FILE_CHECKS_TIMEOUT_MS = 5_000;
const EXPIRED_FILE_CHECK_BACKOFF_MS = 60 * 60 * 1000;
const CACHE_GAP_RETRY_MS = 60_000;
// Past this a sync is taken as stuck on disk, and the scan goes on with what memory holds
// in the rest of the caller's deadline.
const SAVED_USAGE_LOAD_WAIT_MS = 20_000;
const MAX_STORE_RELISTS = 3;
const STALE_TEMP_DIRECTORY_MS = 60 * 60 * 1000;

const TRANSCRIPT_READ_CONCURRENCY = 4;
const LISTING_TTL_MS = 5_000;
const ACTIVE_TRANSCRIPT_AGE_MS = 24 * 60 * 60 * 1000;
const SUMMARY_DEADLINE = "30 seconds";
const SCAN_STALL_MS = 5 * 60 * 1000;
const FOLLOW_UP_TTL_MS = 10_000;
const MAX_SCAN_KEYS = 16;
const monotonicMillis = Clock.monotonicTimeNanos.pipe(Effect.map((ns) => Number(ns / 1_000_000n)));

const transcriptReaders = BUILT_IN_USAGE_DRIVERS.flatMap((driver) =>
  driver.usage?.kind === "transcripts" ? [{ driver, reader: driver.usage }] : [],
);

const scanReaders = BUILT_IN_USAGE_DRIVERS.flatMap((driver) =>
  driver.usage?.kind === "scan" ? [{ driver, reader: driver.usage }] : [],
);

const providerRateModels = new Map(
  BUILT_IN_USAGE_DRIVERS.flatMap(({ usage }) =>
    usage?.rateModel === undefined ? [] : [[usage.provider, usage.rateModel] as const],
  ),
);

const transcriptFormats = new Map(
  transcriptReaders.map(({ reader }) => [reader.provider, reader.format] as const),
);

interface TranscriptSource {
  readonly provider: UsageProviderKind;
  readonly format: TranscriptUsageFormat<unknown>;
  readonly dir: string;
  readonly volumeId: string;
  readonly physicalSourceId?: string;
  readonly fileName?: string;
}

const RatesCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  document: Schema.Unknown,
});
const decodeRatesCache = Schema.decodeUnknownEffect(Schema.fromJsonString(RatesCacheFile));
const encodeRatesCache = Schema.encodeEffect(Schema.fromJsonString(RatesCacheFile));

const ScanCacheJson = Schema.fromJsonString(Schema.Unknown);
const decodeScanCacheFile = Schema.decodeUnknownEffect(ScanCacheJson);
const encodeUsageRecordKey = Schema.encodeSync(ScanCacheJson);
const decodeCachedSource = Schema.decodeUnknownOption(
  Schema.Struct({
    dir: Schema.String,
    volumeId: Schema.String,
    seenAtMs: Schema.optionalKey(Schema.Number),
  }),
);
const decodeCacheVersion = Schema.decodeUnknownOption(Schema.Struct({ version: Schema.Number }));
const decodeSourceRows = Schema.decodeUnknownOption(
  Schema.Struct({
    sources: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    coveredSince: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
  }),
);
const decodeFileRows = Schema.decodeUnknownOption(
  Schema.Struct({ files: Schema.Record(Schema.String, Schema.Unknown) }),
);
const decodeCacheShape = Schema.decodeUnknownOption(
  Schema.Struct({
    version: Schema.Int.check(Schema.isBetween({ minimum: 4, maximum: USAGE_SCAN_CACHE_VERSION })),
    models: Schema.Array(Schema.String),
    sessions: Schema.Array(Schema.String),
  }),
);

const sharedSessionProviders: ReadonlySet<UsageProviderKind> = new Set(
  transcriptReaders.flatMap(({ reader }) =>
    reader.format.sharedSessionsAcrossFiles ? [reader.provider] : [],
  ),
);

// Only shared sessions need cross-file dedupe; per-file occurrence counts make other keys unique.
function sharedSessions(
  files: readonly { readonly records: readonly UsageRecord[] }[],
): ReadonlySet<string> {
  const firstFile = new Map<string, number>();
  const shared = new Set<string>();
  for (const [index, file] of files.entries()) {
    let previous = "";
    for (const { provider, sessionId } of file.records) {
      if (!sharedSessionProviders.has(provider) || sessionId === previous || sessionId.length === 0)
        continue;
      previous = sessionId;
      const first = firstFile.get(sessionId);
      if (first === undefined) firstFile.set(sessionId, index);
      else if (first !== index) shared.add(sessionId);
    }
  }
  return shared;
}

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
    readonly refreshRates: Effect.Effect<UsagePricing>;
    /** Changes with every usage setting, secret environment values included, and reveals none. */
    readonly clientSettingsKey: (settings: ServerSettingsValue) => string;
    /** Standard-speed API-equivalent cost per item at the current prices, aliases and overrides; null when the model has no price. */
    readonly priceTokens: (
      items: ReadonlyArray<{ readonly model: string; readonly totals: UsageTokenTotals }>,
    ) => Effect.Effect<ReadonlyArray<number | null>, UsageReadError>;
  }
>()("t3/usage/UsageService") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const hostEnvironment = yield* HostProcess.Environment;
  const hostPlatform = yield* HostProcess.Platform;
  const hostScope = hostEnvironment[DESKTOP_HOST_SCOPE_ENV]?.trim();
  // A mount or a directory's on-disk name does not change under a running server.
  // A miss is not cached: the directory may not exist yet.
  const physicalSourceIds = new Map<string, Promise<string | undefined>>();
  const physicalSourceId = (dir: string) =>
    Effect.promise(() => {
      const cached = physicalSourceIds.get(dir);
      if (cached !== undefined) return cached;
      const id = readPhysicalSourceId(dir, hostScope, hostPlatform);
      physicalSourceIds.set(dir, id);
      void id.then((resolved) => {
        if (resolved === undefined && physicalSourceIds.get(dir) === id) {
          physicalSourceIds.delete(dir);
        }
      });
      return id;
    });
  const hostname = yield* HostProcess.Hostname;
  const readerContext = yield* Effect.context<BuiltInUsageReadersEnv>();
  const scope = yield* Effect.scope;
  const random = yield* SecureRandom.SecureRandom;
  // A plain hash would let a client test guesses at a low-entropy secret. A persisted key keeps
  // the value stable across restarts, so clients keep their retained answers.
  const settingsKeySecret = yield* (yield* ServerSecretStore.ServerSecretStore)
    .getOrCreateRandom("usage-settings-key", 32)
    .pipe(Effect.orDie);
  const clientSettingsKey = (settings: ServerSettingsValue) =>
    NodeCrypto.createHmac("sha256", settingsKeySecret)
      .update(usageScanSettingsKey(settings))
      .digest("base64url");

  const fileCache: ScanCache = new Map();
  const resolvedRecords = new WeakMap<UsageRecord, UsageRecord>();
  const correctedRecord = (record: UsageRecord) => resolvedRecords.get(record) ?? record;
  const correctedBatch = (records: readonly UsageRecord[]) =>
    records.some((record) => resolvedRecords.has(record)) ? records.map(correctedRecord) : records;
  const sourceCache = new Map<string, CachedSource>();
  /** Monotonic time from which a path whose existence check was abandoned may be checked again. */
  const expiredCheckRetryAt = new Map<string, number>();
  /** Counts changes to fileCache and sourceCache; a sync writes while it is ahead of the saved one. */
  let generation = 0;
  const observedAt = (filePath: string, nowMs: number) =>
    Math.max(nowMs, (fileCache.get(filePath)?.observedAtMs ?? -Infinity) + 1);
  // Earliest window start a complete scan read each transcript directory from.
  const coveredSince = new Map<string, number>();
  let coverageGeneration = 0;
  let savedCoverageGeneration = 0;
  const coverageKey = (source: TranscriptSource) => `${source.provider}\0${source.dir}`;
  const cover = (source: TranscriptSource, windowStartMs: number) => {
    if ((coveredSince.get(coverageKey(source)) ?? Infinity) <= windowStartMs) return;
    coveredSince.set(coverageKey(source), windowStartMs);
    coverageGeneration += 1;
    generation += 1;
  };
  const isWithinDirectory = (filePath: string, dir: string) => {
    const relative = path.relative(dir, filePath);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const writeCacheFile = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  const hostIdPath = path.join(config.baseDir, "usage-host-id");
  const explicitHostId = hostEnvironment["T3CODE_HOST_ID"]?.trim();
  const hostId =
    explicitHostId ||
    (yield* fileSystem.readFileString(hostIdPath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* fileSystem.makeDirectory(config.baseDir, { recursive: true });
              const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
                directory: config.baseDir,
                prefix: "usage-host-id.",
              });
              const tempFile = path.join(tempDirectory, "identity");
              yield* fileSystem.writeFileString(tempFile, `${hostname}\n`);
              // Publish complete contents without replacing another initializer's identity.
              yield* fileSystem.link(tempFile, hostIdPath).pipe(
                Effect.catchIf(
                  (error) => error.reason._tag === "AlreadyExists",
                  () => Effect.void,
                ),
              );
              return yield* fileSystem.readFileString(hostIdPath);
            }),
          ),
      ),
      Effect.map((value) => value.trim() || hostname),
      Effect.orElseSucceed(() => hostname),
    ));
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesLastFailedAtMs: number | null = null;
  let ratesStatus: UsagePricing["status"] = "unavailable";
  const ratesLock = yield* Semaphore.make(1);

  const pricing = (): UsagePricing => ({
    status: ratesStatus,
    source: LITELLM_RATES_URL,
    fetchedAt:
      ratesFetchedAtMs === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
    knownModels: rates.size,
  });

  const fetchRates = (url: string, accept = "application/json") =>
    httpClient.get(url, { headers: { accept } }).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.map((document) => {
        const parsed = parseRateTable(document);
        return parsed.size > 0 ? { document, parsed } : null;
      }),
      Effect.timeout(10_000),
      Effect.catchCause(() => Effect.succeed(null)),
    );

  // Outside ratesLock, which a slow fetch holds: a provisional answer prices with these.
  const loadSavedRates = yield* Effect.cached(
    fileSystem.readFileString(ratesCachePath).pipe(
      Effect.flatMap((raw) => decodeRatesCache(raw)),
      Effect.map((saved) => {
        const parsed = parseRateTable(saved.document);
        if (parsed.size === 0) return;
        rates = parsed;
        ratesFetchedAtMs = saved.fetchedAtMs;
        ratesStatus = "cached";
      }),
      Effect.ignoreCause,
    ),
  );

  const loadRates = Effect.fn("UsageService.loadRates")(function* (force: boolean) {
    const now = yield* Clock.currentTimeMillis;
    const maxAgeMs = force ? RATES_REFRESH_FLOOR_MS : RATES_TTL_MS;
    yield* loadSavedRates;
    if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < maxAgeMs) return;
    if (ratesLastFailedAtMs !== null && now - ratesLastFailedAtMs < RATES_REFRESH_FLOOR_MS) return;

    let fetched = yield* fetchRates(LITELLM_RATES_URL);
    if (fetched === null) {
      fetched = yield* fetchRates(LITELLM_RATES_API_URL, "application/vnd.github.raw+json");
    }
    if (fetched === null) {
      ratesLastFailedAtMs = yield* Clock.currentTimeMillis;
      if (rates.size > 0) ratesStatus = "cached";
      return;
    }

    rates = fetched.parsed;
    ratesFetchedAtMs = now;
    ratesLastFailedAtMs = null;
    ratesStatus = "fresh";

    yield* encodeRatesCache({ fetchedAtMs: now, document: fetched.document }).pipe(
      Effect.flatMap((contents) => writeCacheFile(ratesCachePath, contents)),
      Effect.ignoreCause,
    );
  });

  const ensureRates = (force: boolean) => ratesLock.withPermit(loadRates(force));

  // Rates are kept for RATES_TTL_MS, so a model released after the table was fetched would stay unpriced
  // that long. A scan that meets a model the table does not list refetches early: once per model against
  // a fresh table, with loadRates keeping RATES_REFRESH_FLOOR_MS between attempts.
  const checkedUnlistedModels = new Set<string>();
  const refreshForUnlistedModels = Effect.fn("UsageService.refreshForUnlistedModels")(function* (
    models: ReadonlySet<string>,
  ) {
    const unlisted = [...models].filter(
      (model) => !checkedUnlistedModels.has(model) && isUnlistedModel(rates, model),
    );
    if (unlisted.length === 0) return;
    yield* ensureRates(true);
    const now = yield* Clock.currentTimeMillis;
    // A failed fetch leaves the models unchecked, so a later scan tries again.
    if (ratesFetchedAtMs === null || now - ratesFetchedAtMs >= RATES_REFRESH_FLOOR_MS) return;
    for (const model of unlisted) checkedUnlistedModels.add(model);
  });

  const refreshRates = ensureRates(true).pipe(
    Effect.map(pricing),
    Effect.withSpan("UsageService.refreshRates"),
  );

  const readSettings = settingsService.getSettings.pipe(
    Effect.map((current) => ({
      settings: usageScanSettings(current),
      key: usageScanSettingsKey(current),
    })),
    Effect.mapError(
      (cause) =>
        new UsageReadError({
          reason: "scanFailed",
          detail: "Server settings could not be read.",
          cause,
        }),
    ),
  );

  const usageInstances = Effect.fn("UsageService.usageInstances")(function* <Config>(
    driver: ProviderDriver<Config, unknown, unknown>,
    settings: UsageScanSettings,
  ) {
    const entries: Array<
      readonly [ProviderInstanceId, Pick<ProviderInstanceConfig, "config" | "environment">, boolean]
    > = Object.entries(settings.providerInstances)
      .filter(([, instance]) => instance.driver === driver.driverKind)
      .map(([id, instance]) => [ProviderInstanceId.make(id), instance, true] as const);
    // History in the driver's default home stays counted after every instance moves elsewhere; readers dedupe shared directories.
    entries.push([ProviderInstanceId.make(driver.driverKind), {}, false]);
    const decodeConfig = Schema.decodeUnknownOption(driver.configSchema);
    return yield* Effect.forEach(
      entries,
      Effect.fnUntraced(function* ([instanceId, instance, configured]) {
        const instanceConfig: ProviderUsageInstance<Config> = {
          instanceId,
          config: Option.getOrUndefined(decodeConfig(instance.config ?? {})),
          environment: yield* mergeProviderInstanceEnvironment(
            instance.environment,
            hostEnvironment,
          ),
          configured,
        };
        return instanceConfig;
      }),
    );
  });

  const resolveTranscriptDirs = Effect.fn("UsageService.resolveTranscriptDirs")(function* (
    settings: UsageScanSettings,
    retentionCutoffMs: number,
    awaitRefresh: boolean,
    onProgress: () => void,
  ) {
    const dirs: Array<TranscriptSource> = [];
    const pending: Array<ScannedDir> = [];
    const seen = new Set<string>();
    for (const { driver, reader } of transcriptReaders) {
      const { provider, format } = reader;
      const directories = yield* Effect.forEach(
        yield* usageInstances(driver, settings),
        (instance) =>
          reader
            .directories(instance, { awaitRefresh })
            .pipe(Effect.tap(() => Effect.sync(onProgress))),
      );
      for (const { dir: directory, fileName, refreshing } of directories.flat()) {
        if (refreshing) {
          const key = `${provider}\0${directory}`;
          if (seen.has(key)) continue;
          seen.add(key);
          pending.push({ provider, dir: directory, volumeId: "", files: [], refreshing });
          continue;
        }
        const sourceKey = provider + "\0" + directory;
        const previous = sourceCache.get(sourceKey);
        const dir = yield* fileSystem
          .realPath(directory)
          .pipe(Effect.orElseSucceed(() => previous?.dir ?? directory));
        onProgress();
        const currentVolumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
        onProgress();
        const hasRetainedHistory = fileCache
          .entries()
          .some(
            ([filePath, entry]) =>
              entry.provider === provider &&
              isRetained(entry, retentionCutoffMs) &&
              (entry.records.length + entry.tailRecords.length > 0 ||
                entry.malformedRecords.length > 0) &&
              isWithinDirectory(filePath, dir),
          );
        const volumeId =
          previous?.dir === dir && (hasRetainedHistory || !currentVolumeId)
            ? previous.volumeId || currentVolumeId
            : currentVolumeId;
        if (previous?.dir !== dir || previous.volumeId !== volumeId) {
          sourceCache.set(sourceKey, { dir, volumeId, seenAtMs: yield* Clock.currentTimeMillis });
          generation += 1;
        }
        const key = `${provider}\0${dir}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sourceId = yield* physicalSourceId(dir);
        dirs.push({
          provider,
          format,
          dir,
          volumeId,
          ...(sourceId === undefined ? {} : { physicalSourceId: sourceId }),
          ...(fileName === undefined ? {} : { fileName }),
        });
      }
    }
    return { dirs, pending };
  });

  const storeDir = path.join(config.stateDir, SCAN_CACHE_DIRECTORY_NAME);
  const legacyStoreDirs = LEGACY_SCAN_CACHE_DIRECTORY_NAMES.map((name) =>
    path.join(config.stateDir, name),
  );
  const mergedLegacySnapshots = new Set<string>();
  const writerId = yield* random.uuidV4().pipe(Effect.orDie);
  const platform = hostPlatform;
  let snapshotSeq = 0;
  /** Every name this process wrote or tried to write; a full save deletes all but itself. */
  const ownSnapshots = new Set<string>();
  /** A name fixes its content, so each one is merged at most once. */
  const mergedInputs = new Map<string, "complete" | "incomplete">();
  const unreadInputs = new Set<string>();
  const claimedFrom = new Map<string, string>();
  /** Merged complete and not yet deleted: only a later full save of ours may retire them. */
  const retirable = new Set<string>();
  /** Retirable names in an older format: their rows are saved again, so a full save retires them. */
  const olderFormatInputs = new Set<string>();
  const failedDeletes = new Set<string>();
  /** Characters in each name this process wrote or merged complete, to bound the store. */
  const storedChars = new Map<string, number>();
  /**
   * The row or source a current-format snapshot holds for each key. A snapshot is deleted only
   * after a full save of its deleter holds every live row it held, so a save writes only the
   * keys whose rows differ from these.
   */
  let durableFiles = new Map<string, CachedFile>();
  let durableSources = new Map<string, CachedSource>();
  /** Rows memory dropped that a snapshot still holds; they count toward the next full save. */
  const droppedRows = new Set<string>();
  let savedGeneration = 0;
  let cacheLoaded = false;
  let retryCacheAt = 0;

  type SavedUsageGapKind = "list" | "claim" | "read" | "incomplete" | "load";
  const SAVED_USAGE_GAPS: Record<
    SavedUsageGapKind,
    { readonly log: string; readonly message: string }
  > = {
    list: {
      log: "Could not list saved transcript usage",
      message: "Saved usage could not be listed.",
    },
    claim: {
      log: "Could not move older saved transcript usage into the current cache",
      message: "Older saved usage could not be moved into the current cache.",
    },
    read: {
      log: "Could not read some saved transcript usage",
      message: "Some saved usage could not be read.",
    },
    incomplete: {
      log: "Saved transcript usage is damaged or from a newer version",
      message: "Some saved usage is damaged or from a newer version and is only partly counted.",
    },
    load: {
      log: "Saved transcript usage did not load in time",
      message: "Saved usage has not finished loading.",
    },
  };
  const savedUsageGaps = new Map<
    string,
    { readonly kind: SavedUsageGapKind; readonly path: string }
  >();
  const gapKey = (kind: SavedUsageGapKind, file: string) => `${kind}\0${file}`;
  const reportGap = Effect.fn("UsageService.reportSavedUsageGap")(function* (
    kind: SavedUsageGapKind,
    file: string,
    cause: unknown,
  ) {
    const key = gapKey(kind, file);
    if (savedUsageGaps.has(key)) return;
    savedUsageGaps.set(key, { kind, path: file });
    yield* Effect.logError(SAVED_USAGE_GAPS[kind].log, { path: file, cause });
  });
  const recoverGap = (kind: SavedUsageGapKind, file: string) =>
    savedUsageGaps.delete(gapKey(kind, file))
      ? Effect.logInfo("Recovered saved transcript usage", { path: file })
      : Effect.void;
  const clearGap = (kind: SavedUsageGapKind, file: string) => {
    savedUsageGaps.delete(gapKey(kind, file));
  };
  const savedUsageGapMessage = () => {
    const kinds = new Set([...savedUsageGaps.values()].map(({ kind }) => kind));
    const messages = (Object.keys(SAVED_USAGE_GAPS) as SavedUsageGapKind[])
      .filter((kind) => kinds.has(kind))
      .map((kind) => SAVED_USAGE_GAPS[kind].message);
    return messages.length === 0 ? undefined : messages.join(" ");
  };
  // A damaged file cannot change under its name and a late load ends on its own, so only the
  // other gaps are worth a retry.
  const hasRetryableGap = () =>
    [...savedUsageGaps.values()].some(({ kind }) => kind !== "incomplete" && kind !== "load");

  const decodeDocument = Effect.fn("UsageService.decodeScanCache")(function* (raw: string) {
    const document = yield* decodeScanCacheFile(raw).pipe(Effect.orElseSucceed(() => null));
    const version = Option.getOrUndefined(decodeCacheVersion(document))?.version;
    const shape = decodeCacheShape(document);
    const entries = decodeScanCache(document, transcriptFormats);
    const rows = decodeSourceRows(document);
    const sources = new Map<string, CachedSource>();
    const sourceRows = Option.getOrUndefined(rows)?.sources ?? {};
    for (const [key, row] of Object.entries(sourceRows)) {
      const parsed = decodeCachedSource(row);
      if (Option.isSome(parsed)) sources.set(key, parsed.value);
    }
    const fileRows = decodeFileRows(document);
    const entriesDropped = Option.isSome(fileRows)
      ? Object.keys(fileRows.value.files).length - entries.size
      : null;
    const sourcesDropped = Option.isSome(rows)
      ? Object.keys(sourceRows).length - sources.size
      : null;
    const complete = Option.isSome(shape) && entriesDropped === 0 && sourcesDropped === 0;
    return {
      version,
      entries,
      sources,
      complete,
      entriesDropped,
      sourcesDropped,
      coveredSince: Option.getOrUndefined(rows)?.coveredSince,
    };
  });

  // Merging only adds or supersedes rows, so a row a scan just stored cannot be lost to disk.
  // A row that wins unchanged is already saved, unless an older format holds it: a later
  // build may not read that format, so a snapshot of ours saves the row again.
  const mergeIntoMemory = (
    entries: ScanCache,
    sources: ReadonlyMap<string, CachedSource>,
    durable: boolean,
  ) => {
    let changed = false;
    for (const [file, incoming] of entries) {
      const held = fileCache.get(file);
      const merged = held === undefined ? incoming : mergeScanEntry(held, incoming);
      if (durable && merged === incoming) durableFiles.set(file, incoming);
      if (merged === held) continue;
      fileCache.set(file, merged);
      changed = true;
    }
    for (const [key, incoming] of sources) {
      const held = sourceCache.get(key);
      const merged = held === undefined ? incoming : mergeCachedSource(held, incoming);
      if (durable && merged === incoming) durableSources.set(key, incoming);
      if (merged === held) continue;
      sourceCache.set(key, merged);
      changed = true;
    }
    if (changed) generation += 1;
  };

  const mergeSavedUsage = Effect.fn("UsageService.mergeSavedUsage")(function* (name: string) {
    const file = path.join(storeDir, name);
    const claimedPath = claimedFrom.get(name);
    claimedFrom.delete(name);
    const raw = yield* fileSystem.readFileString(file).pipe(Effect.result);
    if (raw._tag === "Failure") {
      if (claimedPath !== undefined) clearGap("claim", claimedPath);
      if (raw.failure.reason._tag === "NotFound") {
        // Retired after a durable snapshot covered it: a relist finds that snapshot.
        unreadInputs.delete(name);
        clearGap("read", file);
        return "missing" as const;
      }
      unreadInputs.add(name);
      yield* reportGap("read", file, raw.failure);
      return "unread" as const;
    }
    unreadInputs.delete(name);
    const decoded = yield* decodeDocument(raw.success);
    mergeIntoMemory(decoded.entries, decoded.sources, decoded.version === USAGE_SCAN_CACHE_VERSION);
    if (decoded.complete && decoded.version === USAGE_SCAN_CACHE_VERSION) {
      for (const [key, since] of Object.entries(decoded.coveredSince ?? {})) {
        coveredSince.set(key, Math.min(since, coveredSince.get(key) ?? Infinity));
      }
    }
    if (decoded.complete) {
      mergedInputs.set(name, "complete");
      retirable.add(name);
      if (decoded.version !== USAGE_SCAN_CACHE_VERSION) olderFormatInputs.add(name);
      storedChars.set(name, raw.success.length);
      yield* recoverGap("read", file);
      if (claimedPath !== undefined) yield* recoverGap("claim", claimedPath);
      return "complete" as const;
    }
    // Kept and counted as far as it decodes: deleting it would lose what a newer build or a
    // repair could still read.
    mergedInputs.set(name, "incomplete");
    clearGap("read", file);
    if (claimedPath !== undefined) clearGap("claim", claimedPath);
    yield* reportGap("incomplete", file, {
      version: decoded.version ?? null,
      entriesDropped: decoded.entriesDropped,
      sourcesDropped: decoded.sourcesDropped,
    });
    return "incomplete" as const;
  });

  const syncStoreDirectory =
    platform === "win32"
      ? Effect.void
      : Effect.scoped(Effect.flatMap(fileSystem.open(storeDir), (handle) => handle.sync));

  const deleteSavedUsage = Effect.fn("UsageService.deleteSavedUsage")(function* (name: string) {
    const file = path.join(storeDir, name);
    const removed = yield* fileSystem.remove(file).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.void,
      ),
      Effect.result,
    );
    if (removed._tag === "Success") {
      failedDeletes.delete(name);
      return true;
    }
    if (!failedDeletes.has(name)) {
      failedDeletes.add(name);
      yield* Effect.logError("Could not delete saved transcript usage", {
        path: file,
        cause: removed.failure,
      });
    }
    return false;
  });

  /**
   * Settles each row past retention by its last write before an answer picks rows. A file still
   * there has aged out, so its row goes. A file gone since the last listing of its directory
   * starts its missing time now, so its usage does not end early. A failed check counts as gone.
   * Rows the pass does not settle before its time limit stay as they are for a later scan.
   */
  const checkExpiredFiles = Effect.fn("UsageService.checkExpiredFiles")(function* (
    retentionCutoffMs: number,
  ) {
    const startedMs = yield* monotonicMillis;
    for (const [filePath, retryAtMs] of expiredCheckRetryAt) {
      if (retryAtMs <= startedMs) expiredCheckRetryAt.delete(filePath);
    }
    const unchecked: Array<readonly [string, CachedFile]> = [];
    for (const [filePath, entry] of fileCache) {
      if (
        entry.missingSinceMs === undefined &&
        !isRetained(entry, retentionCutoffMs) &&
        !expiredCheckRetryAt.has(filePath)
      ) {
        unchecked.push([filePath, entry]);
      }
    }
    if (unchecked.length === 0) return;
    const nowMs = yield* Clock.currentTimeMillis;
    const running = new Set<string>();
    yield* Effect.forEach(
      unchecked,
      ([filePath, entry]) =>
        Effect.suspend(() => {
          running.add(filePath);
          return fileSystem.exists(filePath);
        }).pipe(
          Effect.orElseSucceed(() => false),
          Effect.map((exists) => {
            running.delete(filePath);
            // A scan may have stored a newer row while the check ran.
            if (fileCache.get(filePath) !== entry) return;
            if (exists) fileCache.delete(filePath);
            else fileCache.set(filePath, markMissing(entry, nowMs));
            generation += 1;
          }),
        ),
      { concurrency: STAT_CONCURRENCY, discard: true },
    ).pipe(Effect.timeoutOption(EXPIRED_FILE_CHECKS_TIMEOUT_MS));
    const retryAtMs = (yield* monotonicMillis) + EXPIRED_FILE_CHECK_BACKOFF_MS;
    for (const filePath of running) expiredCheckRetryAt.set(filePath, retryAtMs);
  });

  /**
   * Drops rows whose files went missing longer than retention ago, without touching the disk.
   * A time ahead of the clock, as a process with its clock set ahead writes, counts from now.
   * A row with a missing time drops a presence time ahead of the clock instead: kept, it would
   * make merges discard the missing time as older than the file's return.
   */
  const dropExpired = Effect.fn("UsageService.dropExpired")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const latest = yield* settingsService.getSettings.pipe(Effect.option);
    const cutoff = Option.isSome(latest) ? usageRetentionCutoff(latest.value, nowMs) : 0;
    for (const [filePath, entry] of fileCache) {
      const { missingSinceMs, presentSinceMs, ...contents } = entry;
      if (missingSinceMs !== undefined && missingSinceMs < cutoff) {
        fileCache.delete(filePath);
      } else if ((missingSinceMs ?? 0) > nowMs || (presentSinceMs ?? 0) > nowMs) {
        fileCache.set(
          filePath,
          missingSinceMs === undefined
            ? { ...contents, presentSinceMs: nowMs }
            : { ...contents, missingSinceMs: Math.min(missingSinceMs, nowMs) },
        );
      } else continue;
      generation += 1;
    }
  });

  /**
   * Publishes a snapshot under a name no reader takes until it is complete. Each piece is written
   * before the next is encoded, so the event loop runs while each write waits. Returns its
   * characters.
   */
  const writeSnapshotFile = Effect.fn("UsageService.writeSnapshotFile")(function* (
    file: string,
    pieces: Iterable<string>,
  ) {
    const temporary = `${file}.tmp`;
    const encoder = new TextEncoder();
    let chars = 0;
    yield* fileSystem.makeDirectory(storeDir, { recursive: true });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fileSystem.open(temporary, { flag: "w" });
        for (const piece of pieces) {
          chars += piece.length;
          yield* handle.writeAll(encoder.encode(piece));
        }
        yield* handle.sync;
      }),
    ).pipe(
      Effect.andThen(retryWhileWindowsLocked(platform, fileSystem.rename(temporary, file))),
      Effect.onError(() => fileSystem.remove(temporary).pipe(Effect.ignore({ log: true }))),
    );
    yield* syncStoreDirectory;
    return chars;
  });

  /** A full save is due by isFullSaveDue; a name whose delete failed does not keep it due. */
  const fullSaveDue = (changedRows: number) =>
    [...olderFormatInputs].some((name) => !failedDeletes.has(name)) ||
    isFullSaveDue({
      liveRows: fileCache.size,
      staleRows: changedRows + droppedRows.size,
      retirableChars: [...ownSnapshots, ...retirable]
        .filter((name) => !failedDeletes.has(name))
        .map((name) => storedChars.get(name) ?? 0),
    });

  /**
   * Saves the rows and sources that differ from saved ones, or every live one when a full save
   * is due. Only a full save deletes: it holds every row the names it retires held.
   */
  const writeSnapshot = Effect.fn("UsageService.writeScanCacheSnapshot")(function* () {
    yield* dropExpired();
    const capturedGeneration = generation;
    const capturedCoverage = coverageGeneration;
    const files = new Map(fileCache);
    const sources = new Map(sourceCache);
    for (const file of durableFiles.keys()) {
      if (files.has(file)) continue;
      durableFiles.delete(file);
      droppedRows.add(file);
    }
    const changedFiles = [...files].filter(([file, entry]) => durableFiles.get(file) !== entry);
    const changedSources = [...sources].filter(
      ([key, source]) => durableSources.get(key) !== source,
    );
    const full = fullSaveDue(changedFiles.length);
    if (
      !full &&
      changedFiles.length === 0 &&
      changedSources.length === 0 &&
      capturedCoverage === savedCoverageGeneration
    ) {
      savedGeneration = capturedGeneration;
      return true;
    }
    const covered = [...retirable];
    snapshotSeq += 1;
    const name = scanCacheSnapshotName(writerId, snapshotSeq);
    const file = path.join(storeDir, name);
    ownSnapshots.add(name);
    const written = yield* writeSnapshotFile(
      file,
      scanCacheDocumentPieces(full ? files : changedFiles, {
        sources: Object.fromEntries(full ? sources : changedSources),
        coveredSince: Object.fromEntries(coveredSince),
      }),
    ).pipe(Effect.result);
    if (written._tag === "Failure") {
      yield* Effect.logError("Could not save transcript usage", {
        path: file,
        cause: written.failure,
      });
      return false;
    }
    storedChars.set(name, written.success);
    savedGeneration = capturedGeneration;
    savedCoverageGeneration = capturedCoverage;
    if (!full) {
      for (const [changed, entry] of changedFiles) durableFiles.set(changed, entry);
      for (const [key, source] of changedSources) durableSources.set(key, source);
      return true;
    }
    durableFiles = files;
    durableSources = sources;
    droppedRows.clear();
    // Only now is everything these names held durable in a snapshot of ours.
    for (const own of ownSnapshots) {
      if (own !== name && (yield* deleteSavedUsage(own))) {
        ownSnapshots.delete(own);
        storedChars.delete(own);
      }
    }
    for (const input of covered) {
      if (yield* deleteSavedUsage(input)) {
        retirable.delete(input);
        olderFormatInputs.delete(input);
        storedChars.delete(input);
      }
    }
    return true;
  });

  /**
   * Lists the store, claims older single-file caches into it and merges every name not merged
   * before. With `write`, it then saves what memory holds that no snapshot does, or compacts the
   * store when a full save is due. Returns false when that write failed.
   */
  const syncScanCache = Effect.fn("UsageService.syncScanCache")(function* (write: boolean) {
    const retryDue = (yield* monotonicMillis) >= retryCacheAt;
    const recoveredLists: string[] = [];
    const present = new Set<string>();
    let storeListed = false;
    let mergedAllComplete = true;

    const list = Effect.fnUntraced(function* (dir: string) {
      if (!retryDue && savedUsageGaps.has(gapKey("list", dir))) return undefined;
      const listed = yield* fileSystem.readDirectory(dir).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed<readonly string[]>([]),
        ),
        Effect.result,
      );
      if (listed._tag === "Failure") {
        yield* reportGap("list", dir, listed.failure);
        return undefined;
      }
      if (savedUsageGaps.delete(gapKey("list", dir))) recoveredLists.push(dir);
      return listed.success;
    });
    const listStore = Effect.gen(function* () {
      const names = yield* list(storeDir);
      if (names !== undefined) storeListed = true;
      const inputs = (names ?? []).filter(isScanCacheInput);
      for (const name of inputs) present.add(name);
      return inputs;
    });

    let pending = yield* listStore;
    let missing = false;
    const stateNames = yield* list(config.stateDir);
    if (stateNames !== undefined) {
      const staleBefore = (yield* Clock.currentTimeMillis) - STALE_TEMP_DIRECTORY_MS;
      for (const name of stateNames) {
        const suffix = name.lastIndexOf(".");
        if (suffix < 0 || !isLegacyScanCacheFileName(name.slice(0, suffix))) continue;
        const temporary = path.join(config.stateDir, name);
        yield* fileSystem.stat(temporary).pipe(
          Effect.flatMap((info) => {
            const modified = Option.getOrUndefined(info.mtime)?.getTime();
            return info.type === "Directory" && modified !== undefined && modified <= staleBefore
              ? fileSystem.remove(temporary, { recursive: true })
              : Effect.void;
          }),
          Effect.ignore,
        );
      }
      for (const gap of savedUsageGaps.values()) {
        if (gap.kind === "claim" && !stateNames.includes(path.basename(gap.path))) {
          clearGap("claim", gap.path);
        }
      }
      for (const legacyName of stateNames.filter(isLegacyScanCacheFileName)) {
        const legacyPath = path.join(config.stateDir, legacyName);
        if (!retryDue && savedUsageGaps.has(gapKey("claim", legacyPath))) continue;
        const claimId = yield* random.uuidV4().pipe(Effect.orDie);
        const claimedName = claimedLegacyScanCacheName(claimId, legacyName);
        const claimed = yield* fileSystem
          .makeDirectory(storeDir, { recursive: true })
          .pipe(
            Effect.andThen(fileSystem.rename(legacyPath, path.join(storeDir, claimedName))),
            Effect.result,
          );
        if (claimed._tag === "Success") {
          claimedFrom.set(claimedName, legacyPath);
          present.add(claimedName);
          pending.push(claimedName);
        } else if (claimed.failure.reason._tag === "NotFound") {
          // A peer claimed it first; its claim, or the snapshot that covers it, is in the store.
          clearGap("claim", legacyPath);
          missing = true;
        } else {
          yield* reportGap("claim", legacyPath, claimed.failure);
        }
      }
    }

    // Older writers may still append snapshots here. Copy their rows without retiring their files.
    for (const dir of legacyStoreDirs) {
      const names = yield* list(dir);
      if (names === undefined) continue;
      const files = new Set(names.filter(isScanCacheInput).map((name) => path.join(dir, name)));
      for (const tracked of mergedLegacySnapshots) {
        if (path.dirname(tracked) === dir && !files.has(tracked))
          mergedLegacySnapshots.delete(tracked);
      }
      for (const file of files) {
        if (
          mergedLegacySnapshots.has(file) ||
          (!retryDue && savedUsageGaps.has(gapKey("read", file)))
        )
          continue;
        const raw = yield* fileSystem.readFileString(file).pipe(Effect.result);
        if (raw._tag === "Failure") {
          if (raw.failure.reason._tag !== "NotFound") yield* reportGap("read", file, raw.failure);
          continue;
        }
        const decoded = yield* decodeDocument(raw.success);
        mergeIntoMemory(decoded.entries, decoded.sources, false);
        mergedLegacySnapshots.add(file);
        yield* recoverGap("read", file);
        if (!decoded.complete)
          yield* reportGap("incomplete", file, {
            version: decoded.version ?? null,
            entriesDropped: decoded.entriesDropped,
            sourcesDropped: decoded.sourcesDropped,
          });
      }
    }

    for (let relists = 0; ; relists += 1) {
      for (const name of pending) {
        if (ownSnapshots.has(name) || mergedInputs.has(name)) continue;
        if (unreadInputs.has(name) && !retryDue) continue;
        const outcome = yield* mergeSavedUsage(name);
        if (outcome === "missing") missing = true;
        else if (outcome !== "complete") mergedAllComplete = false;
      }
      if (!missing) break;
      if (relists === MAX_STORE_RELISTS) {
        yield* reportGap("list", storeDir, "Saved usage kept changing while it was read.");
        mergedAllComplete = false;
        break;
      }
      missing = false;
      pending = yield* listStore;
    }

    if (storeListed) {
      // Names are never reused, so a name the store no longer lists needs no tracking.
      for (const name of [...mergedInputs.keys(), ...ownSnapshots]) {
        if (present.has(name)) continue;
        mergedInputs.delete(name);
        ownSnapshots.delete(name);
        retirable.delete(name);
        olderFormatInputs.delete(name);
        failedDeletes.delete(name);
        storedChars.delete(name);
      }
      for (const gap of savedUsageGaps.values()) {
        if (path.dirname(gap.path) !== storeDir || present.has(path.basename(gap.path))) continue;
        if (gap.kind === "incomplete") {
          clearGap("incomplete", gap.path);
          yield* Effect.logWarning(
            "Damaged saved transcript usage was removed; the part that could not be read is not counted",
            { path: gap.path },
          );
        } else if (gap.kind === "read") {
          clearGap("read", gap.path);
          unreadInputs.delete(path.basename(gap.path));
        }
      }
    }

    const needsWrite = write && (generation !== savedGeneration || fullSaveDue(0));
    const saved = needsWrite ? yield* writeSnapshot() : true;

    for (const dir of recoveredLists) {
      if (mergedAllComplete && !savedUsageGaps.has(gapKey("list", dir))) {
        yield* Effect.logInfo("Recovered saved transcript usage", { path: dir });
      }
    }
    cacheLoaded = true;
    if (retryDue && hasRetryableGap()) {
      retryCacheAt = (yield* monotonicMillis) + CACHE_GAP_RETRY_MS;
    }
    return saved;
  });

  const syncLock = yield* Semaphore.make(1);
  /** Every sync runs on a fiber held here, so shutdown can stop them all and take the permit at once. */
  const syncFibers = new Set<Fiber.Fiber<boolean>>();
  const forkSync = (sync: Effect.Effect<boolean>) =>
    Effect.forkDetach(syncLock.withPermit(sync)).pipe(
      Effect.tap((fiber) =>
        Effect.sync(() => {
          syncFibers.add(fiber);
          fiber.addObserver(() => syncFibers.delete(fiber));
        }),
      ),
    );
  const scanCacheLoadDue = Effect.gen(function* () {
    if (!cacheLoaded) return true;
    return hasRetryableGap() && (yield* monotonicMillis) >= retryCacheAt;
  });
  const loadScanCache = Effect.gen(function* () {
    return (yield* scanCacheLoadDue) ? yield* syncScanCache(false) : true;
  });
  // Only a first load or a due retry makes a scan wait, and never for a write: the scan's own
  // persist saves what the load merged. A late load keeps running, and scans skip it until it ends.
  const ensureScanCacheLoaded = Effect.gen(function* () {
    if (savedUsageGaps.has(gapKey("load", storeDir)) || !(yield* scanCacheLoadDue)) return;
    let ended: Exit.Exit<boolean> | undefined;
    // Only a load that outlived its wait, and so reported the gap, has no caller left to see its end.
    // That end says only that the load ended; a list or read gap it left reports itself.
    const settleLateLoad = Effect.suspend(() => {
      if (ended === undefined || !savedUsageGaps.delete(gapKey("load", storeDir))) {
        return Effect.void;
      }
      if (Exit.isSuccess(ended)) {
        return Effect.logInfo("Saved transcript usage finished loading", { path: storeDir });
      }
      return Cause.hasInterruptsOnly(ended.cause)
        ? Effect.void
        : Effect.logError("Saved transcript usage failed to load", {
            path: storeDir,
            cause: ended.cause,
          });
    });
    const load = yield* forkSync(
      loadScanCache.pipe(
        Effect.onExit((exit) => {
          ended = exit;
          return settleLateLoad;
        }),
      ),
    );
    const loaded = yield* Fiber.join(load).pipe(Effect.timeoutOption(SAVED_USAGE_LOAD_WAIT_MS));
    if (Option.isSome(loaded) || ended !== undefined) return;
    yield* reportGap("load", storeDir, "The saved usage sync did not finish in time.");
    // The load can end while the gap is reported, before there is a gap for it to settle.
    yield* settleLateLoad;
  });
  // A persist saves memory as it is when it gets the lock, so one still waiting covers every scan
  // behind it, and a hung sync holds one waiting persist rather than one per scan.
  let persistWaiting = false;
  const schedulePersist = Effect.suspend(() => {
    if (persistWaiting) return Effect.void;
    persistWaiting = true;
    const persist = Effect.suspend(() => {
      persistWaiting = false;
      return syncScanCache(true);
    });
    return forkSync(persist).pipe(Effect.asVoid);
  });
  const awaitPersisted = Effect.suspend(() => Fiber.awaitAll([...syncFibers])).pipe(Effect.asVoid);
  // An interrupted sync loses nothing: the final sync writes whatever it left unsaved.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Fiber.interruptAll([...syncFibers]);
      if (yield* syncLock.withPermit(syncScanCache(true))) return;
      yield* Effect.logError("Could not finish saving transcript usage at shutdown", {
        path: storeDir,
        unsavedRows: [...fileCache].filter(([file, entry]) => durableFiles.get(file) !== entry)
          .length,
      });
    }),
  );
  // Claim older caches promptly, before an older build sharing this directory rewrites them.
  // Forked after the finalizer so a shutdown stops this fiber before the final sync.
  yield* Effect.suspend(() => fileSystem.readDirectory(config.stateDir)).pipe(
    Effect.map((names) => names.some(isLegacyScanCacheFileName)),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(false),
    ),
    Effect.orElseSucceed(() => true),
    Effect.flatMap((due) => (due ? forkSync(loadScanCache) : Effect.void)),
    Effect.forkIn(scope),
  );

  /** The earliest first record wins duplicate credit, with byte-ordered paths breaking ties. */
  const readFileRecords = Effect.fn("UsageService.readFileRecords")(function* (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
    format: TranscriptUsageFormat<unknown>,
    onProgress: () => void,
  ): Effect.fn.Return<{
    readonly records: readonly UsageRecord[];
    readonly malformedRecords: readonly number[];
    readonly failure?: TranscriptPathFailure;
    readonly update?: Omit<CachedFile, "observedAtMs">;
  }> {
    const cached = fileCache.get(filePath);
    // Provider is part of the identity: if both providers were ever pointed
    // at one directory, a hit parsed by the other parser must not be reused.
    if (
      cached &&
      !cached.needsReparse &&
      cached.size === size &&
      cached.mtimeMs === mtimeMs &&
      cached.provider === provider
    ) {
      return {
        records:
          cached.tailRecords.length === 0
            ? cached.records
            : [...cached.records, ...cached.tailRecords],
        malformedRecords: cached.malformedRecords,
      };
    }

    // Only a strictly grown file may resume. Same size with a new mtime, or
    // a shrunken file, means rewritten content; re-parse it whole.
    const resumeFrom =
      cached !== undefined &&
      !cached.needsReparse &&
      cached.provider === provider &&
      size > cached.size
        ? cached.position
        : undefined;

    const read = yield* Effect.tryPromise({
      try: (signal) => readTranscriptRecords(filePath, format, resumeFrom, { signal, onProgress }),
      catch: (cause): TranscriptPathFailure => ({ path: filePath, cause }),
    }).pipe(Effect.result);
    // A read failure is not an empty transcript: caching it under this
    // (size, mtime) would silently drop the file's usage until it changes.
    if (read._tag === "Failure") {
      const kept = {
        records: cached?.provider === provider ? [...cached.records, ...cached.tailRecords] : [],
        malformedRecords: cached?.provider === provider ? cached.malformedRecords : [],
      };
      // A file removed since the listing is gone, not unreadable; the next listing marks it missing.
      if (isGone(read.failure.cause)) return kept;
      return { ...kept, failure: read.failure };
    }
    const parsed = read.success;

    const identity = (record: UsageRecord) =>
      encodeUsageRecordKey([
        record.provider,
        record.sessionId,
        record.timestampMs,
        record.model,
        record.rateModel,
        record.totals,
        record.reportedCostUsd,
        record.dedupeKey,
      ]);
    if (!parsed.resumed && cached !== undefined && cached.provider === provider) {
      // A whole-file re-parse re-emits saved requests unresolved. Keep their saved tier
      // corrections, since the history that resolved them may no longer be available.
      // Equal requests keep their own corrections by matching occurrences in order.
      const saved = new Map<string, UsageRecord[]>();
      for (const previous of [...cached.records, ...cached.tailRecords]) {
        const corrected = correctedRecord(previous);
        const key = identity(corrected);
        const occurrences = saved.get(key);
        if (occurrences === undefined) saved.set(key, [corrected]);
        else occurrences.push(corrected);
      }
      for (const record of [...parsed.records, ...parsed.tailRecords]) {
        const corrected = saved.get(identity(record))?.shift();
        if (
          record.unresolvedServiceTierTurnId !== undefined &&
          corrected !== undefined &&
          corrected.unresolvedServiceTierTurnId === undefined
        ) {
          resolvedRecords.set(record, corrected);
        }
      }
    }
    if (parsed.resumed && cached !== undefined && cached.tailRecords.length > 0) {
      // Completing a tentative line reparses it. Reuse its saved correction only when the
      // same usage is emitted again, without putting inferred tiers in the parser state.
      const reparsed = [...parsed.records, ...parsed.tailRecords];
      for (const [index, previous] of cached.tailRecords.entries()) {
        const record = reparsed[index];
        const corrected = correctedRecord(previous);
        if (
          record?.unresolvedServiceTierTurnId !== undefined &&
          corrected.unresolvedServiceTierTurnId === undefined &&
          identity(record) === identity(corrected)
        ) {
          resolvedRecords.set(record, corrected);
        }
      }
    }
    const base = parsed.resumed && cached !== undefined ? cached.records : [];
    const records = dedupeWithinFile([...base, ...parsed.records]);
    const tailRecords = parsed.tailRecords;

    return {
      records: tailRecords.length === 0 ? records : [...records, ...tailRecords],
      malformedRecords: parsed.malformedRecords,
      update: {
        size,
        mtimeMs,
        provider,
        records,
        tailRecords,
        malformedRecords: parsed.malformedRecords,
        position: parsed.position,
      },
    };
  });

  interface ScannedDir {
    readonly provider: UsageProviderKind;
    readonly dir: string;
    readonly volumeId: string;
    readonly physicalSourceId?: string;
    readonly hostId?: string;
    readonly status?: UsageSource["status"];
    readonly message?: string;
    readonly files:
      | readonly {
          readonly path: string;
          readonly records: readonly UsageRecord[];
          readonly malformedRecords: readonly number[];
        }[]
      | null;

    readonly refreshing?: true;
  }

  type Listing = Awaited<ReturnType<typeof listTranscriptFiles>>;
  const listings = new Map<string, Listing & { readonly expiresAt: number }>();

  const transcriptListing = Effect.fn("UsageService.transcriptListing")(function* (
    key: string,
    dir: string,
    fileName: string | undefined,
    onProgress: () => void,
  ) {
    const now = yield* monotonicMillis;
    const cached = listings.get(key);
    if (cached === undefined || cached.expiresAt <= now) {
      const result = yield* Effect.promise((signal) =>
        listTranscriptFiles(dir, -Infinity, { fileName, signal, onProgress }),
      );
      const completedAt = yield* monotonicMillis;
      for (const [key, entry] of listings) {
        if (entry.expiresAt <= completedAt) listings.delete(key);
      }
      listings.set(key, { ...result, expiresAt: completedAt + LISTING_TTL_MS });
      return result;
    }

    const hotSince = (yield* Clock.currentTimeMillis) - ACTIVE_TRANSCRIPT_AGE_MS;
    const hotPaths = cached.files
      .filter((file) => file.mtimeMs >= hotSince)
      .map((file) => file.path);
    const updated = yield* Effect.promise((signal) =>
      statTranscriptFiles(hotPaths, -Infinity, { signal, onProgress }),
    );
    const byPath = new Map(updated.files.map((file) => [file.path, file]));
    const files = cached.files.flatMap((file) => {
      if (file.mtimeMs < hotSince) return [file];
      const current = byPath.get(file.path);
      return current === undefined ? [] : [current];
    });
    return { files, failures: [...cached.failures, ...updated.failures] };
  });

  /**
   * Paths each listing key logged as unreadable. A path logs again after it reads or goes, or when a
   * real cause follows a pending call, whose own result reaches no caller.
   */
  type LoggedFailure = "pending" | "failed";
  const loggedUnreadable = new Map<string, ReadonlyMap<string, LoggedFailure>>();
  const logUnreadablePaths = Effect.fn("UsageService.logUnreadablePaths")(function* (
    key: string,
    failures: readonly TranscriptPathFailure[],
    listing: Listing,
    read: readonly { readonly path: string }[],
  ) {
    const logged = loggedUnreadable.get(key);
    if (logged === undefined && failures.length === 0) return;
    const unreadable = new Map<string, LoggedFailure>();
    for (const { path: failedPath, cause } of failures) {
      const before = unreadable.get(failedPath) ?? logged?.get(failedPath);
      const now: LoggedFailure = isPathCallPending(cause) ? "pending" : "failed";
      if (before === undefined || (before === "pending" && now === "failed")) {
        yield* Effect.logError("Could not read transcript usage", { path: failedPath, cause });
      }
      unreadable.set(failedPath, before === "failed" ? before : now);
    }
    if (logged !== undefined) {
      // A path this scan did not try has not read again while it is listed, or while a failed path
      // above it may have hidden it. Otherwise it is gone or, as a folder, read again.
      const tried = new Set(read.map((file) => file.path));
      const listed = new Set(listing.files.map((file) => file.path));
      for (const [loggedPath, before] of logged) {
        if (unreadable.has(loggedPath) || tried.has(loggedPath)) continue;
        const hidden = listing.failures.some(({ path: failedPath }) =>
          isWithinDirectory(loggedPath, failedPath),
        );
        if (listed.has(loggedPath) || hidden) unreadable.set(loggedPath, before);
      }
    }
    if (unreadable.size === 0) loggedUnreadable.delete(key);
    else loggedUnreadable.set(key, unreadable);
  });

  /**
   * A listed file that had gone missing clears its missing time and records when it came back.
   * observedAtMs stays: only a read of the file may make a row win over another process's row.
   */
  const recordPresent = (provider: UsageProviderKind, present: Listing["files"], nowMs: number) => {
    for (const { path: filePath } of present) {
      const entry = fileCache.get(filePath);
      if (entry?.provider !== provider || entry.missingSinceMs === undefined) continue;
      fileCache.set(filePath, markPresent(entry, nowMs));
      generation += 1;
    }
  };

  /** A complete listing that lacks a cached file starts its missing time. */
  const recordMissing = (
    provider: UsageProviderKind,
    dir: string,
    present: ReadonlySet<string>,
    nowMs: number,
  ) => {
    for (const [filePath, entry] of fileCache) {
      if (
        entry.provider !== provider ||
        entry.missingSinceMs !== undefined ||
        present.has(filePath) ||
        !isWithinDirectory(filePath, dir)
      ) {
        continue;
      }
      fileCache.set(filePath, markMissing(entry, nowMs));
      generation += 1;
    }
  };

  const scanTranscriptDir = Effect.fn("UsageService.scanTranscriptDir")(function* (
    source: TranscriptSource,
    windowStartMs: number,
    scanListings: Map<string, Listing>,
    onProgress: () => void,
  ) {
    const { provider, format, dir, volumeId, physicalSourceId, fileName } = source;
    const identity = {
      provider,
      dir,
      volumeId,
      ...(physicalSourceId === undefined ? {} : { physicalSourceId }),
    };
    const key = `${dir}\0${fileName ?? ""}`;
    const exists = yield* fileSystem.exists(dir).pipe(Effect.catchCause(() => Effect.void));
    if (exists !== true) {
      listings.delete(key);
      // A failed check says nothing about the files, so only a directory known gone marks them.
      if (exists === false) {
        loggedUnreadable.delete(key);
        recordMissing(provider, dir, new Set(), yield* Clock.currentTimeMillis);
      }
      if (exists === false) cover(source, windowStartMs);
      return { ...identity, files: null } satisfies ScannedDir;
    }
    const listing =
      scanListings.get(key) ?? (yield* transcriptListing(key, dir, fileName, onProgress));
    scanListings.set(key, listing);
    const listedAtMs = yield* Clock.currentTimeMillis;
    recordPresent(provider, listing.files, listedAtMs);
    // A listing that could not read every path cannot tell which files are gone.
    if (listing.failures.length === 0) {
      recordMissing(provider, dir, new Set(listing.files.map((file) => file.path)), listedAtMs);
    }
    const candidates = listing.files.filter((file) => file.mtimeMs >= windowStartMs);
    const read = yield* Effect.forEach(
      candidates,
      (file) =>
        readFileRecords(file.path, file.size, file.mtimeMs, provider, format, onProgress).pipe(
          Effect.flatMap(({ records, malformedRecords, failure, update }) =>
            Effect.gen(function* () {
              onProgress();
              if (update !== undefined) {
                fileCache.set(file.path, {
                  ...update,
                  observedAtMs: observedAt(file.path, yield* Clock.currentTimeMillis),
                  records: correctedBatch(update.records),
                  tailRecords: correctedBatch(update.tailRecords),
                });
                generation += 1;
              }
              return {
                path: file.path,
                records,
                malformedRecords,
                failure,
                parsed: update !== undefined,
              };
            }),
          ),
        ),
      { concurrency: TRANSCRIPT_READ_CONCURRENCY },
    );
    const failures = [
      ...listing.failures,
      ...read.flatMap(({ failure }) => (failure === undefined ? [] : [failure])),
    ];
    yield* logUnreadablePaths(key, failures, listing, read);
    const unread = failures.length;
    if (unread === 0) {
      const livePaths = new Set(listing.files.map((file) => file.path));
      for (const file of read) {
        if (file.failure !== undefined || !file.path.endsWith(".jsonl.zst")) continue;
        const original = file.path.slice(0, -4);
        if (!livePaths.has(original) && fileCache.delete(original)) generation += 1;
      }
      cover(source, windowStartMs);
    }
    yield* Effect.annotateCurrentSpan({
      "usage.files": candidates.length,
      "usage.files_parsed": read.filter((file) => file.parsed).length,
    });
    return {
      ...identity,
      files: read,
      ...(unread > 0
        ? {
            status: "partial",
            message: `${unread} transcript path(s) could not be read; usage may be incomplete.`,
          }
        : {}),
    } satisfies ScannedDir;
  });

  const collectProviderDirs = Effect.fn("UsageService.collectProviderDirs")(function* (
    windowStartMs: number,
    settings: UsageScanSettings,
    retentionCutoffMs: number,
    awaitRefresh: boolean,
    providers?: ReadonlySet<UsageProviderKind>,
    completed?: Map<UsageProviderKind, readonly ScannedDir[]>,
  ) {
    const scanned = yield* Effect.forEach(
      scanReaders.filter(({ reader }) => providers === undefined || providers.has(reader.provider)),
      ({ driver, reader }) =>
        usageInstances(driver, settings).pipe(
          Effect.flatMap((instances) =>
            reader.scan({ instances, settings, windowStartMs, retentionCutoffMs, awaitRefresh }),
          ),
          Effect.flatMap((sources) =>
            Effect.forEach(sources, ({ volumeId, ...source }) =>
              Effect.map(
                // A reader's own volumeId names a remote account, not a local directory.
                volumeId === undefined
                  ? Effect.all([
                      Effect.promise(() => readDirectoryVolumeId(source.dir)),
                      physicalSourceId(source.dir),
                    ])
                  : Effect.succeed<[string, string | undefined]>([volumeId, undefined]),
                ([resolved, sourceId]): ScannedDir => ({
                  ...source,
                  files: source.files?.map((file) => ({ ...file, malformedRecords: [] })) ?? null,
                  provider: reader.provider,
                  volumeId: resolved,
                  ...(sourceId === undefined ? {} : { physicalSourceId: sourceId }),
                }),
              ),
            ),
          ),
          Effect.tap((sources) => Effect.sync(() => completed?.set(reader.provider, sources))),
          Effect.provideContext(readerContext),
        ),
      { concurrency: "unbounded" },
    );

    return scanned.flat();
  });

  type ScanWindow = {
    readonly hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null;
    readonly windowStartMs: number;
    readonly retentionCutoffMs: number;
    readonly startedAtMs: number;
    readonly rates: RateTable;
    readonly pricing: UsagePricing;
    readonly fromMemory?: boolean;
  };

  interface ScanFlight {
    readonly key: string;
    readonly input: UsageSummaryInput;
    readonly settings: UsageScanSettings;
    readonly saved: Deferred.Deferred<UsageSummary, UsageReadError>;
    readonly initial: Deferred.Deferred<UsageSummary, UsageReadError>;
    readonly refreshed: Deferred.Deferred<UsageSummary, UsageReadError>;
    snapshot?: UsageSummary;
    needsFollowUp: boolean;
  }

  const scanSummary = Effect.fn("UsageService.scanSummary")(function* (
    input: UsageSummaryInput,
    settings: UsageScanSettings,
    flight: ScanFlight,
    onProgress: () => void,
  ): Effect.fn.Return<UsageSummary, UsageReadError> {
    if (input.sinceDay > input.untilDay) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }

    let hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null = null;
    if (input.resolution === "hour") {
      const sinceTime =
        input.sinceTime === undefined ? Option.none() : DateTime.make(input.sinceTime);
      const untilTime =
        input.untilTime === undefined ? Option.none() : DateTime.make(input.untilTime);
      if (Option.isNone(sinceTime) || Option.isNone(untilTime)) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage requires valid sinceTime and untilTime instants",
        });
      }
      const sinceTimeMs = DateTime.toEpochMillis(sinceTime.value);
      const untilTimeMs = DateTime.toEpochMillis(untilTime.value);
      const durationMs = untilTimeMs - sinceTimeMs;
      if (durationMs <= 0 || durationMs > MAX_HOURLY_WINDOW_MS) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage window must be greater than zero and at most 7 days",
        });
      }
      hourlyWindow = { sinceTimeMs, untilTimeMs };
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    yield* ensureScanCacheLoaded;

    const windowStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    if (Option.isNone(windowStart)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is not a valid date`,
      });
    }
    const windowStartMs =
      (hourlyWindow?.sinceTimeMs ?? DateTime.toEpochMillis(windowStart.value)) - MTIME_SLACK_MS;

    const retentionCutoffMs = usageRetentionCutoff(settings, startedAtMs);

    const completedProviders = new Map<UsageProviderKind, readonly ScannedDir[]>();
    const rateLoad = yield* ensureRates(false).pipe(Effect.forkChild);
    const providerLoad = yield* collectProviderDirs(
      windowStartMs,
      settings,
      retentionCutoffMs,
      false,
      undefined,
      completedProviders,
    ).pipe(Effect.forkChild);
    const { dirs, pending } = yield* resolveTranscriptDirs(
      settings,
      retentionCutoffMs,
      false,
      onProgress,
    ).pipe(Effect.provideContext(readerContext));
    const makeWindow = (fromMemory = false): ScanWindow => ({
      hourlyWindow,
      windowStartMs,
      retentionCutoffMs,
      startedAtMs,
      rates,
      pricing: pricing(),
      fromMemory,
    });
    const providerProgress = () =>
      scanReaders.flatMap(
        ({ reader }) =>
          completedProviders.get(reader.provider) ?? [
            {
              provider: reader.provider,
              dir: `usage-refresh:${reader.provider}`,
              volumeId: "",
              files: [],
              status: "partial" as const,
              message: "Usage source is still refreshing.",
              refreshing: true as const,
            },
          ],
      );
    if (
      input.provisional === true &&
      input.awaitRefresh !== true &&
      savedUsageGapMessage() === undefined &&
      dirs.length > 0 &&
      new Set(dirs.map(({ dir }) => dir)).size === dirs.length &&
      dirs.every((source) => (coveredSince.get(coverageKey(source)) ?? Infinity) <= windowStartMs)
    ) {
      yield* loadSavedRates;
      const saved = yield* aggregateSummary(
        input,
        settings,
        [
          ...dirs.map((source): ScannedDir => ({ ...source, files: [] })),
          ...pending,
          ...providerProgress(),
        ],
        makeWindow(true),
      );
      if (saved.buckets.length > 0) {
        flight.snapshot = saved;
        yield* Deferred.succeed(flight.saved, saved);
      }
    }
    const scanListings = new Map<string, Listing>();
    const transcripts = yield* Effect.forEach(dirs, (dir) =>
      scanTranscriptDir(dir, windowStartMs, scanListings, onProgress),
    );
    const latestRetention = yield* settingsService.getSettings.pipe(Effect.option);
    if (Option.isSome(latestRetention)) {
      yield* checkExpiredFiles(usageRetentionCutoff(latestRetention.value, startedAtMs));
    }

    yield* Fiber.join(rateLoad);
    const window = makeWindow();
    if (providerLoad.pollUnsafe() === undefined) {
      flight.snapshot = yield* aggregateSummary(
        input,
        settings,
        [...transcripts, ...pending, ...providerProgress()],
        window,
      );
    }
    const providers = yield* Fiber.join(providerLoad);
    const initial = yield* aggregateSummary(
      input,
      settings,
      [...transcripts, ...pending, ...providers],
      window,
      flight,
    );
    flight.snapshot = initial;
    const refreshing = new Set(
      providers.filter((source) => source.refreshing).map((source) => source.provider),
    );
    if (refreshing.size === 0 && pending.length === 0) return initial;

    yield* schedulePersist;
    flight.needsFollowUp = true;
    yield* Deferred.succeed(flight.saved, initial);
    yield* Deferred.succeed(flight.initial, initial);
    const refreshedProviders = collectProviderDirs(
      windowStartMs,
      settings,
      retentionCutoffMs,
      true,
      refreshing,
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Usage source refresh failed", { reason: error.reason }).pipe(
          Effect.as(
            providers
              .filter((source) => refreshing.has(source.provider))
              .map(({ refreshing: _, ...source }): ScannedDir => ({
                ...source,
                status: "failed",
                message: "Usage source could not be refreshed.",
              })),
          ),
        ),
      ),
    );
    const refreshedTranscripts =
      pending.length === 0
        ? Effect.succeed(transcripts)
        : resolveTranscriptDirs(settings, retentionCutoffMs, true, onProgress).pipe(
            Effect.provideContext(readerContext),
            Effect.flatMap(({ dirs, pending }) =>
              Effect.forEach(dirs, (dir) =>
                scanTranscriptDir(dir, windowStartMs, scanListings, onProgress),
              ).pipe(Effect.map((scanned) => [...scanned, ...pending])),
            ),
          );
    const [refreshed, updatedTranscripts] = yield* Effect.all(
      [refreshedProviders, refreshedTranscripts],
      { concurrency: 2 },
    );
    return yield* aggregateSummary(
      input,
      settings,
      [
        ...updatedTranscripts,
        ...providers.filter((source) => !refreshing.has(source.provider)),
        ...refreshed,
      ],
      makeWindow(),
    );
  });

  const aggregateSummary = Effect.fn("UsageService.aggregateSummary")(function* (
    input: UsageSummaryInput,
    settings: UsageScanSettings,
    scannedDirs: readonly ScannedDir[],
    window: ScanWindow,
    flight?: ScanFlight,
  ) {
    const { hourlyWindow, windowStartMs, retentionCutoffMs, startedAtMs, fromMemory } = window;
    const inWindow = usageTimestampFilter({ ...input, ...hourlyWindow });
    // Deleted transcripts' saved usage still aggregates and deduplicates normally.
    const filesByDir = scannedDirs.map(({ provider, dir, files }) => {
      const retainedFiles = [...(files ?? [])];
      const livePaths = new Set(retainedFiles.map((file) => file.path));
      for (const [filePath, entry] of fileCache) {
        if (
          entry.provider !== provider ||
          entry.mtimeMs < windowStartMs ||
          !isRetained(entry, retentionCutoffMs) ||
          livePaths.has(filePath) ||
          !isWithinDirectory(filePath, dir)
        )
          continue;
        retainedFiles.push({
          path: filePath,
          records: [...entry.records, ...entry.tailRecords],
          malformedRecords: entry.malformedRecords,
        });
      }
      return retainedFiles.flatMap((file) => {
        // A keyed copy outside the window still claims its key, so a later copy is not counted.
        const records = file.records.filter(
          (record) => record.dedupeKey !== null || inWindow(record.timestampMs),
        );
        const malformedRecords = file.malformedRecords.filter(inWindow);
        return records.length === 0 && malformedRecords.length === 0
          ? []
          : [{ ...file, records, malformedRecords }];
      });
    });
    const modelAliases = resolveModelAliases(settings.usageModelAliases);
    const priceOverrides = createOverrideRateTable(settings.usagePriceOverrides);
    let scanRates = window.rates;
    let scanPricing = window.pricing;
    if (flight !== undefined && !fromMemory) {
      const rateModels = new Set<string>();
      for (const files of filesByDir) {
        for (const { records } of files) {
          for (const record of records) {
            const alias = modelAliases.get(record.model);
            if (!priceOverrides.has((alias ?? record.model).trim())) {
              rateModels.add(alias ?? record.rateModel ?? record.model);
            }
          }
        }
      }
      yield* refreshForUnlistedModels(rateModels);
      scanRates = rates;
      scanPricing = pricing();
    }
    const finish = Effect.fn("UsageService.finishSummary")(function* () {
      const aggregator = new UsageAggregator({
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        resolution: input.resolution ?? "day",
        ...hourlyWindow,
        rates: scanRates,
        priceOverrides,
        modelAliases,
        rateModel: (provider, model) => providerRateModels.get(provider)?.(model),
        ...(input.modelFilter === undefined ? {} : { modelFilter: input.modelFilter }),
      });

      const crossFileSessions = sharedSessions(filesByDir.flat());
      const counts = filesByDir.map(() => ({
        scannedFiles: 0,
        skippedFiles: 0,
        malformedRecords: 0,
        sessionIds: new Set<string>(),
        counted: false,
      }));
      // The earliest first record wins duplicate credit, with byte-ordered paths breaking ties.
      const orderedFiles = filesByDir
        .flatMap((files, source) =>
          files.map((file) => ({
            file,
            source,
            first: file.records[0]?.timestampMs ?? Infinity,
            pathBytes: Buffer.from(file.path),
          })),
        )
        .sort(
          (left, right) =>
            left.first - right.first || Buffer.compare(left.pathBytes, right.pathBytes),
        );
      for (const { file, source } of orderedFiles) {
        const count = counts[source]!;
        const { dir } = scannedDirs[source]!;
        count.malformedRecords += file.malformedRecords.length;
        if (file.records.length === 0) {
          count.skippedFiles++;
          continue;
        }
        count.scannedFiles++;
        const eventOccurrences = new Map<string, number>();
        for (const rawRecord of file.records) {
          const record = correctedRecord(rawRecord);
          let usageRecord = record;
          if (
            sharedSessionProviders.has(record.provider) &&
            crossFileSessions.has(record.sessionId)
          ) {
            // Preserve repeated equal events within a file, including second-precision timestamps.
            const key = encodeUsageRecordKey([
              record.provider,
              record.sessionId,
              record.timestampMs,
              record.model,
              record.totals,
            ]);
            const occurrence = (eventOccurrences.get(key) ?? 0) + 1;
            eventOccurrences.set(key, occurrence);
            usageRecord = { ...record, dedupeKey: key + ":" + occurrence };
          }
          if (aggregator.add(usageRecord, dir)) {
            count.counted = true;
            if (record.sessionId.length > 0) count.sessionIds.add(record.sessionId);
          }
        }
      }

      const sources: UsageSource[] = [];
      const savedUsageMessage = savedUsageGapMessage();
      for (const [
        index,
        {
          provider,
          dir,
          volumeId,
          physicalSourceId,
          files,
          status,
          message,
          refreshing,
          hostId: sourceHostId,
        },
      ] of scannedDirs.entries()) {
        const { scannedFiles, skippedFiles, malformedRecords, sessionIds, counted } =
          counts[index]!;
        const savedUsageGap = savedUsageMessage !== undefined && transcriptFormats.has(provider);
        const sourceMessage = savedUsageGap
          ? [message, savedUsageMessage].filter(Boolean).join(" ")
          : (message ?? (files === null ? "No transcript directory on this environment." : null));
        sources.push({
          fingerprint: {
            hostId: sourceHostId ?? hostId,
            provider,
            resolvedHomePath: dir,
            volumeId,
            ...(physicalSourceId === undefined ? {} : { physicalSourceId }),
          },
          status:
            savedUsageGap && (status === undefined || status === "ok" || status === "missing")
              ? "partial"
              : files === null && scannedFiles === 0
                ? "missing"
                : malformedRecords > 0
                  ? status === undefined || status === "ok"
                    ? "partial"
                    : status
                  : (status ?? "ok"),
          scannedFiles,
          skippedFiles,
          malformedRecords,
          distinctSessions: sessionIds.size,
          message:
            malformedRecords > 0
              ? [sourceMessage, formatMalformedUsageWarning(malformedRecords)]
                  .filter(Boolean)
                  .join(" ")
              : sourceMessage,
          ...(refreshing || (fromMemory && counted && transcriptFormats.has(provider))
            ? { refreshing: true }
            : {}),
        });
      }

      const aggregated = aggregator.finish();
      const readAt = yield* DateTime.now;
      const finishedAtMs = yield* Clock.currentTimeMillis;

      return {
        contractVersion: USAGE_CONTRACT_VERSION,
        readAt: DateTime.formatIso(readAt),
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        buckets: aggregated.buckets,
        sources,
        pricing: scanPricing,
        scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
        ...(input.modelFilter === undefined ? {} : { modelFilter: input.modelFilter }),
      } satisfies UsageSummary;
    });

    if (flight === undefined) return yield* finish();

    const windowEndMs =
      hourlyWindow?.untilTimeMs ??
      Date.parse(`${input.untilDay}T00:00:00Z`) + 86400000 + MTIME_SLACK_MS;
    let resolvedAny = false;
    for (const { reader } of transcriptReaders) {
      if (reader.resolveServiceTiers === undefined || fromMemory) continue;
      const pending = new Set<UsageRecord>();
      for (const [index, files] of filesByDir.entries()) {
        if (scannedDirs[index]?.provider !== reader.provider) continue;
        for (const file of files) {
          for (const raw of file.records) {
            const record = correctedRecord(raw);
            if (
              record.provider === reader.provider &&
              record.unresolvedServiceTierTurnId !== undefined &&
              record.timestampMs >= windowStartMs &&
              record.timestampMs < windowEndMs
            ) {
              pending.add(record);
            }
          }
        }
      }
      if (pending.size === 0) continue;
      flight.snapshot ??= yield* finish();
      const resolved = yield* reader
        .resolveServiceTiers([...pending])
        .pipe(Effect.provideContext(readerContext));
      for (const [record, speed] of resolved) {
        const { unresolvedServiceTierTurnId: _turnId, ...rest } = record;
        resolvedRecords.set(record, { ...rest, speed });
        resolvedAny = true;
      }
    }
    if (resolvedAny) {
      // A resolved tier derives from the same read, so the row keeps its read time and a
      // peer's later read of the file still wins the merge.
      for (const [filePath, entry] of fileCache) {
        const records = correctedBatch(entry.records);
        const tailRecords = correctedBatch(entry.tailRecords);
        if (records === entry.records && tailRecords === entry.tailRecords) continue;
        fileCache.set(filePath, { ...entry, records, tailRecords });
        generation += 1;
      }
    }
    yield* dropExpired();

    return yield* finish();
  });

  const flights = new Map<string, ScanFlight>();
  const completed = new Map<
    string,
    { readonly summary: UsageSummary; readonly followUpUntil: number }
  >();
  let draining = false;

  const deadlineAnswer = (flight: ScanFlight) => {
    const snapshot = flight.snapshot ?? completed.get(flight.key)?.summary;
    if (snapshot === undefined) {
      return Effect.fail(
        new UsageReadError({
          reason: "scanPending",
          detail: "The usage scan has no figures yet.",
        }),
      );
    }
    const detail = "The usage scan timed out. Some usage may still be refreshing.";
    return Effect.succeed({
      ...snapshot,
      partialReason: "scanTimedOut",
      sources: snapshot.sources.map(({ refreshing, ...source }): UsageSource =>
        source.status === "ok" || refreshing
          ? { ...source, status: "partial", message: detail }
          : source,
      ),
    } satisfies UsageSummary);
  };

  const runFlight = Effect.fn("UsageService.runFlight")(function* (flight: ScanFlight) {
    const clock = yield* Clock.Clock;
    const now = () => Number(clock.monotonicTimeNanosUnsafe() / 1_000_000n);
    let lastProgress = now();
    const stalled = Effect.gen(function* () {
      let remaining = SCAN_STALL_MS;
      while (remaining > 0) {
        yield* Effect.sleep(remaining);
        remaining = SCAN_STALL_MS - (now() - lastProgress);
      }
      return yield* deadlineAnswer(flight);
    });
    return yield* Effect.raceFirst(
      scanSummary(flight.input, flight.settings, flight, () => {
        lastProgress = now();
      }),
      stalled,
    );
  });

  const drainScans = Effect.gen(function* () {
    while (true) {
      const next = flights.values().next();
      if (next.done) {
        draining = false;
        return;
      }
      const flight = next.value;
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const result = yield* restore(runFlight(flight)).pipe(Effect.exit);
          const exit =
            Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)
              ? Exit.fail(
                  new UsageReadError({
                    reason: "scanFailed",
                    detail: "The usage scan was interrupted.",
                  }),
                )
              : result;
          yield* schedulePersist;
          if (Exit.isSuccess(exit) && exit.value.partialReason === undefined) {
            const now = yield* monotonicMillis;
            completed.delete(flight.key);
            completed.set(flight.key, {
              summary: exit.value,
              followUpUntil: flight.needsFollowUp ? now + FOLLOW_UP_TTL_MS : 0,
            });
            if (completed.size > MAX_SCAN_KEYS) {
              const oldest = completed.keys().next();
              if (!oldest.done) completed.delete(oldest.value);
            }
          }
          flights.delete(flight.key);
          yield* Deferred.done(flight.saved, exit);
          yield* Deferred.done(flight.initial, exit);
          yield* Deferred.done(flight.refreshed, exit);
        }),
      );
    }
  }).pipe(
    Effect.onError(() =>
      Effect.sync(() => {
        draining = false;
      }),
    ),
    Effect.withSpan("UsageService.drainScans"),
  );

  const readSummary = Effect.fn("UsageService.readSummary")(function* (
    requested: UsageSummaryInput,
  ) {
    const { modelFilter: requestedFilter, ...unfiltered } = requested;
    const modelFilter = canonicalModelFilter(requestedFilter);
    const input = modelFilter === undefined ? unfiltered : { ...unfiltered, modelFilter };
    const query = encodeUsageRecordKey([
      input.timeZone,
      input.sinceDay,
      input.untilDay,
      input.resolution ?? "day",
      input.sinceTime ?? null,
      input.untilTime ?? null,
      modelFilter ?? null,
    ]);
    let admitted: ScanFlight | undefined;
    return yield* Effect.gen(function* () {
      const { settings, key: settingsKey } = yield* readSettings;
      const key = encodeUsageRecordKey([query, settingsKey]);
      const now = yield* monotonicMillis;
      const cached = completed.get(key);
      if (
        input.awaitRefresh &&
        !flights.has(key) &&
        cached !== undefined &&
        cached.followUpUntil > now
      ) {
        return cached.summary;
      }
      const flight = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = flights.get(key);
          if (existing !== undefined) {
            admitted = existing;
            return existing;
          }
          if (flights.size >= MAX_SCAN_KEYS) {
            return yield* new UsageReadError({
              reason: "scanFailed",
              detail: "The usage scan queue is full.",
            });
          }
          const created: ScanFlight = {
            key,
            input,
            settings,
            saved: Deferred.makeUnsafe(),
            initial: Deferred.makeUnsafe(),
            refreshed: Deferred.makeUnsafe(),
            needsFollowUp: false,
          };
          flights.set(key, created);
          admitted = created;
          if (!draining) {
            draining = true;
            yield* drainScans.pipe(Effect.interruptible, Effect.forkIn(scope));
          }
          return created;
        }),
      );
      return yield* Deferred.await(
        input.awaitRefresh ? flight.refreshed : input.provisional ? flight.saved : flight.initial,
      );
    }).pipe(
      Effect.timeoutOrElse({
        duration: SUMMARY_DEADLINE,
        orElse: () => {
          if (admitted === undefined)
            return Effect.fail(
              new UsageReadError({
                reason: "scanFailed",
                detail: "The usage scan timed out before it could start.",
              }),
            );
          admitted.needsFollowUp = true;
          return deadlineAnswer(admitted);
        },
      }),
    );
  });

  const priceTokens: UsageService["Service"]["priceTokens"] = Effect.fn("UsageService.priceTokens")(
    function* (items) {
      const { settings } = yield* readSettings;
      yield* ensureRates(false);
      const overrides = createOverrideRateTable(settings.usagePriceOverrides);
      const aliases = resolveModelAliases(settings.usageModelAliases);
      return items.map(({ model, totals }) => {
        const priced = priceUsage(
          rates,
          { model: aliases.get(model) ?? model, totals, speed: "standard", reportedCostUsd: null },
          overrides,
        );
        return priced.costSource === "unpriced" ? null : priced.costUsd;
      });
    },
  );

  return { readSummary, refreshRates, clientSettingsKey, awaitPersisted, priceTokens } as const;
});

export const layer = Layer.effect(UsageService, make);
