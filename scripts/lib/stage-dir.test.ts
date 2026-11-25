import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  StageDirNotEmptyError,
  markStageComplete,
  prepareStageDir,
  requireCompletedStage,
  stageCommitMarker,
} from "./stage-dir.ts";

const STAGED = { platform: "mac", arch: "arm64", version: "1.2.3" };

it.layer(NodeServices.layer)("stage directories", (it) => {
  it.effect("refuses to stage into a directory that already holds files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stageDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stage-dir-" });
        yield* fs.writeFileString(path.join(stageDir, "left-over"), "");

        const error = yield* Effect.flip(prepareStageDir(stageDir));

        assert.instanceOf(error, StageDirNotEmptyError);
      }),
    ),
  );

  it.effect.each([
    { name: "an unfinished stage", marker: undefined, error: "StageIncompleteError" },
    {
      name: "a stage made for another version",
      marker: { ...STAGED, version: "1.2.4" },
      error: "StageMismatchError",
    },
    {
      name: "a stage that records a field packaging does not ask for",
      marker: { ...STAGED, target: "dmg" },
      error: "StageMismatchError",
    },
  ])("refuses to package $name", ({ marker, error }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stage-dir-" });
        yield* prepareStageDir(root);
        if (marker) yield* markStageComplete(root, marker);

        const failure = yield* Effect.flip(requireCompletedStage(root, STAGED));

        assert.equal(failure._tag, error);
      }),
    ),
  );

  it.effect("pins the full commit only for a split build", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = path.resolve(import.meta.dirname, "../..");

      assert.deepStrictEqual(yield* stageCommitMarker("all", repoRoot), {});
      const marker: Record<string, string | undefined> = yield* stageCommitMarker(
        "stage",
        repoRoot,
      );
      assert.match(marker.commit ?? "", /^[0-9a-f]{40}$/);
    }),
  );

  it.effect("refuses a split build outside a git checkout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stage-commit-" });

        const failure = yield* Effect.flip(stageCommitMarker("package", root));

        assert.equal(failure._tag, "StageCommitUnresolvedError");
      }),
    ),
  );

  it.effect("packages a finished stage made for the same build", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stage-dir-" });
        yield* prepareStageDir(root);
        yield* markStageComplete(root, STAGED);

        yield* requireCompletedStage(root, STAGED);
      }),
    ),
  );
});
