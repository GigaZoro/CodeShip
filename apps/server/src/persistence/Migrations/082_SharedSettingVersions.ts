import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // What this machine knows about each setting it shares with the user's other machines, one row per
  // kind: `shared` is the version it took and passes on, `local` is when it last changed the setting
  // on its own (no value), and `deferred` is a version stamped too far ahead, kept until its time.
  // The values live here, not in settings.json, so the settings file stays what the user wrote.
  yield* sql`
    CREATE TABLE IF NOT EXISTS shared_setting_versions (
      setting_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      value_json TEXT,
      updated_at TEXT NOT NULL,
      origin TEXT NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (setting_key, kind)
    )
  `;
});
