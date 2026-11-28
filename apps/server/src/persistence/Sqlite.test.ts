// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "./Sqlite.ts";

// Linux names an open, already-deleted file "<path> (deleted)" in /proc/self/fd.
// SQLite names its temp files "etilqs_*" and, without TMPDIR, puts them in
// /var/tmp while os.tmpdir() is /tmp, so match the name, not the directory.
const openDeletedTempFiles = () =>
  NodeFS.readdirSync("/proc/self/fd").flatMap((fd) => {
    try {
      const target = NodeFS.readlinkSync(`/proc/self/fd/${fd}`);
      return target.includes("/etilqs_") && target.endsWith(" (deleted)") ? [target] : [];
    } catch {
      return [];
    }
  });

it.effect.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "keeps a write transaction's statement journal off the temp directory",
  () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-temp-"));
    const persistence = SqlitePersistence.layerFromPath(
      NodePath.join(tempDir, "state.sqlite"),
    ).pipe(Layer.provide(NodeServices.layer));

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE journal_probe(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`;
      for (let id = 0; id < 64; id++) {
        yield* sql`INSERT INTO journal_probe VALUES (${id}, ${"x".repeat(4096)})`;
      }
      const before = new Set(openDeletedTempFiles());
      const opened = yield* sql.withTransaction(
        Effect.gen(function* () {
          // A multi-row update can fail halfway, so SQLite journals every page
          // it changes, here well past the 64 KiB it holds in memory by default.
          yield* sql`UPDATE journal_probe SET payload = payload || 'y'`;
          return openDeletedTempFiles().filter((target) => !before.has(target));
        }),
      );
      assert.deepEqual(opened, []);
    }).pipe(
      Effect.provide(persistence),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  },
);

it.effect("drops planner statistics a database already has", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-stats-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE walk_probe(node_id TEXT PRIMARY KEY, parent_node_id TEXT)`;
      yield* sql`INSERT INTO walk_probe VALUES ('node-1', NULL), ('node-2', 'node-1')`;
      yield* sql`ANALYZE walk_probe`;
    }).pipe(Effect.provide(persistence()));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stats = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM sqlite_stat1
      `;
      assert.equal(stats[0]?.count, 0);
      // A connection still using the old stats scans the table at each step.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        WITH RECURSIVE retained(node_id) AS (
          SELECT 'node-2'
          UNION
          SELECT parent.parent_node_id FROM walk_probe AS parent
          INNER JOIN retained ON parent.node_id = retained.node_id
        )
        SELECT node_id FROM retained
      `;
      assert.include(
        plan.map((row) => row.detail),
        "SEARCH parent USING INDEX sqlite_autoindex_walk_probe_1 (node_id=?)",
      );
    }).pipe(Effect.provide(persistence()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

const readMemorySessionPragmas = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const foreignKeys = yield* sql`PRAGMA foreign_keys`.values;
  const busyTimeout = yield* sql`PRAGMA busy_timeout`.values;
  const tempStore = yield* sql`PRAGMA temp_store`.values;
  return {
    foreignKeys: foreignKeys[0]?.[0],
    busyTimeout: busyTimeout[0]?.[0],
    tempStore: tempStore[0]?.[0],
  };
});

it.effect("applies session pragmas on layerMemory and layerMemoryFromSnapshot", () =>
  Effect.gen(function* () {
    const expected = { foreignKeys: 1, busyTimeout: 5000, tempStore: 2 };

    // First instantiation warms the cached migrated snapshot; second exercises deserialization.
    assert.deepEqual(
      yield* readMemorySessionPragmas.pipe(Effect.provide(SqlitePersistence.layerMemory)),
      expected,
    );
    assert.deepEqual(
      yield* readMemorySessionPragmas.pipe(Effect.provide(SqlitePersistence.layerMemory)),
      expected,
    );

    const seed = new NodeSqlite.DatabaseSync(":memory:");
    let snapshot: Uint8Array;
    try {
      seed.exec("CREATE TABLE seeded_rows(id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
      seed.exec("INSERT INTO seeded_rows VALUES (1, 'from-snapshot')");
      snapshot = (seed as unknown as { serialize(): Uint8Array }).serialize();
    } finally {
      seed.close();
    }

    const fromSnapshot = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const pragmas = yield* readMemorySessionPragmas;
      const rows = yield* sql<{ readonly id: number; readonly label: string }>`
        SELECT id, label FROM seeded_rows
      `;
      return { pragmas, rows };
    }).pipe(Effect.provide(SqlitePersistence.layerMemoryFromSnapshot(snapshot)));

    assert.deepEqual(fromSnapshot.pragmas, expected);
    assert.deepEqual(fromSnapshot.rows, [{ id: 1, label: "from-snapshot" }]);
  }),
);

it.effect("isolates mutations across separate layerMemory instantiations", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO shared_setting_versions (setting_key, kind, value_json, updated_at, origin, pending)
        VALUES ('theme', 'local', '"dark"', '2026-11-28T00:00:00.000Z', 'db-1', 0)
      `;
      yield* sql`CREATE TABLE db1_only(id INTEGER PRIMARY KEY)`;
      const count = yield* sql`SELECT COUNT(*) FROM shared_setting_versions`.values;
      assert.deepEqual(count, [[1]]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const count = yield* sql`SELECT COUNT(*) FROM shared_setting_versions`.values;
      assert.deepEqual(count, [[0]]);
      const leakedTables = yield* sql`
        SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'db1_only'
      `.values;
      assert.deepEqual(leakedTables, []);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory));
  }),
);
