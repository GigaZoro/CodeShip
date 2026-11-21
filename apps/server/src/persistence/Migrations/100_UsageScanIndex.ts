import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE usage_scan_index (
      id INTEGER PRIMARY KEY,
      cache_key TEXT NOT NULL UNIQUE,
      contents TEXT NOT NULL
    )
  `;
});
