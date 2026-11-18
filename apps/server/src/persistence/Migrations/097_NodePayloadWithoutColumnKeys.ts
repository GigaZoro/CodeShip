import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ResumableMigration from "../ResumableMigration.ts";

const ROWS_PER_STEP = 500;

// The keys the node row's own columns hold; the server puts them back on read.
const COLUMN_KEYS = [
  "id",
  "threadId",
  "runId",
  "parentNodeId",
  "rootNodeId",
  "kind",
  "status",
  "providerThreadId",
  "providerTurnId",
  "startedAt",
  "completedAt",
];
const REMOVE_PATHS = COLUMN_KEYS.map((key) => `'$.${key}'`).join(", ");

const Cursor = Schema.Struct({ rowid: Schema.Number });

// Removing a key twice changes nothing, so a step run again after a restart is harmless.
export default ResumableMigration.make({
  cursor: Cursor,
  start: { rowid: 0 },
  step: Effect.fn("NodePayloadWithoutColumnKeys.step")(function* ({ rowid }) {
    const sql = yield* SqlClient.SqlClient;
    const [stop] = yield* sql<{ readonly last: number | null; readonly max: number | null }>`
      SELECT
        (SELECT max(rowid) FROM (
          SELECT rowid FROM orchestration_v2_projection_nodes
          WHERE rowid > ${rowid} ORDER BY rowid LIMIT ${ROWS_PER_STEP}
        )) AS last,
        (SELECT max(rowid) FROM orchestration_v2_projection_nodes) AS max
    `;
    if (stop?.last == null) return { next: undefined, progress: 1 };
    yield* sql.unsafe(
      `UPDATE orchestration_v2_projection_nodes
       SET payload_json = json_remove(payload_json, ${REMOVE_PATHS})
       WHERE rowid > ? AND rowid <= ?`,
      [rowid, stop.last],
    );
    const done = stop.last >= (stop.max ?? 0);
    return {
      next: done ? undefined : { rowid: stop.last },
      progress: done ? 1 : stop.last / (stop.max ?? 1),
    };
  }),
});
