import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A `t3_command_run` command outlives the server that started it, so the next one adopts it
  // from here: its process, the folder its wrapper writes the output and exit status to, and
  // whether its end has reached the task. The row comes before the process, so `pid` is null
  // until it starts; its wrapper's pid file names it if the server stopped in between.
  yield* sql`
    CREATE TABLE command_runs (
      task_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      label TEXT,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      directory TEXT NOT NULL,
      pid INTEGER,
      process_started_at INTEGER,
      unit TEXT,
      status TEXT NOT NULL,
      exit_code INTEGER,
      started_at TEXT NOT NULL,
      deadline_at TEXT NOT NULL,
      ended_at TEXT,
      delivered_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX command_runs_undelivered ON command_runs (status) WHERE delivered_at IS NULL
  `;
});
