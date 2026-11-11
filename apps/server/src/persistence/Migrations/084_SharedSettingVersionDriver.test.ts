import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

const columnsOf = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(shared_setting_versions)`;
  return columns.map((column) => column.name);
});

layer("084_SharedSettingVersionDriver", (it) => {
  it.effect("adds the driver column to the table released with 082 and keeps its rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 83 });
      yield* sql`
        INSERT INTO shared_setting_versions (setting_key, kind, value_json, updated_at, origin)
        VALUES ('chatWidth', 'shared', '"wide"', '2026-11-11T10:00:00.000Z', 'mac')
      `;
      yield* runMigrations();
      assert.include(yield* columnsOf, "instance_driver");
      const rows = yield* sql<{ readonly kind: string; readonly value_json: string }>`
        SELECT kind, value_json FROM shared_setting_versions WHERE setting_key = 'chatWidth'
      `;
      assert.deepStrictEqual(rows, [{ kind: "shared", value_json: '"wide"' }]);
    }),
  );
});

it.effect("rebuilds the development shape of 082 that keyed rows by setting alone", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 81 });
    yield* sql`
      CREATE TABLE shared_setting_versions (
        setting_key TEXT PRIMARY KEY,
        value_json TEXT,
        updated_at TEXT NOT NULL,
        origin TEXT NOT NULL,
        pending INTEGER NOT NULL DEFAULT 0
      )
    `;
    yield* sql`
      INSERT INTO shared_setting_versions (setting_key, value_json, updated_at, origin)
      VALUES ('chatWidth', '"wide"', '2026-11-11T10:00:00.000Z', 'mac')
    `;
    yield* runMigrations();
    const columns = yield* columnsOf;
    assert.includeMembers(columns, ["kind", "instance_driver"]);
    const rows = yield* sql<{ readonly kind: string; readonly value_json: string }>`
      SELECT kind, value_json FROM shared_setting_versions
    `;
    assert.deepStrictEqual(rows, [{ kind: "shared", value_json: '"wide"' }]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
