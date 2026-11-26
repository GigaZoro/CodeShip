import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { seedLegacyCodeShipDatabase } from "../codeShipMigration.testkit.ts";
import { runMigrations } from "../Migrations.ts";

const freshDatabase = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("110 names each task's run by the run that started at its last run time", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedLegacyCodeShipDatabase(109);
    const task = (id: string, lastRunAt: string | null, status: string) => sql`
      INSERT INTO scheduled_tasks (
        task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
        model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
        created_at, updated_at, last_run_at, last_run_status, run_count
      ) VALUES (
        ${id}, ${id}, 'Check', 1, '{"type":"manual"}', 'project', '{"type":"root"}', '{}',
        'full-access', 'default', 'user', 'web', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', ${lastRunAt}, ${status}, 0
      )
    `;
    const run = (runId: string, taskId: string, startedAt: string, outcome: string) => sql`
      INSERT INTO scheduled_task_runs (run_id, task_id, trigger, started_at, outcome)
      VALUES (${runId}, ${taskId}, 'manual', ${startedAt}, ${outcome})
    `;
    const earlier = "2026-01-10T06:00:00.000Z";
    const latest = "2026-01-10T07:00:00.000Z";
    // A run an update restart cut is still running; the task names it as it would any other.
    yield* task("cut", latest, "running");
    yield* run("cut:earlier", "cut", earlier, "succeeded");
    yield* run("cut:latest", "cut", latest, "running");
    yield* task("settled", latest, "succeeded");
    yield* run("settled:latest", "settled", latest, "succeeded");
    // History pruned the run, or the task never ran: nothing to name.
    yield* task("pruned", latest, "failed");
    yield* run("pruned:earlier", "pruned", earlier, "failed");
    yield* task("never", null, "never");

    yield* runMigrations();
    const named = yield* sql<{ readonly task_id: string; readonly last_run_id: string | null }>`
      SELECT task_id, last_run_id FROM scheduled_tasks ORDER BY task_id
    `;

    assert.deepStrictEqual(named, [
      { task_id: "cut", last_run_id: "cut:latest" },
      { task_id: "never", last_run_id: null },
      { task_id: "pruned", last_run_id: null },
      { task_id: "settled", last_run_id: "settled:latest" },
    ]);
  }).pipe(Effect.provide(freshDatabase)),
);
