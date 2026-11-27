import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Durable record of usage-limit refusals that switched to another account silently without
  // emitting a visible error turn item, so routing skips the refused account until reset or lift.
  yield* sql`
    CREATE TABLE orchestration_v2_usage_limit_refusals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_instance_id TEXT NOT NULL,
      refused_at TEXT NOT NULL,
      reset_at TEXT,
      code TEXT,
      model_scope TEXT
    )
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_usage_limit_refusals_instance_idx
    ON orchestration_v2_usage_limit_refusals (provider_instance_id, refused_at)
  `;
});
