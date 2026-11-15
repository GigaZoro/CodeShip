import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

/** Fork migrations that released builds recorded in the upstream ledger, at ids 78 and up. */
export const legacyCodeShipMigrationNames = [
  "PeerScheduledTaskSnapshots",
  "CompletedRunAccountIndex",
  "UsageLimitHoldEndIndex",
  "ScheduledTaskRunHistory",
  "SharedSettingVersions",
  "ManualStepReviews",
  "SharedSettingVersionDriver",
  "UsageLimitHoldLifts",
  "ScheduledTaskRunConditions",
  "UsageLimitAnsweredAttempts",
  "ScheduledTaskLastRunOccurrence",
  "ScheduledTaskRunFailoverReason",
  "ThreadToolOutputRetention",
  "CompactOrchestrationIds",
  "CommandRuns",
  "ManualStepReviewLanguages",
  "PullRequestReviewGuideLanguages",
] as const;

type MigrationRow = { readonly id: number; readonly name: string };

/** Only exact released fork pairs move; an upstream migration at the same id stays upstream. */
export function reconciledCodeShipMigrationHistory<Row extends MigrationRow>(
  upstream: ReadonlyArray<Row>,
  fork: ReadonlyArray<Row>,
) {
  const moved = upstream.filter(({ id, name }) => legacyCodeShipMigrationNames[id - 78] === name);
  const movedIds = new Set(moved.map(({ id }) => id));
  const byId = new Map(fork.map((row) => [row.id, row]));
  const conflicts: string[] = [];
  for (const row of moved) {
    const id = row.id - 77;
    const existing = byId.get(id);
    if (existing !== undefined && existing.name !== row.name) {
      conflicts.push(`${id}_${row.name} (recorded: ${existing.name})`);
    } else {
      byId.set(id, { ...row, id });
    }
  }
  return {
    upstream: upstream.filter(({ id }) => !movedIds.has(id)),
    fork: [...byId.values()].sort((a, b) => a.id - b.id),
    moved,
    conflicts,
  };
}

export const reconcileCodeShipMigrationLedger = Effect.fn("reconcileCodeShipMigrationLedger")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = new Set(
          (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN ('effect_sql_migrations', 'codeship_migrations', 'migration_progress', 'codeship_migration_progress')
    `).map(({ name }) => name),
        );
        if (!tables.has("effect_sql_migrations")) return [];
        type Row = MigrationRow & { readonly created_at: string };
        const upstream =
          yield* sql<Row>`SELECT migration_id AS id, name, created_at FROM effect_sql_migrations`;
        const fork = tables.has("codeship_migrations")
          ? yield* sql<Row>`SELECT migration_id AS id, name, created_at FROM codeship_migrations`
          : [];
        const reconciled = reconciledCodeShipMigrationHistory(upstream, fork);
        if (reconciled.conflicts.length > 0)
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: `Conflicting CodeShip migration history: ${reconciled.conflicts.join(", ")}`,
          });
        if (reconciled.moved.length > 0) {
          yield* sql`CREATE TABLE IF NOT EXISTS codeship_migrations (
        migration_id INTEGER PRIMARY KEY NOT NULL,
        created_at datetime NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL
      )`;
          for (const row of reconciled.moved) {
            yield* sql`INSERT INTO codeship_migrations (migration_id, name, created_at)
          VALUES (${row.id - 77}, ${row.name}, ${row.created_at})
          ON CONFLICT (migration_id) DO UPDATE SET created_at = excluded.created_at`;
            yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${row.id} AND name = ${row.name}`;
          }
        }
        // The old cursor belongs to compaction only if neither completed migration occupied id 91.
        if (tables.has("migration_progress") && !upstream.some(({ id }) => id === 91)) {
          const cursors = yield* sql<{ readonly cursor_json: string }>`
        SELECT cursor_json FROM migration_progress WHERE migration_id = 91
      `;
          const cursor = cursors[0];
          if (cursor !== undefined) {
            yield* sql`CREATE TABLE IF NOT EXISTS codeship_migration_progress (
          migration_id INTEGER PRIMARY KEY NOT NULL, cursor_json TEXT NOT NULL
        )`;
            const existing = yield* sql<{ readonly cursor_json: string }>`
          SELECT cursor_json FROM codeship_migration_progress WHERE migration_id = 14
        `;
            if (existing[0] !== undefined && existing[0].cursor_json !== cursor.cursor_json) {
              return yield* new Migrator.MigrationError({
                kind: "BadState",
                message: "Conflicting CodeShip compaction cursors.",
              });
            }
            yield* sql`INSERT INTO codeship_migration_progress (migration_id, cursor_json)
          VALUES (14, ${cursor.cursor_json}) ON CONFLICT (migration_id) DO NOTHING`;
            yield* sql`DELETE FROM migration_progress WHERE migration_id = 91`;
          }
          if ((yield* sql`SELECT 1 FROM migration_progress LIMIT 1`).length === 0) {
            yield* sql`DROP TABLE migration_progress`;
          }
        }
        return reconciled.moved;
      }),
    );
  },
);
