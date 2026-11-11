import * as Context from "effect/Context";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { ManualStepReview } from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type ManualStepReviewRepositoryError,
} from "./Errors.ts";

/** Reviews are only useful while their step is on a pending list; older rows are dropped on write. */
const RETENTION_DAYS = 30;

const ReviewRow = Schema.Struct({
  review: Schema.fromJsonString(ManualStepReview),
});

export class ManualStepReviewRepository extends Context.Service<
  ManualStepReviewRepository,
  {
    readonly get: (
      threadId: string,
    ) => Effect.Effect<Option.Option<ManualStepReview>, ManualStepReviewRepositoryError>;
    readonly put: (
      review: ManualStepReview,
    ) => Effect.Effect<void, ManualStepReviewRepositoryError>;
  }
>()("t3/persistence/ManualStepReviews/ManualStepReviewRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findReview = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ReviewRow,
    execute: (threadId) =>
      sql`
        SELECT review_json AS "review"
        FROM manual_step_reviews
        WHERE thread_id = ${threadId}
      `,
  });
  const encodeReview = Schema.encodeEffect(Schema.fromJsonString(ManualStepReview));

  return ManualStepReviewRepository.of({
    get: Effect.fn("ManualStepReviewRepository.get")(function (threadId) {
      return findReview(threadId).pipe(
        NodeSqliteClient.readOnly,
        Effect.map(Option.map((row) => row.review)),
        Effect.mapError((cause) =>
          Schema.isSchemaError(cause)
            ? PersistenceDecodeError.fromSchemaError("ManualStepReview", cause)
            : new PersistenceSqlError({ operation: "getManualStepReview", cause }),
        ),
      );
    }),
    put: Effect.fn("ManualStepReviewRepository.put")(function (review) {
      return encodeReview(review).pipe(
        Effect.mapError((cause) =>
          PersistenceDecodeError.fromSchemaError("ManualStepReview", cause),
        ),
        Effect.flatMap((reviewJson) =>
          sql`
            INSERT INTO manual_step_reviews (thread_id, generated_at, review_json)
            VALUES (${review.threadId}, ${review.generatedAt}, ${reviewJson})
            ON CONFLICT (thread_id) DO UPDATE SET
              generated_at = excluded.generated_at,
              review_json = excluded.review_json
          `.pipe(
            Effect.andThen(
              sql`
                DELETE FROM manual_step_reviews
                WHERE generated_at < strftime('%Y-%m-%dT%H:%M:%fZ', ${review.generatedAt}, ${`-${RETENTION_DAYS} days`})
              `,
            ),
            Effect.mapError(
              (cause) => new PersistenceSqlError({ operation: "putManualStepReview", cause }),
            ),
          ),
        ),
        Effect.asVoid,
      );
    }),
  });
});

export const layer = Layer.effect(ManualStepReviewRepository, make);
