import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(shared_setting_versions)
  `;
  const names = new Set(columns.map((column) => column.name));

  // A development build of 082 keyed rows by setting alone; every such row was a shared version.
  if (!names.has("kind")) {
    yield* sql`
      CREATE TABLE shared_setting_versions_next (
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
    yield* sql`
      INSERT INTO shared_setting_versions_next
        (setting_key, kind, value_json, updated_at, origin, pending)
      SELECT setting_key, 'shared', value_json, updated_at, origin, pending
      FROM shared_setting_versions
    `;
    yield* sql`DROP TABLE shared_setting_versions`;
    yield* sql`ALTER TABLE shared_setting_versions_next RENAME TO shared_setting_versions`;
    return;
  }

  // The driver a shared model selection's instance ran on its origin, so a follower can hold it
  // while its own instance of that id runs another driver.
  if (!names.has("instance_driver")) {
    yield* sql`
      ALTER TABLE shared_setting_versions
      ADD COLUMN instance_driver TEXT
    `;
  }
});
