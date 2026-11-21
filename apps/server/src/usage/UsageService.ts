import {
  type ProviderInstanceConfig,
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
  type ServerSettings as ServerSettingsValue,
  type UsageProviderKind,
  type UsageSource,
  type UsagePricing,
  type UsageSummary,
  type UsageSummaryInput,
  type UsageTokenTotals,
  UsageReadError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
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

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { formatMalformedUsageWarning } from "@t3tools/shared/usageFormat";
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
import { canonicalModelFilter, resolveModelAliases, UsageAggregator } from "./usageAggregation.ts";
import {
  createOverrideRateTable,
  parseRateTable,
  priceUsage,
  type RateTable,
} from "./usagePricing.ts";
import {
  listTranscriptFiles,
  readDirectoryVolumeId,
  readTranscriptRecords,
  statTranscriptFiles,
  type TranscriptFile,
} from "./usageTranscriptReader.ts";
import {
  dedupeWithinFile,
  isLaterRead,
  type CachedFile,
  type ScanCache,
} from "./usageScanCache.ts";
import * as UsageScanIndex from "./usageScanIndex.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const LITELLM_RATES_API_URL =
  "https://api.github.com/repos/BerriAI/litellm/contents/model_prices_and_context_window.json?ref=main";

const RATES_TTL_MS = 24 * 60 * 60 * 1000;

const RATES_REFRESH_FLOOR_MS = 60 * 1000;

// mtime slack includes writes just before local midnight on the window's first day.
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const CACHE_RETENTION_DAYS = 92;

const TRANSCRIPT_READ_CONCURRENCY = 4;
const LISTING_TTL_MS = 5_000;
const HOT_TRANSCRIPT_AGE_MS = 24 * 60 * 60 * 1000;
const SCAN_WAIT_TIMEOUT_MS = 30_000;
const SOURCE_REFRESH_TIMEOUT_MS = 25_000;
const SCAN_HARD_TIMEOUT = "5 minutes";
const FOLLOWUP_TTL_MS = 10_000;
const monotonicMillis = Clock.monotonicTimeNanos.pipe(
  Effect.map((nanos) => Number(nanos / 1_000_000n)),
);

const transcriptReaders = BUILT_IN_USAGE_DRIVERS.flatMap((driver) =>
  driver.usage?.kind === "transcripts" ? [{ driver, reader: driver.usage }] : [],
);

const scanReaders = BUILT_IN_USAGE_DRIVERS.flatMap((driver) =>
  driver.usage?.kind === "scan" ? [{ driver, reader: driver.usage }] : [],
);

const transcriptFormats = new Map(
  transcriptReaders.map(({ reader }) => [reader.provider, reader.format] as const),
);

interface TranscriptSource {
  readonly provider: UsageProviderKind;
  readonly format: TranscriptUsageFormat<unknown>;
  readonly dir: string;
  readonly volumeId: string;
  readonly fileName?: string;
}

const RatesCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  document: Schema.Unknown,
});
const decodeRatesCache = Schema.decodeUnknownEffect(Schema.fromJsonString(RatesCacheFile));
const encodeRatesCache = Schema.encodeEffect(Schema.fromJsonString(RatesCacheFile));

