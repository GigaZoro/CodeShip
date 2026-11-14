import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Unused bytes inside the b-tree pages that are still in use. Free pages are counted
 * separately; only a full VACUUM repacks these. It reads every page, so run it on a
 * reader connection, never on the thread that serves requests.
 */
export const readFragmentedBytes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly unused: number;
  }>`SELECT COALESCE(SUM(unused), 0) AS unused FROM dbstat`;
  return rows[0]?.unused ?? 0;
});
