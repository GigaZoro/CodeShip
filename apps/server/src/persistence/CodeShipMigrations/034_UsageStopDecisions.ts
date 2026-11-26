import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE usage_stop_decisions (
    decision_key TEXT NOT NULL UNIQUE, source_key TEXT NOT NULL, request_key TEXT,
    selected_key TEXT, snapshot TEXT NOT NULL, observed_ms INTEGER NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'planned', attempt_sequence INTEGER
  )`;
  yield* sql`CREATE INDEX usage_stop_source ON usage_stop_decisions(source_key)`;
  yield* sql`CREATE INDEX usage_stop_request ON usage_stop_decisions(request_key) WHERE request_key IS NOT NULL`;
  yield* sql`CREATE TRIGGER bound_usage_stop_decisions AFTER INSERT ON usage_stop_decisions
    BEGIN DELETE FROM usage_stop_decisions WHERE rowid <= NEW.rowid - 16384; END`;
});
