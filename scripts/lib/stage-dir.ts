/** Release builds stage in a step without signing credentials, then sign and package that stage in a later step. */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

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

class StageCommitUnresolvedError extends Schema.TaggedError<StageCommitUnresolvedError>()(
  "StageCommitUnresolvedError",
  { repoRoot: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `A split stage and package build records the commit it built from, but \`git rev-parse --verify HEAD\` in '${this.repoRoot}' ${this.detail}. Build from a git checkout.`;
  }
}

const FULL_COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Split phases run in separate steps, so their marker pins the commit both built from; phase "all" never leaves its process. */
export const stageCommitMarker = Effect.fn("stageCommitMarker")(function* (
  phase: StagePhase,
  repoRoot: string,
) {
  if (phase === "all") return {};
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* spawner
    .string(ChildProcess.make("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot }))
    .pipe(
      Effect.mapError(
        (cause) => new StageCommitUnresolvedError({ repoRoot, detail: `failed: ${cause.message}` }),
      ),
    );
  const commit = output.trim().toLowerCase();
  if (!FULL_COMMIT_HASH.test(commit)) {
    return yield* new StageCommitUnresolvedError({
      repoRoot,
      detail: `printed '${output.trim()}' instead of a full commit hash`,
    });
  }
  return { commit };
});

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
