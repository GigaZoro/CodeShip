import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A one-shot call (title, branch name, commit message...) has no run to carry its usage, so it
// keeps its own row. Null counts are unknown, never zero; a null demand is unattributed.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE text_generation_usage (
      usage_id INTEGER PRIMARY KEY,
      driver TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      model TEXT,
      thread_id TEXT,
      demand_id TEXT,
      input_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      output_tokens INTEGER,
      outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'interrupted')),
      error_detail TEXT,
      occurred_at TEXT NOT NULL
    )
  `;
});
