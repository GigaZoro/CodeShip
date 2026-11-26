import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as DatabaseMaintenance from "./DatabaseMaintenance.ts";
import { runMigrations } from "./Migrations.ts";
import * as Sqlite from "./Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

const COMMAND_OUTPUT_BYTES = 1_000_000;

/** An archived chat whose one finished command printed `COMMAND_OUTPUT_BYTES` of output at `at`. */
function archivedChatWithOutput(key: string, at: DateTime.Utc) {
  const threadId = ThreadId.make(`thread:${key}`);
  const instanceId = ProviderInstanceId.make("codex");
  const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
    {
      id: EventId.make(`event:${key}:created`),
      type: "thread.created",
      threadId,
      providerInstanceId: instanceId,
      occurredAt: at,
      payload: {
        id: threadId,
        projectId: ProjectId.make(`project:${key}`),
        title: key,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: at,
        updatedAt: at,
        archivedAt: at,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    },
    {
      id: EventId.make(`event:${key}:command`),
      type: "turn-item.updated",
      threadId,
      occurredAt: at,
      payload: {
        id: TurnItemId.make(`${threadId}:command`),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        title: "cat build.log",
        type: "command_execution",
        input: "cat build.log",
        output: "x".repeat(COMMAND_OUTPUT_BYTES),
        exitCode: 0,
      },
    },
  ];
  return { threadId, events };
}

