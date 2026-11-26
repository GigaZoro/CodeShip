import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PrepaidCreditSpend from "./PrepaidCreditSpend.ts";

const paid = ProviderInstanceId.make("codex_paid");
const codex = ProviderDriverKind.make("codex");
const allowing = (spendCredits?: { readonly capCredits: number }) =>
  ({
    providerInstances: {
      [paid]: {
        driver: codex,
        ...(spendCredits === undefined ? {} : { config: { spendCredits } }),
      },
    },
  }) as Pick<ServerSettings, "providerInstances">;
const reading = (balance: string, accountKey?: string) =>
  ({
    instanceId: paid,
    usageLimits: {
      checkedAt: "2026-11-03T12:00:00.000Z",
      windows: [],
      credits: { balance, unlimited: false },
      ...(accountKey === undefined ? {} : { accountKey }),
    },
  }) as unknown as ServerProvider;

const counting = <A, E>(
  program: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* PrepaidCreditSpend.ensureCreditSpendTable(sql);
    return yield* program(sql);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));

describe("PrepaidCreditSpend ledger", () => {
  it.effect("counts another login's balance from its own first reading", () =>
    counting((sql) =>
      Effect.gen(function* () {
        const settings = allowing({ capCredits: 100 });
        for (const provider of [
          reading("50", "account-a"),
          reading("45", "account-a"),
          reading("80", "account-b"),
          reading("70", "account-b"),
        ]) {
          yield* PrepaidCreditSpend.recordCreditBalances(sql, [provider], settings);
        }
        assert.equal((yield* PrepaidCreditSpend.readCreditSpend(sql)).get(paid), 15);
      }),
    ),
  );

  it.effect("starts again from zero once the allowance is removed", () =>
    counting((sql) =>
      Effect.gen(function* () {
        const settings = allowing({ capCredits: 100 });
        yield* PrepaidCreditSpend.recordCreditBalances(sql, [reading("50")], settings);
        yield* PrepaidCreditSpend.recordCreditBalances(sql, [reading("40")], settings);
        yield* PrepaidCreditSpend.forgetUngrantedSpend(sql, allowing());
        yield* PrepaidCreditSpend.recordCreditBalances(sql, [reading("30")], allowing());
        const forgotten = (yield* PrepaidCreditSpend.readCreditSpend(sql)).get(paid);
        yield* PrepaidCreditSpend.recordCreditBalances(sql, [reading("30")], settings);
        assert.deepEqual(
          { forgotten, again: (yield* PrepaidCreditSpend.readCreditSpend(sql)).get(paid) },
          { forgotten: undefined, again: 0 },
        );
      }),
    ),
  );
});
