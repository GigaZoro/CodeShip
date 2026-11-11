import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // "Try again" on an account ends the holds of every refusal recorded up to this time, so its next
  // turn runs; a refusal after it holds again.
  yield* sql`
    CREATE TABLE orchestration_v2_usage_limit_lifts (
      provider_instance_id TEXT PRIMARY KEY,
      lifted_at TEXT NOT NULL
    )
  `;
});
