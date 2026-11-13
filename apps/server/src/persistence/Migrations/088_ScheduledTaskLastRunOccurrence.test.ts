import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("088_ScheduledTaskLastRunOccurrence", (it) => {
  it.effect("copies the last run's occurrence from its record and leaves a lost one unknown", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 87 });
      const task = (taskId: string, lastRunAt: string | null) =>
        sql`INSERT INTO scheduled_tasks ${sql.insert({
          task_id: taskId,
          title: "task",
          prompt: "Run",
          enabled: 1,
          schedule_json: '{"type":"interval","everyMs":3600000}',
          project_id: "project",
          thread_id: null,
          workspace_strategy_json: '{"type":"root"}',
          model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
          runtime_mode: "full-access",
          interaction_mode: "default",
          created_by: "user",
          creation_source: "web",
          created_at: "2026-11-01T00:00:00.000Z",
          updated_at: "2026-11-01T00:00:00.000Z",
          next_run_at: null,
          last_run_at: lastRunAt,
          last_run_status: lastRunAt === null ? "never" : "succeeded",
          last_run_error: null,
          run_count: lastRunAt === null ? 0 : 1,
        })}`;
      const run = (taskId: string, trigger: string, scheduledFor: string | null, outcome: string) =>
        sql`INSERT INTO scheduled_task_runs ${sql.insert({
          run_id: `${taskId}:${trigger}:${outcome}`,
          task_id: taskId,
          trigger,
          scheduled_for: scheduledFor,
          started_at: "2026-11-10T02:04:00.000Z",
          outcome,
        })}`;
      yield* task("late", "2026-11-10T02:04:00.000Z");
      yield* run("late", "catch_up", "2026-11-10T01:00:00.000Z", "succeeded");
      yield* run("late", "scheduled", "2026-11-10T02:00:00.000Z", "skipped");
      yield* task("by-hand", "2026-11-10T02:04:00.000Z");
      yield* run("by-hand", "manual", null, "succeeded");
      yield* task("pruned", "2026-11-10T02:04:00.000Z");
      yield* task("never", null);

      yield* runMigrations({ toMigrationInclusive: 88 });

      assert.deepEqual(
        yield* sql`SELECT task_id, last_run_trigger, last_run_scheduled_for
          FROM scheduled_tasks ORDER BY task_id`,
        [
          { task_id: "by-hand", last_run_trigger: "manual", last_run_scheduled_for: null },
          {
            task_id: "late",
            last_run_trigger: "catch_up",
            last_run_scheduled_for: "2026-11-10T01:00:00.000Z",
          },
          { task_id: "never", last_run_trigger: null, last_run_scheduled_for: null },
          { task_id: "pruned", last_run_trigger: null, last_run_scheduled_for: null },
        ],
      );
    }),
  );
});
