/** Release builds stage in a step without signing credentials, then sign and package that stage in a later step. */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const StagePhase = Schema.Literals(["all", "stage", "package"]);
export type StagePhase = typeof StagePhase.Type;

const STAGE_MARKER_FILE = "stage.json";
const StageMarker = Schema.Record(Schema.String, Schema.String);
const decodeStageMarker = Schema.decodeEffect(Schema.fromJsonString(StageMarker));
const encodeStageMarker = Schema.encodeEffect(Schema.fromJsonString(StageMarker));

export class StageDirRequiredError extends Schema.TaggedError<StageDirRequiredError>()(
  "StageDirRequiredError",
  { phase: StagePhase },
) {
  override get message(): string {
    return `--phase ${this.phase} needs --stage-dir, the directory the stage and package phases share.`;
  }
}

export class StageDirNotEmptyError extends Schema.TaggedError<StageDirNotEmptyError>()(
  "StageDirNotEmptyError",
  { stageDir: Schema.String },
) {
  override get message(): string {
    return `Stage directory '${this.stageDir}' is not empty. A stage starts empty so nothing from another build ships.`;
  }
}

class StageIncompleteError extends Schema.TaggedError<StageIncompleteError>()(
  "StageIncompleteError",
  { stageDir: Schema.String },
) {
  override get message(): string {
    return `Stage directory '${this.stageDir}' holds no finished stage (${STAGE_MARKER_FILE} is missing). Run the stage phase into an empty directory first.`;
  }
}

class StageMismatchError extends Schema.TaggedError<StageMismatchError>()("StageMismatchError", {
  stageDir: Schema.String,
  field: Schema.String,
  staged: Schema.optional(Schema.String),
  requested: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `Stage directory '${this.stageDir}' was staged with ${this.field}=${this.staged ?? "<unset>"}, but packaging asked for ${this.field}=${this.requested ?? "<unset>"}.`;
  }
}

export const prepareStageDir = Effect.fn("prepareStageDir")(function* (stageDir: string) {
  const fs = yield* FileSystem.FileSystem;
  if ((yield* fs.exists(stageDir)) && (yield* fs.readDirectory(stageDir)).length > 0) {
    return yield* new StageDirNotEmptyError({ stageDir });
  }
  yield* fs.makeDirectory(stageDir, { recursive: true });
});

/** Written last, so the marker exists only when every stage step finished. */
export const markStageComplete = Effect.fn("markStageComplete")(function* (
  stageDir: string,
  marker: Readonly<Record<string, string>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(
    path.join(stageDir, STAGE_MARKER_FILE),
    `${yield* encodeStageMarker(marker)}\n`,
  );
});

export const requireCompletedStage = Effect.fn("requireCompletedStage")(function* (
  stageDir: string,
  expected: Readonly<Record<string, string>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const markerPath = path.join(stageDir, STAGE_MARKER_FILE);
  if (!(yield* fs.exists(markerPath))) {
    return yield* new StageIncompleteError({ stageDir });
  }
  const staged = yield* decodeStageMarker(yield* fs.readFileString(markerPath));
  for (const field of new Set([...Object.keys(staged), ...Object.keys(expected)])) {
    const stagedValue = staged[field];
    const requestedValue = expected[field];
    if (stagedValue !== requestedValue) {
      return yield* new StageMismatchError({
        stageDir,
        field,
        ...(stagedValue === undefined ? {} : { staged: stagedValue }),
        ...(requestedValue === undefined ? {} : { requested: requestedValue }),
      });
    }
  }
});
