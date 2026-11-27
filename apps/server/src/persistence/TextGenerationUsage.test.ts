import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "./Sqlite.ts";
import * as TextGenerationUsage from "./TextGenerationUsage.ts";

it.effect("keeps unknown counts and an unattributed demand as null, not zero", () =>
  Effect.gen(function* () {
    const repository = yield* TextGenerationUsage.TextGenerationUsageRepository;
    yield* repository.record([
      {
        operation: "generateThreadTitle",
        providerInstanceId: "work",
        driver: "claudeAgent",
        model: "claude-haiku",
        threadId: "thread:usage",
        demandId: `demand:${"c".repeat(64)}`,
        inputTokens: 120,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        outputTokens: 8,
        outcome: "succeeded",
        errorDetail: null,
        occurredAt: "2026-11-25T23:59:59.000Z",
      },
      {
        operation: "generateCommitMessage",
        providerInstanceId: "work",
        driver: "codex",
        model: null,
        threadId: null,
        demandId: null,
        inputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        outputTokens: null,
        outcome: "failed",
        errorDetail: "Codex CLI request timed out.",
        occurredAt: "2026-11-26T00:00:01.000Z",
      },
    ]);

    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly driver: string;
      readonly operation: string;
      readonly demand_id: string | null;
      readonly input_tokens: number | null;
      readonly cache_write_tokens: number | null;
      readonly outcome: string;
      readonly error_detail: string | null;
      readonly occurred_at: string;
    }>`SELECT driver, operation, demand_id, input_tokens, cache_write_tokens, outcome, error_detail, occurred_at
       FROM text_generation_usage ORDER BY usage_id`;
    assert.deepStrictEqual(rows, [
      {
        operation: "generateThreadTitle",
        driver: "claudeAgent",
        demand_id: `demand:${"c".repeat(64)}`,
        input_tokens: 120,
        cache_write_tokens: 0,
        outcome: "succeeded",
        error_detail: null,
        occurred_at: "2026-11-25T23:59:59.000Z",
      },
      {
        operation: "generateCommitMessage",
        driver: "codex",
        demand_id: null,
        input_tokens: null,
        cache_write_tokens: null,
        outcome: "failed",
        error_detail: "Codex CLI request timed out.",
        occurred_at: "2026-11-26T00:00:01.000Z",
      },
    ]);

    const dayOne = yield* sql<{ readonly operation: string }>`
      SELECT operation FROM text_generation_usage
      WHERE occurred_at >= '2026-11-25T00:00:00.000Z' AND occurred_at < '2026-11-26T00:00:00.000Z'
      ORDER BY usage_id
    `;
    const dayTwo = yield* sql<{ readonly operation: string }>`
      SELECT operation FROM text_generation_usage
      WHERE occurred_at >= '2026-11-26T00:00:00.000Z' AND occurred_at < '2026-11-27T00:00:00.000Z'
      ORDER BY usage_id
    `;
    assert.deepStrictEqual(dayOne, [{ operation: "generateThreadTitle" }]);
    assert.deepStrictEqual(dayTwo, [{ operation: "generateCommitMessage" }]);
  }).pipe(
    Effect.provide(
      TextGenerationUsage.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    ),
  ),
);
