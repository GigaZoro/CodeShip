import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DatabaseMaintenance from "./DatabaseMaintenance.ts";
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
    Layer.provide(ServerSettings.layerTest()),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(config),
    Layer.provide(NodeServices.layer),
  );

const testConfig = ServerConfig.layerTest(process.cwd(), { prefix: "database-storage-" });

// Uses the SQL client of the test, so a test can write rows before the service reads them.
const growthLayer = DatabaseStorage.layer.pipe(
  Layer.provide(ProjectionMaintenance.layer),
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
    yield* sql`INSERT INTO discarded VALUES (zeroblob(6291456))`;
    yield* sql`DROP TABLE discarded`;
    const before = yield* freePages;
    assert.isAbove(before, 1024);
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    yield* storage.reclaim.pipe(Effect.withTracer(tracer), Effect.withTracerEnabled(true));
    assert.equal(before - (yield* freePages), 1024);
    assert.lengthOf(spans, 1);
    assert.deepEqual(
      spans.map((span) => span.name),
      ["DatabaseStorage.reclaim"],
    );
    assert.equal(spans[0]?.attributes.get("db.reclaimed_pages"), 1024);
    yield* storage.reclaim;
    assert.equal(yield* freePages, 0);
    assert.deepEqual(yield* sql`SELECT value FROM retained`, [{ value: "keep" }]);
  }).pipe(Effect.provide(storageLayer(testConfig))),
);

const compactionLayer = (
  pruneEventStore: ProjectionMaintenance.ProjectionMaintenanceV2["Service"]["pruneEventStore"],
) =>
  DatabaseStorage.layer.pipe(
    Layer.provide(
      Layer.succeed(ProjectionMaintenance.ProjectionMaintenanceV2, {
        pruneEventStore,
        pruneColdThreadToolOutput: () => Effect.succeed(emptyRetention),
        compactColdThreadHistory: () => Effect.succeed({ threadCount: 0, deletedEventCount: 0 }),
        purgeDeletedThread: () => Effect.succeed(0),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(Sqlite.layerMemory),
  );

const minute = 60_000;
const startupTime = Date.UTC(2026, 9, 19);
const emptyCompaction = {
  deletedEventCount: 0,
  deletedReceiptCount: 0,
  purgedRowCount: 0,
  reclaimableBytes: 0,
};
const emptyRetention = { threadCount: 0, itemCount: 0, eventCount: 0, unreadableItemCount: 0 };

it.effect("remembers completion only after the paced pass finishes", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startupTime);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const timestampPath = path.join(path.dirname(config.dbPath), "compacted-at-v2");
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

// NONE is a database from before automatic shrinking, which the repair converts.
const reclaimLayer = (
  restart: Effect.Effect<void> | null,
  autoVacuum: "NONE" | "FULL" | "INCREMENTAL" = "NONE",
) =>
  DatabaseStorage.layer.pipe(
    Layer.provide(ProjectionMaintenance.layer),
    Layer.provide(Layer.succeed(DatabaseStorage.ServerRestart, restart)),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(`PRAGMA auto_vacuum = ${autoVacuum}`);
          yield* sql`VACUUM`;
        }),
      ).pipe(Layer.provideMerge(Sqlite.layerMemory)),
    ),
  );

it.effect(
  "a reclaim from Settings saves its request, then restarts the server after replying",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const files = DatabaseMaintenance.reclaimFiles(path, config.dbPath);
      const request = Effect.flatMap(
        DatabaseStorage.DatabaseStorage,
        (storage) => storage.requestReclaim,
      );
      const restarted = yield* Deferred.make<void>();
      const restart = Deferred.succeed(restarted, undefined).pipe(Effect.asVoid);

      // Nothing starts a server run by hand again, so it keeps pointing at the command.
      const unsupervised = yield* request.pipe(Effect.flip, Effect.provide(reclaimLayer(null)));
      assert.equal(unsupervised._tag, "DatabaseReclaimError");
      // A database that already shrinks on its own (or a stale dialog after another client's
      // repair) has nothing to reclaim, so it must not restart.
      for (const autoVacuum of ["FULL", "INCREMENTAL"] as const) {
        const refused = yield* request.pipe(
          Effect.flip,
          Effect.provide(reclaimLayer(restart, autoVacuum)),
        );
        assert.equal(refused._tag, "DatabaseReclaimError", autoVacuum);
      }
      assert.isFalse(yield* fs.exists(files.request));

      yield* fs.writeFileString(files.failure, "an earlier failure");
      yield* Effect.gen(function* () {
        const storage = yield* DatabaseStorage.DatabaseStorage;
        const shownFailure = storage.status.pipe(
          Stream.filter((status) => status !== null),
          Stream.runHead,
          Effect.map((status) => Option.getOrThrow(status)?.reclaimFailure),
        );
        assert.equal(yield* shownFailure, "an earlier failure");
        yield* storage.requestReclaim;
        // The retry clears it at once, so Settings shows the restart, not the old failure.
        assert.isUndefined(yield* shownFailure);
      }).pipe(Effect.provide(reclaimLayer(restart)));
      assert.isTrue(yield* fs.exists(files.request));
      assert.isFalse(yield* fs.exists(files.failure));
      assert.isFalse(yield* Deferred.isDone(restarted), "the reply must go out before the restart");
      yield* TestClock.adjust(500);
      yield* Deferred.await(restarted);
    }).pipe(Effect.provide(testConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect(
  "purges threads deleted before upgrading without waiting for the next six-hour pass",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(startupTime);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(path.dirname(config.dbPath), { recursive: true });
      // The previous version compacted a minute ago, but never purged deleted threads.
      yield* fs.writeFileString(
        path.join(path.dirname(config.dbPath), "compacted-at"),
        String(startupTime - minute),
      );
      const contentRows = Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_projection_messages
        WHERE thread_id = 'thread:deleted-before-upgrade'
      `,
      ).pipe(Effect.map((rows) => rows[0]?.count ?? 0));

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const at = DateTime.formatIso(DateTime.makeUnsafe(startupTime - 2 * minute));
        yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, deleted_at, payload_json
        ) VALUES (
          'thread:deleted-before-upgrade', 'project:upgrade', 'private title', 'codex',
          'full-access', 'default', ${at}, ${at}, ${at}, '{"title":"private title"}'
        )
      `;
        yield* sql`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, role, streaming, created_at, updated_at, payload_json
        ) VALUES (
          'message:deleted-before-upgrade', 'thread:deleted-before-upgrade', 'user', 0,
          ${at}, ${at}, '{"text":"private message"}'
        )
      `;
        assert.equal(yield* contentRows, 1);
        yield* DatabaseStorage.DatabaseStorage;

        yield* TestClock.adjust(5 * minute);

        assert.equal(yield* contentRows, 0);
      }).pipe(
        Effect.provide(
          DatabaseStorage.layer.pipe(
            Layer.provide(ProjectionMaintenance.layer),
            Layer.provideMerge(Sqlite.layerMemory),
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        testConfig.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(ServerSettings.layerTest()),
        ),
      ),
    ),
);
