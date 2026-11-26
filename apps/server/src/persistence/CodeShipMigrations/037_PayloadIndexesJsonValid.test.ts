import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

const AT = "2026-11-15T00:00:00.000Z";
const BROKEN = "{broken";

layer("037_PayloadIndexesJsonValid", (it) => {
  // A new database runs the unguarded migrations 3, 10 and 13 before this one.
  it.effect("keeps a malformed payload writable in every table the fork indexes by payload", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      // A new index that extracts JSON without json_valid lands here; guard it instead.
      const unguarded = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND sql LIKE '%json_extract%' AND sql NOT LIKE '%json_valid%'
        ORDER BY name
      `;
      assert.deepStrictEqual(
        unguarded.map((row) => row.name),
        [
          // Upstream migrations 84 and 65.
          "orchestration_v2_projection_runs_last_executed_idx",
          "orchestration_v2_provider_turns_codex_native_id_idx",
        ],
      );

      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, payload_json
        )
        VALUES ('thread-1', 'project-1', 'Broken', 'codex', 'full-access', 'default', ${AT}, ${AT}, ${BROKEN})
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
        )
        VALUES ('item-1', 'thread-1', 'run-1', 1, 'error', 'failed', ${AT}, ${BROKEN})
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_run_attempts (
          attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
          provider_thread_id, provider_instance_id, status, payload_json
        )
        VALUES (
          'attempt-1', 'thread-1', 'run-1', 1, 'node-1', 'codex', 'provider-thread-1', 'codex',
          'running', ${BROKEN}
        )
      `;
      // Upstream's codex native-turn index (migration 65) still extracts without json_valid.
      yield* sql`DROP INDEX orchestration_v2_provider_turns_codex_native_id_idx`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_turns (
          provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal,
          status, payload_json
        )
        VALUES (
          'provider-turn-1', 'thread-1', 'provider-thread-1', 'node-1', 'attempt-1', 1,
          'running', ${BROKEN}
        )
      `;

      const rows = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads
        UNION ALL SELECT payload_json FROM orchestration_v2_projection_turn_items
        UNION ALL SELECT payload_json FROM orchestration_v2_projection_run_attempts
        UNION ALL SELECT payload_json FROM orchestration_v2_projection_provider_turns
      `;
      assert.deepStrictEqual(
        rows.map((row) => row.payload_json),
        [BROKEN, BROKEN, BROKEN, BROKEN],
      );
    }),
  );
});
