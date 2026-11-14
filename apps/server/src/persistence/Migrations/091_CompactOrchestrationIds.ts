import { compactLegacyId, compactLegacyIdsInJson } from "@t3tools/provider-core/server/compactId";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ResumableMigration from "../ResumableMigration.ts";

const ROWS_PER_QUERY = 100;
// Bounds one step's main-thread work to well under a second, so the server answers between steps.
const TEXT_PER_STEP = 1024 * 1024;

const Cursor = Schema.Struct({ table: Schema.String, rowid: Schema.Number });
type Cursor = typeof Cursor.Type;

type Row = Record<string, unknown> & { readonly rid: number };

const tableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name GLOB 'orchestration_*'
      AND name NOT GLOB '*_search*'
    ORDER BY name
  `;
  return tables.map((table) => table.name);
});

const maxRowid = Effect.fn("CompactOrchestrationIds.maxRowid")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql.unsafe<{ readonly max: number | null }>(
    `SELECT max(rowid) AS max FROM "${table}"`,
  );
  return rows[0]?.max ?? 0;
});

const progressAt = Effect.fn("CompactOrchestrationIds.progressAt")(function* (
  tables: ReadonlyArray<string>,
  cursor: Cursor | undefined,
) {
  if (cursor === undefined) return 1;
  const sizes = yield* Effect.forEach(tables, (table) => maxRowid(table));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total === 0) return 1;
  const done = tables.reduce(
    (sum, table, index) =>
      table < cursor.table
        ? sum + sizes[index]!
        : table === cursor.table
          ? sum + Math.min(cursor.rowid, sizes[index]!)
          : sum,
    0,
  );
  return done / total;
});

// Rewrites the ids `encodeIdPart` now produces, in every orchestration table and every JSON
// payload, so rows written before it match what the server derives and stop carrying the
// multiplied escapes. A row changes only when one of its values does, and a row done twice stays
// the same, since compacting is idempotent.
export default ResumableMigration.make({
  cursor: Cursor,
  start: { table: "", rowid: 0 },
  step: Effect.fn("CompactOrchestrationIds.step")(function* (cursor: Cursor) {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* tableNames;
    const index = tables.findIndex((name) => name >= cursor.table);
    if (index === -1) return { next: undefined, progress: 1 };
    const table = tables[index]!;
    const afterTable: Cursor | undefined =
      index + 1 < tables.length ? { table: tables[index + 1]!, rowid: 0 } : undefined;
    let lastRowid = table === cursor.table ? cursor.rowid : 0;

    const columns = (yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info(${table}) WHERE type = 'TEXT'
      `).map((column) => column.name);
    const compactValue = (column: string, value: string) =>
      column.endsWith("_json") ? compactLegacyIdsInJson(value) : compactLegacyId(value);
    const selectList = columns.map((column) => `"${column}"`).join(", ");

    let next: Cursor | undefined = afterTable;
    let text = 0;
    while (columns.length > 0) {
      const rows = yield* sql.unsafe<Row>(
        `SELECT rowid AS rid, ${selectList} FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ${ROWS_PER_QUERY}`,
        [lastRowid],
      );
      for (const row of rows) {
        const changed = columns.flatMap((column) => {
          const value = row[column];
          if (typeof value !== "string") return [];
          text += value.length;
          const compacted = compactValue(column, value);
          return compacted === value ? [] : [[column, compacted] as const];
        });
        if (changed.length === 0) continue;
        yield* sql.unsafe(
          `UPDATE "${table}" SET ${changed.map(([column]) => `"${column}" = ?`).join(", ")} WHERE rowid = ?`,
          [...changed.map(([, compacted]) => compacted), row.rid],
        );
      }
      if (rows.length < ROWS_PER_QUERY) break;
      lastRowid = rows[rows.length - 1]!.rid;
      if (text >= TEXT_PER_STEP) {
        next = { table, rowid: lastRowid };
        break;
      }
    }
    return { next, progress: yield* progressAt(tables, next) };
  }),
});
