import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET payload_json = json_insert(payload_json, '$.notificationLevel', 'default', '$.color', NULL)
    WHERE json_valid(payload_json) AND (json_type(payload_json, '$.notificationLevel') IS NULL
       OR json_type(payload_json, '$.color') IS NULL)
  `;
});