it.layer(DatabaseMaintenance.layer.pipe(Layer.provideMerge(NodeServices.layer)))(
  "DatabaseMaintenance",
  (it) => {
    it.effect("reports an unreadable database as an inspection failure", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const dbPath = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-inspect-" }),
          "statev2.sqlite",
        );
        yield* fs.writeFileString(dbPath, "not a database");
        const failure = yield* Effect.flip(maintenance.inspect(dbPath));
        assert.equal(failure._tag, "DatabaseInspectError");
      }).pipe(Effect.scoped),
    );

    it.effect("estimates space that shrunken rows left inside pages, which VACUUM returns", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const dbPath = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-fragmented-" }),
          "statev2.sqlite",
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE rows (id INTEGER PRIMARY KEY, value BLOB)`;
          yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
            INSERT INTO rows SELECT i, zeroblob(500) FROM n`;
          // Shrinking rows in place, as removing tool output does, leaves their pages partly empty.
          yield* sql`UPDATE rows SET value = zeroblob(20)`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

        const fragmented = (yield* maintenance.inspect(dbPath)).fragmentedBytes;
        assert.isAbove(fragmented, 500_000);

        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`VACUUM`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        assert.isBelow((yield* maintenance.inspect(dbPath)).fragmentedBytes, fragmented / 4);
      }).pipe(Effect.scoped),
    );

    it.effect("reports and deletes only the database from before 0.1.0", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const userdata = yield* fs.makeTempDirectoryScoped({ prefix: "t3-legacy-" });
        const dbPath = path.join(userdata, "statev2.sqlite");
        const legacy = path.join(userdata, "state.sqlite");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE retained_data (value TEXT)`;
          yield* sql`INSERT INTO retained_data VALUES ('keep')`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        assert.isNull((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes);

        const openLegacy = NodeSqliteClient.layer({ filename: legacy });
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA journal_mode = WAL`;
          yield* sql`CREATE TABLE v1_data (value TEXT)`;
          yield* sql`INSERT INTO v1_data VALUES ('rollback')`;
        }).pipe(Effect.provide(openLegacy));
        assert.isAbove((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes ?? 0, 0);

        const refused = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`SELECT value FROM v1_data`;
          const failure = yield* Effect.flip(maintenance.removeLegacyDatabase(dbPath));
          assert.deepEqual(yield* sql`SELECT value FROM v1_data`, [{ value: "rollback" }]);
          return failure;
        }).pipe(Effect.provide(openLegacy));
        assert.equal(refused._tag, "DatabaseInUseError");
        assert.isTrue(yield* fs.exists(legacy));

        yield* Effect.flatMap(DatabaseMaintenance.DatabaseMaintenance, (service) =>
          service.removeLegacyDatabase(dbPath),
        ).pipe(
          Effect.provide(Layer.fresh(DatabaseMaintenance.layer)),
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            remove: (target, options) =>
              Effect.gen(function* () {
                if (target === legacy) {
                  yield* Effect.gen(function* () {
                    const sql = yield* SqlClient.SqlClient;
                    yield* sql`PRAGMA busy_timeout = 0`;
                    yield* sql`BEGIN EXCLUSIVE`;
                    yield* sql`COMMIT`;
                  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: legacy })));
                  // Create sidecars after the probe closes so only Doctor can remove them.
                  yield* fs.writeFileString(`${legacy}-wal`, "leftover WAL");
                  yield* fs.writeFileString(`${legacy}-shm`, "leftover SHM");
                }
                yield* fs.remove(target, options);
              }),
          }),
        );
        assert.isFalse(yield* fs.exists(legacy));
        assert.isFalse(yield* fs.exists(`${legacy}-wal`));
        assert.isFalse(yield* fs.exists(`${legacy}-shm`));
        assert.isTrue(yield* fs.exists(dbPath));
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(yield* sql`SELECT value FROM retained_data`, [{ value: "keep" }]);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        assert.isNull((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes);
      }).pipe(Effect.scoped),
    );

    it.effect("compacts a pre-113 database offline only once its server has stopped", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-compact-" });
        const dbPath = path.join(baseDir, "statev2.sqlite");
        const migrationHead = 112;
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA journal_mode = WAL`;
          yield* runMigrations({ toMigrationInclusive: migrationHead });
          const projections = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
          yield* projections.rebuild;
          yield* sql`PRAGMA auto_vacuum = NONE`;
          yield* sql`VACUUM`;
          yield* sql`CREATE TABLE retained_data (value TEXT)`;
          yield* sql`INSERT INTO retained_data VALUES ('keep')`;
          yield* sql`CREATE TABLE discarded_data (value BLOB)`;
          yield* sql`INSERT INTO discarded_data VALUES (zeroblob(4194304))`;
          yield* sql`DROP TABLE discarded_data`;
          yield* sql`
            INSERT INTO orchestration_v2_projection_messages (
              message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
            )
            VALUES (
              'message-1', 'thread-1', NULL, NULL, 'user', 0,
              '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '{"text":"needle"}'
            )
          `;
          // An index that drifted from its rows, as a renumbering VACUUM would leave it.
          yield* sql`
            INSERT INTO orchestration_v2_message_search (orchestration_v2_message_search)
            VALUES ('delete-all')
          `;
          yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
          yield* sql`INSERT INTO orchestration_v2_legacy_imports (
            thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count
          ) VALUES ('imported', '2026-10-17', '2026-10-17', '2026-10-17', 0)`;
          yield* sql`WITH RECURSIVE history(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 51
          ) INSERT INTO orchestration_command_receipts (
            command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type
          ) SELECT 'legacy-' || n, 'thread', 'imported', '2026-10-17', 0, 'accepted', 'legacy' FROM history`;
        }).pipe(
          Effect.provide(
            ProjectionMaintenance.layer.pipe(
              Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
              Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath })),
            ),
          ),
        );

        const sizeBefore = (yield* fs.stat(dbPath)).size;
        const refused = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`SELECT value FROM retained_data`;
          const failure = yield* maintenance
            .compact(dbPath, { toolOutputAfterDays: 7 })
            .pipe(Effect.flip);
          assert.deepEqual(
            yield* sql`SELECT MAX(migration_id) AS head FROM effect_sql_migrations`,
            [{ head: migrationHead }],
          );
          return failure;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        assert.equal(refused._tag, "DatabaseInUseError");
        assert.equal((yield* fs.stat(dbPath)).size, sizeBefore);

        const clock = yield* Clock.Clock;
        const pauses: number[] = [];
        let activeNanos = 0n;
        const result = yield* maintenance.compact(dbPath, { toolOutputAfterDays: 7 }).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            // Exceed the background budget whenever the compactor checks elapsed time.
            monotonicTimeNanos: Effect.sync(() => (activeNanos += 30_000_000n)),
            sleep: (duration) =>
              Effect.sync(() => {
                pauses.push(Duration.toMillis(duration));
              }),
          }),
        );
        assert.deepEqual(pauses, [], "offline doctor must not throttle compaction");
        assert.equal(result.deletedReceiptCount, 51);
        assert.isBelow(result.afterBytes, result.beforeBytes - 3 * 1024 * 1024);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(
            yield* sql`SELECT MAX(migration_id) AS head FROM effect_sql_migrations`,
            [{ head: migrationHead }],
          );
          assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
          assert.deepEqual(yield* sql`SELECT value FROM retained_data`, [{ value: "keep" }]);
          assert.deepEqual(
            yield* sql`
              SELECT messages.message_id AS "messageId"
              FROM orchestration_v2_message_search AS search
              INNER JOIN orchestration_v2_projection_messages AS messages
                ON messages.rowid = search.rowid
              WHERE orchestration_v2_message_search MATCH '"needle"'
            `,
            [{ messageId: "message-1" }],
          );
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
      }).pipe(Effect.scoped),
    );

    it.effect("removes expired tool output before VACUUM and keeps newer output", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-compact-output-" });
        const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
        const idle = archivedChatWithOutput(
          "idle",
          DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
        );
        const recent = archivedChatWithOutput(
          "recent",
          DateTime.makeUnsafe("2026-11-10T00:00:00.000Z"),
        );
        yield* Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2;
          yield* sink.write({ events: [...idle.events, ...recent.events] });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
        }).pipe(
          Effect.provide(
            EventSink.layer.pipe(
              Layer.provideMerge(Layer.mergeAll(EventStore.layer, ProjectionStore.layer)),
              Layer.provideMerge(Sqlite.layerFromPath(dbPath)),
            ),
          ),
        );

        // Seven days before now falls between the two chats' last activity.
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-13T00:00:00.000Z")),
        );
        const result = yield* maintenance.compact(dbPath, { toolOutputAfterDays: 7 });

        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(
            yield* sql`SELECT compacted_through_sequence FROM orchestration_v2_event_store_compaction`,
            yield* sql`SELECT MAX(sequence) AS compacted_through_sequence FROM orchestration_events`,
          );
          assert.deepEqual(
            yield* sql`
              SELECT stream_id AS "threadId"
              FROM orchestration_events
              WHERE event_type = 'turn-item.updated'
                AND json_extract(payload_json, '$.output') IS NOT NULL
            `,
            [{ threadId: recent.threadId }],
          );
          assert.deepEqual(
            yield* sql`
              SELECT thread_id AS "threadId"
              FROM orchestration_v2_projection_turn_items
              WHERE json_extract(payload_json, '$.output') IS NOT NULL
            `,
            [{ threadId: recent.threadId }],
          );
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        // VACUUM returns the removed output's pages only when the removal runs before it.
        assert.isBelow(result.afterBytes, result.beforeBytes - COMMAND_OUTPUT_BYTES);
      }).pipe(Effect.scoped),
    );
  },
);
