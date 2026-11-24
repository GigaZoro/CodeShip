import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect(
  "defaults old thread preferences without overwriting stored preferences or activity",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 108 });
      yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES
        ('old', 'project', 'Old', 'codex', 'full-access', 'default', 'created', 'updated', '{"tags":["keep"]}'),
        ('partial', 'project', 'Partial', 'codex', 'full-access', 'default', 'created', 'updated', '{"notificationLevel":"muted"}'),
        ('configured', 'project', 'Configured', 'codex', 'full-access', 'default', 'created', 'updated', '{"notificationLevel":"following","color":"red"}')
    `;
      yield* runMigrations({ toMigrationInclusive: 109 });
      const rows = yield* sql<{ readonly payload_json: string; readonly updated_at: string }>`
      SELECT payload_json, updated_at FROM orchestration_v2_projection_threads ORDER BY thread_id
    `;
      assert.deepStrictEqual(
        rows.map((row) => JSON.parse(row.payload_json)),
        [
          { notificationLevel: "following", color: "red" },
          { tags: ["keep"], notificationLevel: "default", color: null },
          { notificationLevel: "muted", color: null },
        ],
      );
      assert.isTrue(rows.every((row) => row.updated_at === "updated"));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
