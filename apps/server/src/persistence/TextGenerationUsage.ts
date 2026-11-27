import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { PersistenceSqlError } from "./Errors.ts";

export interface TextGenerationUsageRow {
  readonly driver: string;
  readonly providerInstanceId: string;
  readonly operation: string;
  readonly model: string | null;
  readonly threadId: string | null;
  readonly demandId: string | null;
  readonly inputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly errorDetail: string | null;
  readonly occurredAt: string;
}

export class TextGenerationUsageRepository extends Context.Service<
  TextGenerationUsageRepository,
  {
    readonly record: (
      rows: ReadonlyArray<TextGenerationUsageRow>,
    ) => Effect.Effect<void, PersistenceSqlError>;
  }
>()("t3/persistence/TextGenerationUsage/TextGenerationUsageRepository") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return TextGenerationUsageRepository.of({
    record: Effect.fn("TextGenerationUsageRepository.record")(function (rows) {
      return sql
        .withTransaction(
          Effect.forEach(
            rows,
            (row) => sql`
              INSERT INTO text_generation_usage (
                driver, provider_instance_id, operation, model, thread_id, demand_id,
                input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                outcome, error_detail, occurred_at
              ) VALUES (
                ${row.driver}, ${row.providerInstanceId}, ${row.operation}, ${row.model},
                ${row.threadId}, ${row.demandId}, ${row.inputTokens}, ${row.cacheReadTokens},
                ${row.cacheWriteTokens}, ${row.outputTokens}, ${row.outcome}, ${row.errorDetail},
                ${row.occurredAt}
              )
            `,
            { discard: true },
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) => new PersistenceSqlError({ operation: "recordTextGenerationUsage", cause }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(TextGenerationUsageRepository, make);
