import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DatabaseStorage from "./DatabaseStorage.ts";
import * as Sqlite from "./Sqlite.ts";

const freePages = Effect.map(
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`,
  ),
  (rows) => rows[0]?.freelist_count ?? 0,
);

const storageLayer = <E>(
  config: Layer.Layer<ServerConfig.ServerConfig, E, FileSystem.FileSystem | Path.Path>,
) =>
  DatabaseStorage.layer.pipe(
    Layer.provide(ProjectionMaintenance.layer),
    Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(config),
    Layer.provide(NodeServices.layer),
  );

const testConfig = ServerConfig.layerTest(process.cwd(), { prefix: "database-storage-" });

// Uses the SQL client of the test, so a test can write rows before the service reads them.
const growthLayer = DatabaseStorage.layer.pipe(
  Layer.provide(ProjectionMaintenance.layer),
  Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
  Layer.provide(ServerSettings.layerTest()),
);

it.effect("a new database returns freed pages online without losing data", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storage = yield* DatabaseStorage.DatabaseStorage;
    assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
    yield* sql`CREATE TABLE retained (value TEXT)`;
    yield* sql`INSERT INTO retained VALUES ('keep')`;
    yield* sql`CREATE TABLE discarded (value BLOB)`;
    yield* sql`INSERT INTO discarded VALUES (zeroblob(1048576))`;
    yield* sql`DROP TABLE discarded`;
    assert.isAbove(yield* freePages, 0);
    yield* storage.reclaim;
    assert.equal(yield* freePages, 0);
    assert.deepEqual(yield* sql`SELECT value FROM retained`, [{ value: "keep" }]);
  }).pipe(Effect.provide(storageLayer(testConfig))),
);

const compactionLayer = (
  compactEventStore: ProjectionMaintenance.ProjectionMaintenanceV2["Service"]["compactEventStore"],
) =>
  DatabaseStorage.layer.pipe(
    Layer.provide(
      Layer.succeed(ProjectionMaintenance.ProjectionMaintenanceV2, {
        compactEventStore,
        pruneColdThreadToolOutput: () => Effect.succeed(emptyRetention),
        compactColdThreadHistory: () => Effect.succeed({ threadCount: 0, deletedEventCount: 0 }),
        verify: Effect.die("unexpected verification"),
        rebuild: Effect.die("unexpected rebuild"),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(Sqlite.layerMemory),
  );

const minute = 60_000;
const startupTime = Date.UTC(2026, 9, 19);
const emptyCompaction = { deletedEventCount: 0, deletedReceiptCount: 0, reclaimableBytes: 0 };
const emptyRetention = { threadCount: 0, itemCount: 0, eventCount: 0, unreadableItemCount: 0 };

it.effect("remembers completion only after the paced pass finishes", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startupTime);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const timestampPath = path.join(path.dirname(config.dbPath), "compacted-at");
    const betweenPagesReached = yield* Deferred.make<void>();
    const completed = yield* Deferred.make<void>();
    const timestampWritten = yield* Deferred.make<void>();
    const compact = (betweenPages: Effect.Effect<void> = Effect.void) =>
      Effect.gen(function* () {
        yield* Effect.sleep(30);
        yield* Deferred.succeed(betweenPagesReached, undefined);
        yield* betweenPages;
        yield* Deferred.succeed(completed, undefined);
        return emptyCompaction;
      });
    yield* Effect.gen(function* () {
      yield* TestClock.adjust(minute);
      yield* TestClock.adjust(30);
      yield* Deferred.await(betweenPagesReached);
      assert.isFalse(yield* Deferred.isDone(completed));
      assert.isFalse(yield* fs.exists(timestampPath));
      yield* TestClock.adjust(269);
      assert.isFalse(yield* Deferred.isDone(completed));
      assert.isFalse(yield* fs.exists(timestampPath));
      yield* TestClock.adjust(1);
      yield* Deferred.await(timestampWritten);
      assert.isTrue(yield* Deferred.isDone(completed));
      assert.equal(Number(yield* fs.readFileString(timestampPath)), startupTime + minute + 300);
    }).pipe(
      Effect.provide(compactionLayer(compact)),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        writeFileString: (file, content, options) =>
          fs
            .writeFileString(file, content, options)
            .pipe(Effect.ensuring(Deferred.succeed(timestampWritten, undefined))),
      }),
    );
  }).pipe(Effect.provide(testConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("reports the average daily growth over the past week of size samples", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startupTime);
    const sql = yield* SqlClient.SqlClient;
    const day = 24 * 60 * minute;
    const mib = 1024 ** 2;
    const [layout] = yield* sql<{ readonly bytes: number }>`
      SELECT page_count * page_size AS bytes FROM pragma_page_count, pragma_page_size
    `;
    const bytes = layout!.bytes;
    // A fresh service per case, so its first status reads the samples written just before.
    const growthWith = (samples: ReadonlyArray<readonly [ageMs: number, bytes: number]>) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM database_size_samples`;
        for (const [ageMs, sampleBytes] of samples) {
          yield* sql`
            INSERT INTO database_size_samples (sampled_at, database_bytes)
            VALUES (${startupTime - ageMs}, ${sampleBytes})
          `;
        }
        const status = yield* Effect.gen(function* () {
          const storage = yield* DatabaseStorage.DatabaseStorage;
          return yield* storage.status.pipe(
            Stream.filter((status) => status !== null),
            Stream.runHead,
          );
        }).pipe(Effect.provide(growthLayer));
        const kept = yield* sql<{ readonly sampled_at: number }>`
          SELECT sampled_at FROM database_size_samples ORDER BY sampled_at
        `;
        return {
          dailyGrowthBytes: Option.getOrThrow(status).dailyGrowthBytes,
          sampleAges: kept.map((sample) => startupTime - sample.sampled_at),
        };
      });

    assert.deepEqual(yield* growthWith([]), { dailyGrowthBytes: null, sampleAges: [0] });
    // A sample from today is the newest, so no new one is taken and growth waits for a day.
    assert.deepEqual(yield* growthWith([[day / 2, bytes - mib]]), {
      dailyGrowthBytes: null,
      sampleAges: [day / 2],
    });
    // The sample past the week drops out, so growth averages over the remaining two days.
    assert.deepEqual(
      yield* growthWith([
        [9 * day, bytes - 9 * mib],
        [2 * day, bytes - 2 * mib],
      ]),
      { dailyGrowthBytes: mib, sampleAges: [2 * day, 0] },
    );
    assert.deepEqual(yield* growthWith([[4 * day, bytes + 4 * mib]]), {
      dailyGrowthBytes: -mib,
      sampleAges: [4 * day, 0],
    });
    // Between samples growth comes from the samples alone, so the status stays unchanged.
    assert.deepEqual(
      yield* growthWith([
        [day * 1.5, bytes - 2 * mib],
        [day / 2, bytes - mib],
      ]),
      { dailyGrowthBytes: mib, sampleAges: [day * 1.5, day / 2] },
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Sqlite.layerMemory, testConfig).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);
