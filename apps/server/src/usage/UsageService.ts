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
import * as Crypto from "effect/Crypto";
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
import { acquireFileLock } from "../provider/FileLock.ts";
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
} from "./usageTranscriptReader.ts";
import {
  decodeScanCache,
  dedupeWithinFile,
  LEGACY_SCAN_CACHE_FILE_NAMES,
  makeScanCacheWriter,
  pruneScanCache,
  SCAN_CACHE_FILE_NAME,
  USAGE_SCAN_CACHE_VERSION,
  type CachedFile,
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

const CACHE_RETENTION_DAYS = 92;

const TRANSCRIPT_READ_CONCURRENCY = 4;
const LISTING_TTL_MS = 5_000;
const ACTIVE_TRANSCRIPT_AGE_MS = 24 * 60 * 60 * 1000;
const SUMMARY_DEADLINE = "30 seconds";
const SCAN_STALL_MS = 5 * 60 * 1000;
const FOLLOW_UP_TTL_MS = 10_000;
const MAX_SCAN_KEYS = 16;
const monotonicMillis = Clock.currentTimeNanos.pipe(Effect.map((ns) => Number(ns / 1_000_000n)));

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
const decodeScanCacheFile = Schema.decodeUnknownEffect(ScanCacheJson);
const encodeUsageRecordKey = Schema.encodeSync(ScanCacheJson);
const CachedSource = Schema.Struct({ dir: Schema.String, volumeId: Schema.String });
const decodeCachedSource = Schema.decodeUnknownOption(CachedSource);
const decodeCacheVersion = Schema.decodeUnknownOption(Schema.Struct({ version: Schema.Number }));
const decodeSourceRows = Schema.decodeUnknownOption(
  Schema.Struct({ sources: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) }),
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
const LEGACY_CLAIM_PREFIX = ".usage-cache-retiring-";

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
  const crypto = yield* Crypto.Crypto;

  const fileCache: ScanCache = new Map();
  const resolvedRecords = new WeakMap<UsageRecord, UsageRecord>();
  const correctedRecord = (record: UsageRecord) => resolvedRecords.get(record) ?? record;
  const correctedBatch = (records: readonly UsageRecord[]) =>
    records.some((record) => resolvedRecords.has(record)) ? records.map(correctedRecord) : records;
  const sourceCache = new Map<string, typeof CachedSource.Type>();
  let cacheDirty = false;
  let cacheWritable = true;
  let cacheReadIncomplete = false;
  const updatedFiles = new Set<string>();
  const updatedSources = new Set<string>();
  const isWithinDirectory = (filePath: string, dir: string) => {
    const relative = path.relative(dir, filePath);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(config.stateDir, SCAN_CACHE_FILE_NAME);
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
          updatedSources.add(sourceKey);
          cacheDirty = true;
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

  const writeScanCache = makeScanCacheWriter();
  const listLegacyCaches = fileSystem.readDirectory(config.stateDir).pipe(
    Effect.map((names) =>
      names.filter((name) =>
        LEGACY_SCAN_CACHE_FILE_NAMES.some(
          (legacy) =>
            name === legacy || (name.startsWith(LEGACY_CLAIM_PREFIX) && name.endsWith(legacy)),
        ),
      ),
    ),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed([]),
    ),
  );
  const reportSavedUsageGap = Effect.fn("UsageService.reportSavedUsageGap")(function* (
    file: string,
    cause: unknown,
  ) {
    cacheReadIncomplete = true;
    yield* Effect.logError("Could not read some saved transcript usage", { path: file, cause });
  });
  const lockFailure = (cause: unknown) =>
    new UsageReadError({
      reason: "scanFailed",
      detail: "Saved transcript usage could not be locked.",
      cause,
    });
  const withCacheLock = <A, E, R>(task: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* fileSystem
          .makeDirectory(config.stateDir, { recursive: true })
          .pipe(Effect.mapError(lockFailure));
        const compromised = yield* Deferred.make<never, UsageReadError>();
        yield* acquireFileLock(scanCachePath, {
          realpath: false,
          stale: 120_000,
          update: 10_000,
          retries: { retries: 80, factor: 1, minTimeout: 500, maxTimeout: 500 },
          onCompromised: (cause) => Deferred.fail(compromised, lockFailure(cause)),
        }).pipe(Effect.mapError(lockFailure));
        return yield* Effect.raceFirst(task, Deferred.await(compromised));
      }),
    );

  const readDocument = (filePath: string) =>
    fileSystem
      .stat(filePath)
      .pipe(
        Effect.flatMap((info) =>
          info.type === "File" ? fileSystem.readFileString(filePath) : Effect.succeed(null),
        ),
      );
  const decodeDocument = Effect.fn("UsageService.decodeScanCache")(function* (raw: string | null) {
    const document =
      raw === null ? null : yield* decodeScanCacheFile(raw).pipe(Effect.orElseSucceed(() => null));
    const version = Option.getOrUndefined(decodeCacheVersion(document))?.version;
    const shape = decodeCacheShape(document);
    const entries = decodeScanCache(document, transcriptFormats);
    const rows = decodeSourceRows(document);
    const sources = new Map<string, typeof CachedSource.Type>();
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
    return { version, entries, sources, complete, entriesDropped, sourcesDropped };
  });
  const mergeSources = (sources: ReadonlyMap<string, typeof CachedSource.Type>) => {
    let changed = false;
    for (const [key, source] of sources) {
      if (!sourceCache.has(key)) {
        sourceCache.set(key, source);
        changed = true;
      }
    }
    return changed;
  };
  const unreadableName = Effect.fn("UsageService.unreadableCachePath")(function* (file: string) {
    const id = yield* crypto.randomUUIDv4();
    return path.join(config.stateDir, `.usage-cache-unreadable-${id}-${path.basename(file)}`);
  });
  const syncCacheFile = (file: string) =>
    Effect.scoped(Effect.flatMap(fileSystem.open(file, { flag: "r+" }), (handle) => handle.sync));
  const syncCacheDirectory =
    HostProcess.Platform.defaultValue() === "win32"
      ? Effect.void
      : Effect.scoped(Effect.flatMap(fileSystem.open(config.stateDir), (handle) => handle.sync));
  const logCacheError = (
    file: string,
    version: number | undefined,
    entriesDropped: number | null,
    sourcesDropped: number | null,
    cause?: unknown,
  ) =>
    Effect.logError("Keeping an incomplete Usage cache", {
      path: file,
      version: version ?? null,
      entriesDropped,
      sourcesDropped,
      cause,
    });

  const readCurrent = readDocument(scanCachePath).pipe(
    Effect.asSome,
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeedNone,
    ),
  );
  const sameFileState = (a: CachedFile, b: CachedFile) =>
    a.mtimeMs === b.mtimeMs && a.size === b.size;
  const isLaterFileState = (a: CachedFile, b: CachedFile) =>
    a.mtimeMs > b.mtimeMs || (a.mtimeMs === b.mtimeMs && a.size > b.size);

  const ensureScanCacheLoaded = yield* Effect.cached(
    withCacheLock(
      Effect.gen(function* () {
        const current = yield* readCurrent.pipe(Effect.result);
        let rewriteCurrent = false;
        if (current._tag === "Failure") {
          cacheWritable = false;
          yield* logCacheError(scanCachePath, undefined, null, null, current.failure);
          return;
        }
        if (Option.isSome(current.success)) {
          const raw = current.success.value;
          const decoded = yield* decodeDocument(raw);
          if (raw === null || (decoded.version ?? 0) > USAGE_SCAN_CACHE_VERSION) {
            cacheWritable = false;
            yield* logCacheError(
              scanCachePath,
              decoded.version,
              decoded.entriesDropped,
              decoded.sourcesDropped,
            );
            return;
          }
          for (const [file, entry] of decoded.entries) fileCache.set(file, entry);
          mergeSources(decoded.sources);
          if (!decoded.complete) {
            yield* logCacheError(
              scanCachePath,
              decoded.version,
              decoded.entriesDropped,
              decoded.sourcesDropped,
            );
            const backup = yield* unreadableName(scanCachePath);
            const copied = yield* fileSystem.copyFile(scanCachePath, backup).pipe(
              Effect.andThen(syncCacheFile(backup)),
              Effect.andThen(syncCacheDirectory),
              Effect.tapError((error) =>
                logCacheError(
                  backup,
                  decoded.version,
                  decoded.entriesDropped,
                  decoded.sourcesDropped,
                  error,
                ),
              ),
              Effect.isSuccess,
            );
            if (!copied) {
              cacheWritable = false;
              return;
            }
            rewriteCurrent = true;
            cacheDirty = true;
          }
        }

        const claims: { readonly path: string; readonly unreadablePath?: string }[] = [];
        const oldNames = yield* listLegacyCaches.pipe(
          Effect.catch((cause) => reportSavedUsageGap(config.stateDir, cause).pipe(Effect.as([]))),
        );
        for (const legacy of LEGACY_SCAN_CACHE_FILE_NAMES) {
          for (const name of oldNames.filter((name) => name.endsWith(legacy))) {
            const original = path.join(config.stateDir, name);
            const claim =
              name === legacy
                ? path.join(
                    config.stateDir,
                    `${LEGACY_CLAIM_PREFIX}${yield* crypto.randomUUIDv4()}-${name}`,
                  )
                : original;
            if (claim !== original) {
              const claimed = yield* fileSystem.rename(original, claim).pipe(Effect.result);
              if (claimed._tag === "Failure") {
                yield* reportSavedUsageGap(original, claimed.failure);
                continue;
              }
            }
            const raw = yield* readDocument(claim).pipe(Effect.result);
            if (raw._tag === "Failure") {
              yield* reportSavedUsageGap(claim, raw.failure);
              continue;
            }
            const decoded = yield* decodeDocument(raw.success);
            for (const [file, entry] of decoded.entries) {
              const previous = fileCache.get(file);
              // At the same mtime, growth implies a later append. Equal bytes prefer the newer format read first.
              if (previous === undefined || isLaterFileState(entry, previous)) {
                fileCache.set(file, entry);
                cacheDirty = true;
              }
            }
            if (mergeSources(decoded.sources)) cacheDirty = true;
            if (decoded.complete) {
              claims.push({ path: claim });
            } else {
              yield* logCacheError(
                claim,
                decoded.version,
                decoded.entriesDropped,
                decoded.sourcesDropped,
              );
              claims.push({ path: claim, unreadablePath: yield* unreadableName(claim) });
            }
          }
        }
        if (claims.length === 0 && !rewriteCurrent) return;
        // Persist salvaged rows before moving archives out of the next startup's inputs.
        yield* Effect.gen(function* () {
          const contents = writeScanCache(fileCache, { sources: Object.fromEntries(sourceCache) });
          yield* writeCacheFile(scanCachePath, contents);
          yield* syncCacheFile(scanCachePath);
          yield* syncCacheDirectory;
          cacheDirty = false;
          for (const claim of claims) {
            yield* claim.unreadablePath === undefined
              ? fileSystem.remove(claim.path, { force: true })
              : fileSystem.rename(claim.path, claim.unreadablePath);
          }
        }).pipe(
          Effect.tapError((error) =>
            logCacheError(scanCachePath, USAGE_SCAN_CACHE_VERSION, null, null, error),
          ),
          Effect.ignore,
        );
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            detail: "Saved transcript usage could not be loaded.",
            cause,
          }),
      ),
      Effect.withSpan("UsageService.loadScanCache"),
    ),
  );
  yield* listLegacyCaches.pipe(
    Effect.result,
    Effect.flatMap((listed) =>
      listed._tag === "Failure" || listed.success.length > 0 ? ensureScanCacheLoaded : Effect.void,
    ),
    Effect.forkIn(scope),
  );

  const persistLock = yield* Semaphore.make(1);

  const persistCaches = Effect.gen(function* () {
    if (!cacheWritable || !cacheDirty) return;
    yield* withCacheLock(
      Effect.gen(function* () {
        const document = yield* readCurrent;
        const disk = Option.isSome(document) ? yield* decodeDocument(document.value) : undefined;
        if (disk !== undefined && !disk.complete) {
          yield* logCacheError(
            scanCachePath,
            disk.version,
            disk.entriesDropped,
            disk.sourcesDropped,
          );
          return;
        }
        const cutoff =
          (yield* Clock.currentTimeMillis) - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
        const files = disk?.entries ?? new Map<string, CachedFile>();
        const sources = disk?.sources ?? new Map<string, typeof CachedSource.Type>();
        for (const [file, local] of fileCache) {
          const persisted = files.get(file);
          if (
            persisted === undefined ||
            isLaterFileState(local, persisted) ||
            (sameFileState(local, persisted) &&
              !local.needsReparse &&
              (persisted.needsReparse || updatedFiles.has(file)))
          )
            files.set(file, local);
        }
        for (const [key, source] of sourceCache) {
          if (!sources.has(key) || updatedSources.has(key)) sources.set(key, source);
        }
        pruneScanCache(files, cutoff);
        const contents = writeScanCache(files, { sources: Object.fromEntries(sources) });
        const writtenFiles = new Set(updatedFiles);
        const writtenSources = new Set(updatedSources);
        updatedFiles.clear();
        updatedSources.clear();
        cacheDirty = false;
        yield* writeCacheFile(scanCachePath, contents).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              for (const file of writtenFiles) updatedFiles.add(file);
              for (const key of writtenSources) updatedSources.add(key);
              cacheDirty = true;
            }),
          ),
        );
      }),
    ).pipe(Effect.catch((cause) => logCacheError(scanCachePath, undefined, null, null, cause)));
  }).pipe(persistLock.withPermit, Effect.withSpan("UsageService.persistCaches"));

  const pendingPersists = new Set<Fiber.Fiber<void>>();
  const schedulePersist = Effect.forkDetach(persistCaches).pipe(
    Effect.map((fiber) => {
      pendingPersists.add(fiber);
      fiber.addObserver(() => pendingPersists.delete(fiber));
    }),
  );
  const awaitPersisted = Effect.suspend(() => Fiber.awaitAll([...pendingPersists])).pipe(
    Effect.asVoid,
  );
  yield* Effect.addFinalizer(() => awaitPersisted);

  /** Reads may finish in any order. Aggregation orders live and retained files together for duplicate credit. */
  const readFileRecords = Effect.fn("UsageService.readFileRecords")(function* (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
    format: TranscriptUsageFormat<unknown>,
    onProgress: () => void,
  ): Effect.fn.Return<{
    readonly records: readonly UsageRecord[];
    readonly malformedRecords: number;
    readonly failed?: true;
    readonly update?: CachedFile;
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

    const parsed = yield* Effect.promise((signal) =>
      readTranscriptRecords(filePath, format, resumeFrom, { signal, onProgress }),
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
    return { files, failedPaths: cached.failedPaths + updated.failedPaths };
  });

  const scanTranscriptDir = Effect.fn("UsageService.scanTranscriptDir")(function* (
    source: TranscriptSource,
    windowStartMs: number,
    scanListings: Map<string, Listing>,
    onProgress: () => void,
  ) {
    const { provider, format, dir, volumeId, fileName } = source;
    const key = `${dir}\0${fileName ?? ""}`;
    const exists = yield* fileSystem
      .exists(dir)
      .pipe(Effect.catchCause(() => Effect.succeed(false)));
    if (!exists) {
      listings.delete(key);
      return { provider, dir, volumeId, files: null } satisfies ScannedDir;
    }
    const listing =
      scanListings.get(key) ?? (yield* transcriptListing(key, dir, fileName, onProgress));
    scanListings.set(key, listing);
    const candidates = listing.files.filter((file) => file.mtimeMs >= windowStartMs);
    const read = yield* Effect.forEach(
      candidates,
      (file) =>
        readFileRecords(file.path, file.size, file.mtimeMs, provider, format, onProgress).pipe(
          Effect.map(({ records, malformedRecords, failed, update }) => {
            onProgress();
            if (update !== undefined) {
              updatedFiles.add(file.path);
              fileCache.set(file.path, {
                ...update,
                records: correctedBatch(update.records),
                tailRecords: correctedBatch(update.tailRecords),
              });
              cacheDirty = true;
            }
            return { path: file.path, records, malformedRecords, failed };
          }),
        ),
      { concurrency: TRANSCRIPT_READ_CONCURRENCY },
    );
    const unread = listing.failedPaths + read.filter((file) => file.failed).length;
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

  const collectProviderDirs = Effect.fn("UsageService.collectProviderDirs")(function* (
    windowStartMs: number,
    settings: ServerSettingsValue,
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
  };

  interface ScanFlight {
    readonly key: string;
    readonly input: UsageSummaryInput;
    readonly settings: ServerSettingsValue;
    readonly initial: Deferred.Deferred<UsageSummary, UsageReadError>;
    readonly refreshed: Deferred.Deferred<UsageSummary, UsageReadError>;
    snapshot?: UsageSummary;
    needsFollowUp: boolean;
  }

  const scanSummary = Effect.fn("UsageService.scanSummary")(function* (
    input: UsageSummaryInput,
    settings: ServerSettingsValue,
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

    const retentionCutoffMs = startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

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
    const dirs = yield* resolveTranscriptDirs(settings, retentionCutoffMs).pipe(
      Effect.provideContext(readerContext),
    );
    const scanListings = new Map<string, Listing>();
    const transcripts = yield* Effect.forEach(dirs, (dir) =>
      scanTranscriptDir(dir, windowStartMs, scanListings, onProgress),
    );

    yield* Fiber.join(rateLoad);
    const window = {
      hourlyWindow,
      windowStartMs,
      retentionCutoffMs,
      startedAtMs,
      rates,
      pricing: pricing(),
    };
    if (providerLoad.pollUnsafe() === undefined) {
      const sources = scanReaders.flatMap(
        ({ reader }) =>
          completedProviders.get(reader.provider) ?? [
            {
              provider: reader.provider,
              dir: `usage-refresh:${reader.provider}`,
              volumeId: "",
              files: [],
              status: "partial" as const,
              message: "Usage source is still refreshing.",
            },
          ],
      );
      flight.snapshot = yield* aggregateSummary(
        input,
        settings,
        [...transcripts, ...sources],
        window,
      );
    }
    const providers = yield* Fiber.join(providerLoad);
    const initial = yield* aggregateSummary(
      input,
      settings,
      [...transcripts, ...providers],
      window,
      flight,
    );
    flight.snapshot = initial;
    const refreshing = new Set(
      providers.filter((source) => source.refreshing).map((source) => source.provider),
    );
    if (refreshing.size === 0) return initial;

    yield* schedulePersist;
    flight.needsFollowUp = true;
    yield* Deferred.succeed(flight.initial, initial);
    const refreshed = yield* collectProviderDirs(
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
    return yield* aggregateSummary(
      input,
      settings,
      [
        ...transcripts,
        ...providers.filter((source) => !refreshing.has(source.provider)),
        ...refreshed,
      ],
      window,
    );
  });

  const aggregateSummary = Effect.fn("UsageService.aggregateSummary")(function* (
    input: UsageSummaryInput,
    settings: ServerSettingsValue,
    scannedDirs: readonly ScannedDir[],
    window: ScanWindow,
    flight?: ScanFlight,
  ) {
    const { hourlyWindow, windowStartMs, retentionCutoffMs, startedAtMs } = window;
    // Deleted transcripts' saved usage still aggregates and deduplicates normally.
    const retainedSinceMs = Math.max(windowStartMs, retentionCutoffMs);
    const filesByDir = scannedDirs.map(({ provider, dir, files }) => {
      const retainedFiles = [...(files ?? [])];
      const livePaths = new Set(retainedFiles.map((file) => file.path));
      for (const [filePath, entry] of fileCache) {
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
    const finish = Effect.fn("UsageService.finishSummary")(function* () {
      const aggregator = new UsageAggregator({
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        resolution: input.resolution ?? "day",
        ...hourlyWindow,
        rates: window.rates,
        priceOverrides: createOverrideRateTable(settings.usagePriceOverrides),
        modelAliases: resolveModelAliases(settings.usageModelAliases),
        ...(input.modelFilter === undefined ? {} : { modelFilter: input.modelFilter }),
      });

      const crossFileSessions = sharedSessions(filesByDir.flat());
      const counts = filesByDir.map(() => ({
        scannedFiles: 0,
        skippedFiles: 0,
        malformedRecords: 0,
        sessionIds: new Set<string>(),
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
        count.malformedRecords += file.malformedRecords;
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
          if (aggregator.add(usageRecord, dir) && record.sessionId.length > 0) {
            count.sessionIds.add(record.sessionId);
          }
        }
      }

      const sources: UsageSource[] = [];
      for (const [
        index,
        {
          provider,
          dir,
          volumeId,
          files,
          status,
          message,
          action,
          refreshing,
          hostId: sourceHostId,
        },
      ] of scannedDirs.entries()) {
        const { scannedFiles, skippedFiles, malformedRecords, sessionIds } = counts[index]!;
        const savedUsageGap = cacheReadIncomplete && transcriptFormats.has(provider);
        const sourceMessage = savedUsageGap
          ? [message, "Some saved usage could not be read."].filter(Boolean).join(" ")
          : (message ?? (files === null ? "No transcript directory on this environment." : null));
        sources.push({
          fingerprint: {
            hostId: sourceHostId ?? hostId,
            provider,
            resolvedHomePath: dir,
            volumeId,
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
          ...(action ? { action } : {}),
          ...(refreshing ? { refreshing } : {}),
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
        pricing: window.pricing,
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
      for (const [filePath, entry] of fileCache) {
        const records = correctedBatch(entry.records);
        const tailRecords = correctedBatch(entry.tailRecords);
        if (records === entry.records && tailRecords === entry.tailRecords) continue;
        updatedFiles.add(filePath);
        fileCache.set(filePath, { ...entry, records, tailRecords });
        cacheDirty = true;
      }
    }
    const pruned = pruneScanCache(fileCache, retentionCutoffMs);
    if (pruned > 0) cacheDirty = true;

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
      const settings = yield* readSettings;
      const key = encodeUsageRecordKey([query, settings]);
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
      return yield* Deferred.await(input.awaitRefresh ? flight.refreshed : flight.initial);
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

  return { readSummary, refreshRates, awaitPersisted, priceTokens } as const;
});

export const layer = Layer.effect(UsageService, make);
