import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "./Migrations.ts";
import { legacyCodeShipMigrationNames } from "./reconcileCodeShipMigrationLedger.ts";
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
import Migration016 from "./CodeShipMigrations/016_ManualStepReviewLanguages.ts";
import Migration017 from "./CodeShipMigrations/017_PullRequestReviewGuideLanguages.ts";
import Migration018 from "./CodeShipMigrations/018_CommandRunLossEvidence.ts";
import Migration019 from "./CodeShipMigrations/019_MonitoringThreadAnalyses.ts";
import Migration020 from "./CodeShipMigrations/020_NodePayloadWithoutColumnKeys.ts";
import Migration021 from "./CodeShipMigrations/021_CommandRunProcessIdentity.ts";
import Migration022 from "./CodeShipMigrations/022_ScheduledTaskDescriptions.ts";
import Migration023 from "./CodeShipMigrations/023_TurnItemPayloadWithoutColumnKeys.ts";
import Migration024 from "./CodeShipMigrations/024_CommandRunShell.ts";
import Migration025 from "./CodeShipMigrations/025_MonitoringSettledThreadIndex.ts";
import Migration026 from "./CodeShipMigrations/026_MonitoringAnalysesWithoutProject.ts";
import Migration027 from "./CodeShipMigrations/027_MonitoringAnalysesSettleStamp.ts";
import Migration028 from "./CodeShipMigrations/028_MonitoringStoredDetailsAndRetries.ts";

import Migration029 from "./CodeShipMigrations/029_ColdThreadHistoryCompaction.ts";
import Migration030 from "./CodeShipMigrations/030_DatabaseSizeSamples.ts";
import Migration031 from "./CodeShipMigrations/031_ScheduledTaskRunReportedResult.ts";
import Migration032 from "./CodeShipMigrations/032_ThreadPreferences.ts";
import Migration033 from "./CodeShipMigrations/033_ScheduledTaskLastRunId.ts";
import Migration034 from "./CodeShipMigrations/034_UsageStopDecisions.ts";
import Migration035 from "./CodeShipMigrations/035_TurnItemMessageIndex.ts";
import Migration036 from "./CodeShipMigrations/036_IncrementalEventStoreCompaction.ts";

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
  Migration016,
  Migration017,
  Migration018,
  Migration019,
  Migration020,
  Migration021,
  Migration022,
  Migration023,
  Migration024,
  Migration025,
  Migration026,
  Migration027,
  Migration028,
  Migration029,
  Migration030,
  Migration031,
  Migration032,
  Migration033,
  Migration034,
  Migration035,
  Migration036,
] as const;

/** Reproduce the released fork history before the ledgers split, including actual schema changes. */
export const seedLegacyCodeShipDatabase = Effect.fn("seedLegacyCodeShipDatabase")(function* (
  throughId: number,
) {
  yield* runMigrations({ toMigrationInclusive: 77 });
  const sql = yield* SqlClient.SqlClient;
  for (const [index, name] of legacyCodeShipMigrationNames.entries()) {
    const id = index + 78;
    if (id > throughId) break;
    const migration = bodies[index]!;
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
