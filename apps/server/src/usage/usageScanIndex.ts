import * as NodeWorkerThreads from "node:worker_threads";

import { UsageReadError, type UsageProviderKind } from "@t3tools/contracts";
import type { TranscriptUsageFormat } from "@t3tools/provider-core/server/usage";
import { readOnly } from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import {
  decodeScanCache,
  encodeScanCache,
  isLaterRead,
  LEGACY_SCAN_CACHE_FILE_NAMES,
  ROLLBACK_SCAN_CACHE_FILE_NAME,
  type CachedFile,
  type ScanCache,
} from "./usageScanCache.ts";

const CACHE_PAGE_SIZE = 64;
const SOURCE_KEY = "sources";
const IMPORT_KEY = "legacy-import-complete";
const IMPORT_ID = -2;
const SOURCE_ID = -1;
const FILE_PREFIX = "file:";
const Json = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownEffect(Json);
const encodeJson = Schema.encodeEffect(Json);

const CachedSource = Schema.Struct({ dir: Schema.String, volumeId: Schema.String });
const CachedSources = Schema.Struct({ sources: Schema.Record(Schema.String, CachedSource) });
export interface ScanIndexChange {
  readonly entry: CachedFile | null;
  readonly order: number;
}

export type ScanSources = Map<string, typeof CachedSource.Type>;
const getSources = Schema.decodeUnknownOption(CachedSources);

const legacyReaderSource = `(() => {
  const { readFileSync } = require("node:fs");
  const { parentPort, workerData } = require("node:worker_threads");
  let document;
  try {
    document = JSON.parse(readFileSync(workerData, "utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    parentPort.postMessage({ type: "invalid" });
    parentPort.close();
    return;
  }
  const { version, models, sessions, sources, files } = document ?? {};
  if (typeof version !== "number" || !Array.isArray(models) || !Array.isArray(sessions) ||
      files === null || typeof files !== "object") {
    parentPort.postMessage({ type: "invalid" });
    parentPort.close();
    return;
  }
  parentPort.postMessage({ type: "header", version, models, sessions, sources });
  const entries = Object.entries(files);
  for (let index = 0; index < entries.length; index += 32) {
    parentPort.postMessage({ type: "files", files: Object.fromEntries(entries.slice(index, index + 32)) });
  }
  parentPort.postMessage({ type: "done" });
  parentPort.close();
})();`;

type LegacyMessage =
  | {
      readonly type: "header";
      readonly version: number;
      readonly models: unknown;
      readonly sessions: unknown;
      readonly sources: unknown;
    }
  | { readonly type: "files"; readonly files: unknown }
  | { readonly type: "done" }
  | { readonly type: "invalid" };

const readLegacy = Effect.fn("UsageScanIndex.readLegacy")(function* (
  filePath: string,
  formats: ReadonlyMap<UsageProviderKind, TranscriptUsageFormat<unknown>>,
) {
  return yield* Effect.callback<{ files: ScanCache; sources: ScanSources }, UsageReadError>(
    (resume) => {
      const failure = (cause: unknown) =>
        resume(
          new UsageReadError({
            reason: "scanFailed",
            detail: "The legacy usage cache could not be read.",
            cause,
          }),
        );
      const worker = new NodeWorkerThreads.Worker(legacyReaderSource, {
        eval: true,
        execArgv: [],
        workerData: filePath,
      });
      const files: ScanCache = new Map();
      const sources: ScanSources = new Map();
      let header: Extract<LegacyMessage, { type: "header" }> | undefined;
      worker.on("message", (message: LegacyMessage) => {
        switch (message.type) {
          case "header": {
            header = message;
            const decoded = getSources(header);
            if (decoded._tag === "Some") {
              for (const [key, source] of Object.entries(decoded.value.sources))
                sources.set(key, source);
            }
            break;
          }
          case "files":
            for (const [file, entry] of decodeScanCache(
              { ...header, files: message.files },
              formats,
            )) {
              files.set(file, entry);
            }
            break;
          case "done":
            resume(Effect.succeed({ files, sources }));
            break;
          case "invalid":
            failure(new Error("Invalid legacy usage cache"));
            break;
        }
      });
      worker.once("error", failure);
      worker.once("exit", (code) =>
        failure(new Error(`Legacy usage reader exited with code ${code}`)),
      );
      return Effect.promise(() => worker.terminate()).pipe(Effect.asVoid);
    },
  );
});

