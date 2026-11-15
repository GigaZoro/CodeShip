import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations, codeShipMigrationManifest } from "./Migrations.ts";
import { isResumableMigration } from "./ResumableMigration.ts";
import Migration001 from "./CodeShipMigrations/001_PeerScheduledTaskSnapshots.ts";
import Migration002 from "./CodeShipMigrations/002_CompletedRunAccountIndex.ts";
import Migration003 from "./CodeShipMigrations/003_UsageLimitHoldEndIndex.ts";
import Migration004 from "./CodeShipMigrations/004_ScheduledTaskRunHistory.ts";
import Migration005 from "./CodeShipMigrations/005_SharedSettingVersions.ts";
import Migration006 from "./CodeShipMigrations/006_ManualStepReviews.ts";
import Migration007 from "./CodeShipMigrations/007_SharedSettingVersionDriver.ts";
import Migration008 from "./CodeShipMigrations/008_UsageLimitHoldLifts.ts";
import Migration009 from "./CodeShipMigrations/009_ScheduledTaskRunConditions.ts";
import Migration010 from "./CodeShipMigrations/010_UsageLimitAnsweredAttempts.ts";
import Migration011 from "./CodeShipMigrations/011_ScheduledTaskLastRunOccurrence.ts";
import Migration012 from "./CodeShipMigrations/012_ScheduledTaskRunFailoverReason.ts";
import Migration013 from "./CodeShipMigrations/013_ThreadToolOutputRetention.ts";
import Migration014 from "./CodeShipMigrations/014_CompactOrchestrationIds.ts";
import Migration015 from "./CodeShipMigrations/015_CommandRuns.ts";

const bodies = [
  Migration001,
  Migration002,
  Migration003,
  Migration004,
  Migration005,
  Migration006,
  Migration007,
  Migration008,
  Migration009,
  Migration010,
  Migration011,
  Migration012,
  Migration013,
  Migration014,
  Migration015,
] as const;

/** Reproduce the released fork history before the ledgers split, including actual schema changes. */
export const seedLegacyCodeShipDatabase = Effect.fn("seedLegacyCodeShipDatabase")(function* (
  throughId: number,
) {
  yield* runMigrations({ toMigrationInclusive: 77 });
  const sql = yield* SqlClient.SqlClient;
  for (const [forkId, name] of codeShipMigrationManifest) {
    const id = forkId + 77;
    if (id > throughId) break;
    const migration = bodies[forkId - 1]!;
    if (isResumableMigration(migration)) {
      let cursor: string | undefined;
      do {
        const step = yield* sql.withTransaction(migration.step(cursor));
        cursor = step.next;
      } while (cursor !== undefined);
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
    } else {
      yield* Migrator.make({})({ loader: Migrator.fromRecord({ [`${id}_${name}`]: migration }) });
    }
  }
});
