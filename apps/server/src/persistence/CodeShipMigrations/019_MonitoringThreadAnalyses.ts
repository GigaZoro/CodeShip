import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per settled chat. `summary_json` is null when the analysis failed, and `error` says why,
  // so the chat is not analyzed again until it settles again or the analyzer changes.
  yield* sql`
    CREATE TABLE monitoring_thread_analyses (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      settled_at TEXT NOT NULL,
      analyzer_version INTEGER NOT NULL,
      analyzed_at TEXT NOT NULL,
      summary_json TEXT,
      error TEXT
    )
  `;
  yield* sql`CREATE INDEX monitoring_thread_analyses_settled_at ON monitoring_thread_analyses (settled_at)`;
});
