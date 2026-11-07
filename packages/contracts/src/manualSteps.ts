import * as Schema from "effect/Schema";

/** `needs-you` is a money decision; `hands-on` is a step only a person can do. */
export const ManualStepKind = Schema.Literals(["needs-you", "hands-on"]);
export type ManualStepKind = typeof ManualStepKind.Type;

/** A Waiting thread on one machine's pending list in ThreadPage. */
export const ManualStep = Schema.Struct({
  /** The ThreadPage thread's id; several machines list the same thread under this id. */
  threadId: Schema.String,
  title: Schema.String,
  /** The thread's description without its `Needs you:` or `Hands-on:` prefix, on one line. */
  step: Schema.String,
  kind: ManualStepKind,
  /** The machine folder the thread sits in. */
  machine: Schema.String,
  /** When a note in the thread last changed: the step has waited at least since then. */
  updatedAt: Schema.String,
  url: Schema.String,
});
export type ManualStep = typeof ManualStep.Type;

export const ManualStepsListResult = Schema.Union([
  /** This server has no ThreadPage token. */
  Schema.TaggedStruct("NotConnected", {}),
  Schema.TaggedStruct("Listed", {
    steps: Schema.Array(ManualStep),
    checkedAt: Schema.String,
  }),
]);
export type ManualStepsListResult = typeof ManualStepsListResult.Type;

/** Why ThreadPage could not be read, for clients to explain in their own words. */
export const ManualStepsListFailure = Schema.Literals([
  /** ThreadPage refused the token: revoked, replaced or expired. */
  "token-rejected",
  /** The token's access does not cover reading threads. */
  "access-denied",
  /** The owner paused the connection in ThreadPage. */
  "paused",
  "rate-limited",
  /** No folder named Machine inbox is visible to the token. */
  "no-inbox",
  "unreachable",
]);
export type ManualStepsListFailure = typeof ManualStepsListFailure.Type;

export class ManualStepsListError extends Schema.TaggedError<ManualStepsListError>()(
  "ManualStepsListError",
  { reason: ManualStepsListFailure, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
