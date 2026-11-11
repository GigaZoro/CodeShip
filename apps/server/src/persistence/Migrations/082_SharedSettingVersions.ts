import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The last version this machine knows for each setting it shares with the user's other machines.
  // The values live here, not in settings.json, so the settings file stays what the user wrote.
  yield* sql`
    CREATE TABLE IF NOT EXISTS shared_setting_versions (
      setting_key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      origin TEXT NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0
    )
  `;
});