export const make = Effect.fn("UsageScanIndex.make")(function* (
  formats: ReadonlyMap<UsageProviderKind, TranscriptUsageFormat<unknown>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const sql = yield* SqlClient.SqlClient;

  const put = (id: number, key: string, contents: string) =>
    sql`INSERT INTO usage_scan_index (id, cache_key, contents) VALUES (${id}, ${key}, ${contents})
        ON CONFLICT (cache_key) DO UPDATE SET contents = excluded.contents`;

  const removeLegacy = Effect.forEach(
    LEGACY_SCAN_CACHE_FILE_NAMES.filter((name) => name !== ROLLBACK_SCAN_CACHE_FILE_NAME),
    (name) => fs.remove(path.join(stateDir, name), { force: true }),
    { discard: true },
  ).pipe(Effect.ignore({ log: true }));

  const write = Effect.fn("UsageScanIndex.write")(function* (
    changes: ReadonlyMap<string, ScanIndexChange>,
    sources?: ScanSources,
  ) {
    const entries = [...changes];
    for (let offset = 0; offset < entries.length; offset += CACHE_PAGE_SIZE) {
      const rows: Array<{ id: number; cache_key: string; contents: string }> = [];
      const deletions: string[] = [];
      for (const [file, { entry, order }] of entries.slice(offset, offset + CACHE_PAGE_SIZE)) {
        const key = FILE_PREFIX + file;
        if (entry === null) deletions.push(key);
        else
          rows.push({
            id: order,
            cache_key: key,
            contents: encodeScanCache(new Map([[file, entry]])),
          });
      }
      const remove =
        deletions.length > 0
          ? sql`DELETE FROM usage_scan_index WHERE ${sql.in("cache_key", deletions)}`
          : Effect.void;
      const upsert =
        rows.length > 0
          ? sql`INSERT INTO usage_scan_index ${sql.insert(rows)}
            ON CONFLICT (cache_key) DO UPDATE SET id = excluded.id, contents = excluded.contents`
          : Effect.void;
      const batch = remove.pipe(Effect.andThen(upsert));
      yield* deletions.length > 0 && rows.length > 0 ? sql.withTransaction(batch) : batch;
      yield* Effect.yieldNow;
    }
    if (sources !== undefined) {
      yield* put(
        SOURCE_ID,
        SOURCE_KEY,
        yield* encodeJson({ sources: Object.fromEntries(sources) }),
      );
    }
  });

  const load = Effect.fn("UsageScanIndex.load")(function* () {
    const metadata = yield* readOnly(
      sql<{ cache_key: string; contents: string }>`
        SELECT cache_key, contents FROM usage_scan_index
        WHERE ${sql.in("cache_key", [SOURCE_KEY, IMPORT_KEY])}
      `,
    );
    const files: ScanCache = new Map();
    const orders = new Map<string, number>();
    const sources: ScanSources = new Map();
    const sourceRow = metadata.find((row) => row.cache_key === SOURCE_KEY);
    if (sourceRow !== undefined) {
      const decoded = getSources(yield* decodeJson(sourceRow.contents));
      if (decoded._tag === "Some") {
        for (const [key, source] of Object.entries(decoded.value.sources)) sources.set(key, source);
      }
    }

    let after = 0;
    while (true) {
      const rows = yield* readOnly(
        sql<{ id: number; contents: string }>`
          SELECT id, contents FROM usage_scan_index
          WHERE id > ${after} AND cache_key LIKE 'file:%'
          ORDER BY id LIMIT ${CACHE_PAGE_SIZE}
        `,
      );
      for (const { id, contents } of rows) {
        const document = yield* decodeJson(contents);
        for (const [file, entry] of decodeScanCache(document, formats)) {
          files.set(file, entry);
          orders.set(file, id);
        }
        after = id;
      }
      if (rows.length < CACHE_PAGE_SIZE) break;
      yield* Effect.yieldNow;
    }

    const rollbackPath = path.join(stateDir, ROLLBACK_SCAN_CACHE_FILE_NAME);
    const rollbackStamp = yield* fs.stat(rollbackPath).pipe(
      Effect.map((info) => `${Option.getOrUndefined(info.mtime)?.getTime()}:${info.size}`),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("absent")),
      Effect.catch((error) =>
        Effect.logWarning("Could not stat the rollback usage cache", error).pipe(Effect.as(null)),
      ),
    );
    const previousImport = metadata.find((row) => row.cache_key === IMPORT_KEY);
    if (rollbackStamp === null || previousImport?.contents !== rollbackStamp) {
      let incomplete = rollbackStamp === null;
      for (const name of LEGACY_SCAN_CACHE_FILE_NAMES) {
        const filePath = path.join(stateDir, name);
        const legacy = yield* fs.exists(filePath).pipe(
          Effect.flatMap((exists) =>
            exists ? readLegacy(filePath, formats).pipe(Effect.asSome) : Effect.succeedNone,
          ),
          Effect.catch((error) =>
            Effect.logWarning("Could not read legacy usage scan index", { name, error }).pipe(
              Effect.as(null),
            ),
          ),
        );
        if (legacy === null) {
          incomplete = true;
          continue;
        }
        if (Option.isNone(legacy)) continue;

        // A rolled-back server can save newer entries in the preserved v10 file.
        const imported = new Map<string, ScanIndexChange>();
        for (const [file, entry] of legacy.value.files) {
          const current = files.get(file);
          if (current !== undefined && !isLaterRead(entry, current)) continue;
          const order = orders.get(file) ?? ++after;
          files.set(file, entry);
          orders.set(file, order);
          imported.set(file, { entry, order });
        }
        for (const [key, source] of legacy.value.sources) {
          if (!sources.has(key)) sources.set(key, source);
        }
        yield* write(imported, sources);
        break;
      }
      // A failed import leaves the old cache available for another startup.
      if (incomplete || rollbackStamp === null) return { files, sources, orders, lastOrder: after };
      yield* put(IMPORT_ID, IMPORT_KEY, rollbackStamp);
    }

    yield* removeLegacy;
    return { files, sources, orders, lastOrder: after };
  });

  return { load, write };
});
