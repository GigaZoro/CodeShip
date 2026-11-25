import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { seedLegacyCodeShipDatabase } from "../codeShipMigration.testkit.ts";
import { runMigrations } from "../Migrations.ts";

const freshDatabase = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("027 removes analyses whose summary shows another settle time than their row", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // A released build recorded fork migrations up to 103 in the upstream ledger.
    yield* seedLegacyCodeShipDatabase(103);
    const settledAt = "2026-01-10T02:00:00.000Z";
    const rows = [
      ["current", JSON.stringify({ settledAt }), null],
      ["clamped", JSON.stringify({ settledAt: "2026-01-10T03:00:00.000Z" }), null],
      ["failed", null, "The chat could not be analyzed."],
      ["malformed", "{not json", null],
    ] as const;
    for (const [threadId, summaryJson, error] of rows) {
      yield* sql`
        INSERT INTO monitoring_thread_analyses
          (thread_id, settled_at, analyzer_version, analyzed_at, summary_json, error)
        VALUES (${threadId}, ${settledAt}, 4, ${settledAt}, ${summaryJson}, ${error})
      `;
    }

    yield* runMigrations();
    const kept = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM monitoring_thread_analyses ORDER BY thread_id
    `;

    assert.deepStrictEqual(
      kept.map((row) => row.thread_id),
      ["current", "failed", "malformed"],
    );
  }).pipe(Effect.provide(freshDatabase)),
);
