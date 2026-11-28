import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS api_credit_balances (
      instance_id TEXT PRIMARY KEY,
      linked_plan_instance_id TEXT NOT NULL,
      grant_usd REAL NOT NULL CHECK (grant_usd > 0),
      cycle_anchor TEXT NOT NULL,
      cycle_start TEXT NOT NULL,
      cycle_end TEXT NOT NULL,
      balance_state TEXT NOT NULL CHECK (balance_state IN ('available', 'exhausted')),
      checked_at TEXT NOT NULL,
      metering_started_at TEXT NOT NULL,
      exhausted_at TEXT,
      reason TEXT,
      check_spend_usd REAL NOT NULL DEFAULT 0 CHECK (check_spend_usd >= 0),
      unpriced_checks INTEGER NOT NULL DEFAULT 0
    )
  `;
});
