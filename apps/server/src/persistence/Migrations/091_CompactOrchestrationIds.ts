import { compactLegacyId, compactLegacyIdsInJson } from "@t3tools/provider-core/server/compactId";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const BATCH_SIZE = 2000;

type Row = Record<string, unknown> & { readonly rid: number };

// Rewrites the ids `encodeIdPart` now produces, in every orchestration table and every JSON
// payload, so rows written before it match what the server derives and stop carrying the
// multiplied escapes. A row changes only when one of its values does.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name GLOB 'orchestration_*'
      AND name NOT GLOB '*_search*'
  `;

  for (const { name: table } of tables) {
    const columns = (yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info(${table}) WHERE type = 'TEXT'
    `).map((column) => column.name);
    if (columns.length === 0) continue;

    const compactValue = (column: string, value: string) =>
      column.endsWith("_json") ? compactLegacyIdsInJson(value) : compactLegacyId(value);
    const selectList = columns.map((column) => `"${column}"`).join(", ");
    let lastRowid = 0;
    for (;;) {
      const rows = yield* sql.unsafe<Row>(
        `SELECT rowid AS rid, ${selectList} FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ${BATCH_SIZE}`,
        [lastRowid],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        const changed = columns.flatMap((column) => {
          const value = row[column];
          if (typeof value !== "string") return [];
          const next = compactValue(column, value);
          return next === value ? [] : [[column, next] as const];
        });
        if (changed.length === 0) continue;
        yield* sql.unsafe(
          `UPDATE "${table}" SET ${changed.map(([column]) => `"${column}" = ?`).join(", ")} WHERE rowid = ?`,
          [...changed.map(([, next]) => next), row.rid],
        );
      }
      lastRowid = rows[rows.length - 1]!.rid;
    }
  }
});