const ScanCacheJson = Schema.fromJsonString(Schema.Unknown);
const encodeJsonKey = Schema.encodeSync(ScanCacheJson);

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
  const hostname = yield* HostProcess.Hostname;
  const readerContext = yield* Effect.context<BuiltInUsageReadersEnv>();
  const scope = yield* Effect.scope;
  const scanIndex = yield* UsageScanIndex.make(transcriptFormats);

  const fileCache: ScanCache = new Map();
  const fileOrders = new Map<string, number>();
  let lastFileOrder = 0;
  // Reads from concurrent windows can still hold the original record after it is corrected.
  const resolvedRecords = new WeakMap<UsageRecord, UsageRecord>();
  const correctedRecord = (record: UsageRecord) => resolvedRecords.get(record) ?? record;
  const correctedBatch = (records: readonly UsageRecord[]) =>
    records.some((record) => resolvedRecords.has(record)) ? records.map(correctedRecord) : records;
  const sourceCache: UsageScanIndex.ScanSources = new Map();
  const dirtyFiles = new Map<string, UsageScanIndex.ScanIndexChange>();
  let sourcesDirty = false;
  const updateFile = (file: string, entry: CachedFile, reservedOrder?: number) => {
    const order = fileOrders.get(file) ?? reservedOrder ?? ++lastFileOrder;
    fileOrders.set(file, order);
    fileCache.set(file, entry);
    dirtyFiles.set(file, { entry, order });
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

  const loadRates = Effect.fn("UsageService.loadRates")(function* (force: boolean) {
    const now = yield* Clock.currentTimeMillis;
    const maxAgeMs = force ? RATES_REFRESH_FLOOR_MS : RATES_TTL_MS;
    if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < maxAgeMs) return;

    if (ratesFetchedAtMs === null) {
      const fromDisk = yield* fileSystem.readFileString(ratesCachePath).pipe(
        Effect.flatMap((raw) => decodeRatesCache(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (fromDisk !== null) {
        const parsed = parseRateTable(fromDisk.document);
        if (parsed.size > 0) {
          rates = parsed;
          ratesFetchedAtMs = fromDisk.fetchedAtMs;
          ratesStatus = "cached";
          if (now - fromDisk.fetchedAtMs < maxAgeMs) return;
        }
      }
    }

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

  const refreshRates = ensureRates(true).pipe(
    Effect.map(pricing),
    Effect.withSpan("UsageService.refreshRates"),
  );

  const readSettings = settingsService.getSettings.pipe(
    Effect.catchCause(
      (cause) =>
        new UsageReadError({
          reason: "scanFailed",
          detail: "Server settings could not be read.",
          cause: Cause.squash(cause),
        }),
    ),
  );

  const usageInstances = Effect.fn("UsageService.usageInstances")(function* <Config>(
    driver: ProviderDriver<Config, unknown, unknown>,
    settings: ServerSettingsValue,
  ) {
    const entries: Array<
      readonly [ProviderInstanceId, Pick<ProviderInstanceConfig, "config" | "environment">, boolean]
    > = Object.entries(settings.providerInstances)
      .filter(([, instance]) => instance.driver === driver.driverKind)
      .map(([id, instance]) => [ProviderInstanceId.make(id), instance, true] as const);
    if (!Object.hasOwn(settings.providerInstances, driver.driverKind)) {
      entries.push([ProviderInstanceId.make(driver.driverKind), {}, false]);
    }
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
    settings: ServerSettingsValue,
    retentionCutoffMs: number,
  ) {
    const dirs: Array<TranscriptSource> = [];
    const seen = new Set<string>();
    for (const { driver, reader } of transcriptReaders) {
      const { provider, format } = reader;
      const directories = yield* Effect.forEach(
        yield* usageInstances(driver, settings),
        (instance) => reader.directories(instance),
      );
      for (const { dir: directory, fileName } of directories.flat()) {
        const sourceKey = provider + "\0" + directory;
        const previous = sourceCache.get(sourceKey);
        const dir = yield* fileSystem
          .realPath(directory)
          .pipe(Effect.orElseSucceed(() => previous?.dir ?? directory));
        const currentVolumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
        const hasRetainedHistory = fileCache
          .entries()
          .some(
            ([filePath, entry]) =>
              entry.provider === provider &&
              entry.mtimeMs >= retentionCutoffMs &&
              (entry.records.length + entry.tailRecords.length > 0 || entry.malformedRecords > 0) &&
              isWithinDirectory(filePath, dir),
          );
        const volumeId =
          previous?.dir === dir && (hasRetainedHistory || !currentVolumeId)
            ? previous.volumeId || currentVolumeId
            : currentVolumeId;
        if (previous?.dir !== dir || previous.volumeId !== volumeId) {
          sourceCache.set(sourceKey, { dir, volumeId });
          sourcesDirty = true;
        }
        const key = `${provider}\0${dir}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dirs.push({
          provider,
          format,
          dir,
          volumeId,
          ...(fileName === undefined ? {} : { fileName }),
        });
      }
    }
    return dirs;
  });

  const ensureScanCacheLoaded = yield* Effect.cachedWithTTL(
    scanIndex.load().pipe(
      Effect.tap(({ files, sources, orders, lastOrder }) =>
        Effect.sync(() => {
          for (const [file, entry] of files) fileCache.set(file, entry);
          for (const [file, order] of orders) fileOrders.set(file, order);
          lastFileOrder = lastOrder;
          for (const [key, source] of sources) sourceCache.set(key, source);
        }),
      ),
      Effect.asVoid,
      Effect.mapError(
        (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            detail: "Saved transcript usage could not be loaded.",
            cause,
          }),
      ),
    ),
    (exit) => (Exit.isSuccess(exit) ? Infinity : 0),
  );

  const persistLock = yield* Semaphore.make(1);
  const persistCaches = Effect.gen(function* () {
    if (dirtyFiles.size === 0 && !sourcesDirty) return;
    const changes = new Map(dirtyFiles);
    const sources = sourcesDirty ? new Map(sourceCache) : undefined;
    sourcesDirty = false;
    yield* scanIndex.write(changes, sources).pipe(
      Effect.matchEffect({
        onFailure: (error) => {
          sourcesDirty ||= sources !== undefined;
          return Effect.logWarning("Could not persist transcript usage", error);
        },
        onSuccess: () =>
          Effect.sync(() => {
            for (const [file, entry] of changes) {
              if (dirtyFiles.get(file) === entry) dirtyFiles.delete(file);
            }
          }),
      }),
    );
  }).pipe(persistLock.withPermit, Effect.withSpan("UsageService.persistCaches"));

  const pendingPersists = new Set<Fiber.Fiber<void>>();
  const schedulePersist = Effect.suspend(() =>
    dirtyFiles.size === 0 && !sourcesDirty
      ? Effect.void
      : Effect.forkDetach(persistCaches).pipe(
          Effect.map((fiber) => {
            pendingPersists.add(fiber);
            fiber.addObserver(() => pendingPersists.delete(fiber));
          }),
        ),
  );
  const awaitPersisted = Effect.suspend(() => Fiber.awaitAll([...pendingPersists])).pipe(
    Effect.asVoid,
  );
  yield* Effect.addFinalizer(() => awaitPersisted);

  const readFileRecords = Effect.fn("UsageService.readFileRecords")(function* (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
    format: TranscriptUsageFormat<unknown>,
  ): Effect.fn.Return<{
    readonly records: readonly UsageRecord[];
    readonly malformedRecords: number;
    readonly failed?: true;
    readonly update?: { readonly entry: CachedFile; readonly replaces: CachedFile | undefined };
  }> {
    const cached = fileCache.get(filePath);
    // Provider is part of the identity: if both providers were ever pointed
    // at one directory, a hit parsed by the other parser must not be reused.
    if (
      cached &&
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
      cached !== undefined && cached.provider === provider && size > cached.size
        ? cached.position
        : undefined;

    const parsed = yield* Effect.promise((signal) =>
      readTranscriptRecords(filePath, format, resumeFrom, { signal }),
    );
    // A read failure is not an empty transcript: caching it under this
    // (size, mtime) would silently drop the file's usage until it changes.
    if (parsed === null)
      return {
        records: cached?.provider === provider ? [...cached.records, ...cached.tailRecords] : [],
        malformedRecords: cached?.provider === provider ? cached.malformedRecords : 0,
        failed: true,
      };

    if (parsed.resumed && cached !== undefined && cached.tailRecords.length > 0) {
      // Completing a tentative line reparses it. Reuse its saved correction only when the
      // same usage is emitted again, without putting inferred tiers in the parser state.
      const reparsed = [...parsed.records, ...parsed.tailRecords];
      const identity = (record: UsageRecord) =>
        encodeJsonKey([
          record.provider,
          record.sessionId,
          record.timestampMs,
          record.model,
          record.rateModel,
          record.totals,
          record.reportedCostUsd,
          record.dedupeKey,
        ]);
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
    const seen = new Set<string>();
    const records = dedupeWithinFile([...base, ...parsed.records], seen);
    const tailRecords = dedupeWithinFile(parsed.tailRecords, seen);

    return {
      records: tailRecords.length === 0 ? records : [...records, ...tailRecords],
      malformedRecords: parsed.malformedRecords,
      update: {
        entry: {
          size,
          mtimeMs,
          provider,
          records,
          tailRecords,
          malformedRecords: parsed.malformedRecords,
          position: parsed.position,
        },
        replaces: cached,
      },
    };
  });

  interface ScannedDir {
    readonly provider: UsageProviderKind;
    readonly dir: string;
    readonly volumeId: string;
    readonly hostId?: string;
    readonly status?: UsageSource["status"];
    readonly message?: string;
    readonly action?: UsageSource["action"];
    readonly files:
      | readonly {
          readonly path: string;
          readonly records: readonly UsageRecord[];
          readonly malformedRecords: number;
        }[]
      | null;
    readonly refreshing?: true;
  }

  const listings = new Map<
    string,
    { readonly expiresAt: number; readonly files: readonly TranscriptFile[] }
  >();

  type Listing = Awaited<ReturnType<typeof listTranscriptFiles>>;
  const listingLoads = new Map<string, Effect.Effect<Listing>>();

  const loadListing = Effect.fn("UsageService.loadListing")(function* (
    key: string,
    dir: string,
    fileName: string | undefined,
  ) {
    const effect = yield* Effect.cached(
      Effect.gen(function* () {
        const result = yield* Effect.promise((signal) =>
          listTranscriptFiles(dir, -Infinity, {
            ...(fileName === undefined ? {} : { fileName }),
            signal,
          }),
        );
        if (result.failedPaths === 0) {
          const completedAt = yield* monotonicMillis;
          for (const [key, cached] of listings) {
            if (cached.expiresAt <= completedAt) listings.delete(key);
          }
          listings.set(key, { expiresAt: completedAt + LISTING_TTL_MS, files: result.files });
        }
        return result;
      }).pipe(Effect.ensuring(Effect.sync(() => listingLoads.delete(key)))),
    );
    const existing = listingLoads.get(key);
    if (existing !== undefined) return yield* existing;
    listingLoads.set(key, effect);
    return yield* effect;
  });

  const transcriptListing = Effect.fn("UsageService.transcriptListing")(function* (
    dir: string,
    fileName: string | undefined,
    sinceMs: number,
  ) {
    const key = encodeJsonKey([dir, fileName ?? null]);
    const now = yield* monotonicMillis;
    const listing = listings.get(key);
    if (listing === undefined || listing.expiresAt <= now) {
      const result = yield* loadListing(key, dir, fileName);
      return { ...result, files: result.files.filter((file) => file.mtimeMs >= sinceMs) };
    }

    // Active transcripts can grow without changing directory mtimes.
    const wallTime = yield* Clock.currentTimeMillis;
    const hotSince = Math.max(sinceMs, wallTime - HOT_TRANSCRIPT_AGE_MS);
    const hotPaths = listing.files
      .filter((file) => file.mtimeMs >= hotSince)
      .map((file) => file.path);
    const updated = yield* Effect.promise((signal) =>
      statTranscriptFiles(hotPaths, sinceMs, signal),
    );
    const byPath = new Map(updated.files.map((file) => [file.path, file]));
    return {
      failedPaths: updated.failedPaths,
      files: listing.files.flatMap((file) => {
        if (file.mtimeMs < sinceMs) return [];
        if (file.mtimeMs < hotSince) return [file];
        const current = byPath.get(file.path);
        return current === undefined ? [] : [current];
      }),
    };
  });

  const scanTranscriptDir = Effect.fn("UsageService.scanTranscriptDir")(function* (
    source: TranscriptSource,
    windowStartMs: number,
  ) {
    const { provider, format, dir, volumeId, fileName } = source;
    const exists = yield* fileSystem
      .exists(dir)
      .pipe(Effect.catchCause(() => Effect.succeed(false)));
    if (!exists) {
      listings.delete(encodeJsonKey([dir, fileName ?? null]));
      return { provider, dir, volumeId, files: null } satisfies ScannedDir;
    }
    const { files, failedPaths } = yield* transcriptListing(dir, fileName, windowStartMs);
    // Reserve walk order before concurrent reads, including files saved before a scan is interrupted.
    const ordered = files.map((file) => ({
      file,
      order: fileOrders.get(file.path) ?? ++lastFileOrder,
    }));
    const read = yield* Effect.forEach(
      ordered,
      ({ file, order }) =>
        readFileRecords(file.path, file.size, file.mtimeMs, provider, format).pipe(
          Effect.map(({ records, malformedRecords, failed, update }) => {
            if (update !== undefined) {
              const current = fileCache.get(file.path);
              if (
                current === update.replaces ||
                current === undefined ||
                isLaterRead(update.entry, current)
              ) {
                updateFile(
                  file.path,
                  {
                    ...update.entry,
                    records: correctedBatch(update.entry.records),
                    tailRecords: correctedBatch(update.entry.tailRecords),
                  },
                  order,
                );
              }
            }
            return { path: file.path, records, malformedRecords, failed };
          }),
        ),
      { concurrency: TRANSCRIPT_READ_CONCURRENCY },
    );
    const unread = failedPaths + read.filter((file) => file.failed).length;
    return {
      provider,
      dir,
      volumeId,
      files: read,
      ...(unread > 0
        ? {
            status: "partial",
            message: `${unread} transcript path(s) could not be read; usage may be incomplete.`,
          }
        : {}),
    } satisfies ScannedDir;
  });

  const collectTranscriptDirs = Effect.fn("UsageService.collectTranscriptDirs")(function* (
    windowStartMs: number,
    settings: ServerSettingsValue,
    retentionCutoffMs: number,
  ) {
    const dirs = yield* resolveTranscriptDirs(settings, retentionCutoffMs).pipe(
      Effect.provideContext(readerContext),
    );
    return yield* Effect.forEach(dirs, (dir) => scanTranscriptDir(dir, windowStartMs));
  });

  const markRefreshFailed = <Source extends { readonly refreshing?: true }>(
    source: Source,
    message: string,
  ) => {
    if (!source.refreshing) return source;
    const { refreshing: _refreshing, ...previous } = source;
    return { ...previous, status: "failed" as const, message };
  };

  const collectScanDirs = Effect.fn("UsageService.collectScanDirs")(function* (
    windowStartMs: number,
    settings: ServerSettingsValue,
    retentionCutoffMs: number,
    previous?: readonly (readonly ScannedDir[])[],
  ) {
    return yield* Effect.forEach(
      scanReaders,
      ({ driver, reader }, index) => {
        const prior = previous?.[index];
        if (prior !== undefined && !prior.some((source) => source.refreshing)) {
          return Effect.succeed(prior);
        }
        const scan = usageInstances(driver, settings).pipe(
          Effect.flatMap((instances) =>
            reader.scan({
              instances,
              settings,
              windowStartMs,
              retentionCutoffMs,
              awaitRefresh: previous !== undefined,
            }),
          ),
          Effect.flatMap((sources) =>
            Effect.forEach(sources, ({ volumeId, ...source }) =>
              Effect.map(
                volumeId === undefined
                  ? Effect.promise(() => readDirectoryVolumeId(source.dir))
                  : Effect.succeed(volumeId),
                (resolved): ScannedDir => ({
                  ...source,
                  files: source.files?.map((file) => ({ ...file, malformedRecords: 0 })) ?? null,
                  provider: reader.provider,
                  volumeId: resolved,
                }),
              ),
            ),
          ),
          Effect.provideContext(readerContext),
        );
        if (prior === undefined) return scan;
        const failed = (message: string) =>
          prior.map((source) => markRefreshFailed(source, message));
        return scan.pipe(
          Effect.timeoutOrElse({
            duration: SOURCE_REFRESH_TIMEOUT_MS,
            orElse: () => Effect.succeed(failed("Usage source refresh timed out.")),
          }),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            () =>
              Effect.logWarning("Usage source refresh failed", { provider: reader.provider }).pipe(
                Effect.as(failed("Usage source could not be refreshed.")),
              ),
          ),
        );
      },
      { concurrency: "unbounded" },
    );
  });

  const scanSummary = Effect.fn("UsageService.scanSummary")(function* (
    input: UsageSummaryInput,
    settings: ServerSettingsValue,
    flight: SummaryFlight,
  ) {
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

    const startedAtMs = yield* monotonicMillis;
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

    const retentionCutoffMs =
      (yield* Clock.currentTimeMillis) - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const [, transcripts, scans] = yield* Effect.all(
      [
        ensureRates(false),
        collectTranscriptDirs(windowStartMs, settings, retentionCutoffMs),
        collectScanDirs(windowStartMs, settings, retentionCutoffMs),
      ],
      { concurrency: "unbounded" },
    );
    const window = { hourlyWindow, windowStartMs, startedAtMs, retentionCutoffMs };
    const initial = yield* aggregateSummary(
      input,
      settings,
      [...transcripts, ...scans.flat()],
      window,
    );
    if (!scans.some((dirs) => dirs.some((source) => source.refreshing))) return initial;

    yield* schedulePersist;
    yield* Deferred.succeed(flight.initial, initial);
    flight.refreshing = true;
    const refreshed = yield* collectScanDirs(windowStartMs, settings, retentionCutoffMs, scans);
    return yield* aggregateSummary(input, settings, [...transcripts, ...refreshed.flat()], window);
  });

  const aggregateSummary = Effect.fn("UsageService.aggregateSummary")(function* (
    input: UsageSummaryInput,
    settings: ServerSettingsValue,
    scannedDirs: readonly ScannedDir[],
    {
      hourlyWindow,
      windowStartMs,
      startedAtMs,
      retentionCutoffMs,
    }: {
      readonly hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null;
      readonly windowStartMs: number;
      readonly startedAtMs: number;
      readonly retentionCutoffMs: number;
    },
  ) {
    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
      priceOverrides: createOverrideRateTable(settings.usagePriceOverrides),
      modelAliases: resolveModelAliases(settings.usageModelAliases),
      ...(input.modelFilter === undefined ? {} : { modelFilter: input.modelFilter }),
    });

    const sources: UsageSource[] = [];

    // Deleted transcripts' saved usage still aggregates and deduplicates normally.
    const retainedSinceMs = Math.max(windowStartMs, retentionCutoffMs);
    const retainedInOrder = [...fileCache].sort(
      ([left], [right]) => fileOrders.get(left)! - fileOrders.get(right)!,
    );
    const filesByDir = scannedDirs.map(({ provider, dir, files }) => {
      const retainedFiles = [...(files ?? [])];
      const livePaths = new Set(retainedFiles.map((file) => file.path));
      for (const [filePath, entry] of retainedInOrder) {
        if (
          entry.provider !== provider ||
          entry.mtimeMs < retainedSinceMs ||
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
      return retainedFiles;
    });
    const windowEndMs =
      hourlyWindow?.untilTimeMs ??
      Date.parse(`${input.untilDay}T00:00:00Z`) + 86400000 + MTIME_SLACK_MS;
    let resolvedAny = false;
    for (const { reader } of transcriptReaders) {
      if (reader.resolveServiceTiers === undefined) continue;
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
      for (const [filePath, entry] of fileCache) {
        const records = correctedBatch(entry.records);
        const tailRecords = correctedBatch(entry.tailRecords);
        if (records === entry.records && tailRecords === entry.tailRecords) continue;
        // Update the current entry by identity; a slow resolver cannot restore an older file.
        updateFile(filePath, { ...entry, records, tailRecords });
      }
    }
    const crossFileSessions = sharedSessions(filesByDir.flat());

    for (const [
      index,
      { provider, dir, volumeId, files, status, message, action, refreshing, hostId: sourceHostId },
    ] of scannedDirs.entries()) {
      let scannedFiles = 0;
      let skippedFiles = 0;
      let malformedRecords = 0;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();

      for (const file of filesByDir[index] ?? []) {
        malformedRecords += file.malformedRecords;
        if (file.records.length === 0) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        const eventOccurrences = new Map<string, number>();
        for (const rawRecord of file.records) {
          const record = correctedRecord(rawRecord);
          let usageRecord = record;
          if (
            sharedSessionProviders.has(record.provider) &&
            crossFileSessions.has(record.sessionId)
          ) {
            // Dedupe moved copies but retain repeated equal events within a file, including second-precision timestamps.
            const key = encodeJsonKey([
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
          if (aggregator.add(usageRecord, dir) && record.sessionId.length > 0) {
            sessionIds.add(record.sessionId);
          }
        }
      }

      const sourceMessage =
        message ?? (files === null ? "No transcript directory on this environment." : null);
      sources.push({
        fingerprint: { hostId: sourceHostId ?? hostId, provider, resolvedHomePath: dir, volumeId },
        status:
          files === null && scannedFiles === 0 && status !== "failed"
            ? "missing"
            : malformedRecords > 0 && (status === undefined || status === "ok")
              ? "partial"
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
        ...(action ? { action } : {}),
        ...(refreshing ? { refreshing } : {}),
      });
    }

    for (const [file, entry] of fileCache) {
      if (entry.mtimeMs >= retentionCutoffMs) continue;
      fileCache.delete(file);
      fileOrders.delete(file);
      dirtyFiles.set(file, { entry: null, order: 0 });
    }

    const aggregated = aggregator.finish();
    const readAt = yield* DateTime.now;
    const finishedAtMs = yield* monotonicMillis;

    return {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets,
      sources,
      pricing: pricing(),
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
      ...(input.modelFilter === undefined ? {} : { modelFilter: input.modelFilter }),
    } satisfies UsageSummary;
  });

  interface SummaryFlight {
    readonly initial: Deferred.Deferred<UsageSummary, UsageReadError>;
    readonly refreshed: Deferred.Deferred<UsageSummary, UsageReadError>;
    refreshing: boolean;
    expiresAt: number | undefined;
  }

  const timedOut = Effect.fn("UsageService.timedOut")(function* (
    flight: SummaryFlight,
    allowPartial: boolean,
  ) {
    yield* schedulePersist;
    if (allowPartial && flight.refreshing) {
      const initial = yield* Deferred.await(flight.initial);
      return {
        ...initial,
        sources: initial.sources.map((source) =>
          markRefreshFailed(source, "Usage source refresh timed out."),
        ),
      };
    }
    return yield* new UsageReadError({ reason: "scanFailed", detail: "The usage scan timed out." });
  });

  const inflightScans = new Map<string, SummaryFlight>();

  const scanKey = (input: UsageSummaryInput, settings: ServerSettingsValue): string =>
    JSON.stringify([
      input.timeZone,
      input.sinceDay,
      input.untilDay,
      input.resolution ?? "day",
      input.sinceTime ?? null,
      input.untilTime ?? null,
      settings,
      input.modelFilter ?? null,
    ]);

  const readSummary = Effect.fn("UsageService.readSummary")(function* (
    requested: UsageSummaryInput,
  ) {
    const { modelFilter: requestedFilter, ...unfiltered } = requested;
    const modelFilter = canonicalModelFilter(requestedFilter);
    const input = modelFilter === undefined ? unfiltered : { ...unfiltered, modelFilter };
    const settings = yield* readSettings;
    const key = scanKey(input, settings);
    const flight = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const now = yield* monotonicMillis;
        for (const [key, flight] of inflightScans) {
          if (flight.expiresAt !== undefined && flight.expiresAt <= now) inflightScans.delete(key);
        }
        const existing = inflightScans.get(key);
        if (existing !== undefined && (existing.expiresAt === undefined || input.awaitRefresh)) {
          return existing;
        }

        // Register and fork atomically so cancellation cannot orphan the shared result.
        const created: SummaryFlight = {
          initial: Deferred.makeUnsafe(),
          refreshed: Deferred.makeUnsafe(),
          refreshing: false,
          expiresAt: undefined,
        };
        inflightScans.set(key, created);
        yield* scanSummary(input, settings, created).pipe(
          Effect.timeoutOrElse({
            duration: SCAN_HARD_TIMEOUT,
            orElse: () => timedOut(created, true),
          }),
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              if (!Exit.isFailure(exit) || !Cause.hasInterruptsOnly(exit.cause))
                yield* schedulePersist;
              if (created.refreshing && Exit.isSuccess(exit)) {
                created.expiresAt = (yield* monotonicMillis) + FOLLOWUP_TTL_MS;
              } else {
                inflightScans.delete(key);
              }
              yield* Deferred.done(created.initial, exit);
              yield* Deferred.done(created.refreshed, exit);
            }),
          ),
          Effect.interruptible,
          Effect.forkIn(scope),
        );
        return created;
      }),
    );
    return yield* Deferred.await(input.awaitRefresh ? flight.refreshed : flight.initial).pipe(
      Effect.timeoutOrElse({
        duration: SCAN_WAIT_TIMEOUT_MS,
        orElse: () => timedOut(flight, input.awaitRefresh === true),
      }),
    );
  });

  const priceTokens: UsageService["Service"]["priceTokens"] = Effect.fn("UsageService.priceTokens")(
    function* (items) {
      const settings = yield* readSettings;
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

  return { readSummary, refreshRates, awaitPersisted, priceTokens, ensureScanCacheLoaded } as const;
});

export const layer = Layer.effect(
  UsageService,
  make.pipe(
    Effect.tap((service) =>
      service.ensureScanCacheLoaded.pipe(
        Effect.timeout(SCAN_HARD_TIMEOUT),
        Effect.ignore({ log: true }),
        Effect.forkScoped,
      ),
    ),
  ),
);
