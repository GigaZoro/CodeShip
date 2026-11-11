import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per shared setting and kind: `shared` is the version this machine passes on, as the JSON
  // it came as; `local` is when it last changed the setting on its own (no value); `deferred` is a
  // version stamped too far ahead, kept until its time. Values live here, not in settings.json, so
  // the settings file stays what the user wrote.
  yield* sql`
    CREATE TABLE IF NOT EXISTS shared_setting_versions (
      setting_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      value_json TEXT,
      instance_driver TEXT,
      updated_at TEXT NOT NULL,
      origin TEXT NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (setting_key, kind)
    )
  `;
});
