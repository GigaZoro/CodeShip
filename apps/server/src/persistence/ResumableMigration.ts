import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

export interface ResumableStep<Cursor> {
  /** Where the next step starts, or undefined once the migration is done. */
  readonly next: Cursor | undefined;
  /** Share of the work done after this step, 0 to 1. */
  readonly progress: number;
}

type StepError = Migrator.MigrationError | SqlError.SqlError;

// A migration too large for one transaction, such as one that rewrites every stored row. The
// runner commits each step together with its cursor, so a restart resumes after the last committed
// step and requests are answered between steps.
export class ResumableMigration {
  readonly _tag = "ResumableMigration";
  /** Runs one bounded step from a stored cursor (undefined before the first step). */
  readonly step: (
    cursorJson: string | undefined,
  ) => Effect.Effect<ResumableStep<string>, StepError, SqlClient.SqlClient>;
  constructor(step: ResumableMigration["step"]) {
    this.step = step;
  }
}

export const isResumableMigration = (migration: unknown): migration is ResumableMigration =>
  migration instanceof ResumableMigration;

export const make = <Cursor>(options: {
  readonly cursor: Schema.Codec<Cursor>;
  readonly start: Cursor;
  readonly step: (
    cursor: Cursor,
  ) => Effect.Effect<ResumableStep<Cursor>, SqlError.SqlError, SqlClient.SqlClient>;
}) => {
  const codec = Schema.fromJsonString(options.cursor);
  const decode = Schema.decodeEffect(codec);
  const encode = Schema.encodeEffect(codec);
  const unreadable = (cause: Schema.SchemaError) =>
    new Migrator.MigrationError({
      kind: "BadState",
      message: "A resumable migration's stored progress cannot be read by this build.",
      cause,
    });
  return new ResumableMigration(
    Effect.fn("ResumableMigration.step")(function* (cursorJson: string | undefined) {
      const cursor =
        cursorJson === undefined
          ? options.start
          : yield* decode(cursorJson).pipe(Effect.mapError(unreadable));
      const { next, progress } = yield* options.step(cursor);
      return {
        next:
          next === undefined ? undefined : yield* encode(next).pipe(Effect.mapError(unreadable)),
        progress,
      };
    }),
  );
};
