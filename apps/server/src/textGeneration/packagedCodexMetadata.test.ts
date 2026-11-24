import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolvePackagedCodexMetadataBinary } from "./packagedCodexMetadata.ts";

it.effect("selects only the installed server's native metadata package", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const resolve = (sea: boolean, archive: string, platform: NodeJS.Platform) =>
      resolvePackagedCodexMetadataBinary(path.join(dir, archive, "apps/server/dist")).pipe(
        Effect.provideService(HostProcess.IsExecutable, sea),
        Effect.provideService(HostProcess.ExecutablePath, path.join(dir, "t3")),
        Effect.provideService(HostProcess.Platform, platform),
      );
    assert.isUndefined(yield* resolve(true, "", "linux"));
    assert.isUndefined(yield* resolve(false, "app.asar", "darwin"));
    yield* fs.writeFileString(path.join(dir, "codex-metadata.files"), "x 5 bin/codex\n");
    // The runner can now surface its repair diagnostic even if the entire package vanished.
    assert.equal(yield* resolve(true, "", "linux"), path.join(dir, "codex-metadata/bin/codex"));
    assert.equal(
      yield* resolve(false, "app.asar", "darwin"),
      path.join(dir, "codex-metadata/bin/codex"),
    );
    yield* fs.remove(path.join(dir, "codex-metadata.files"));
    // An older package containing the executable still works.
    yield* fs.makeDirectory(path.join(dir, "codex-metadata/bin"), { recursive: true });
    assert.equal(yield* resolve(true, "", "linux"), path.join(dir, "codex-metadata/bin/codex"));
    assert.equal(
      yield* resolve(false, "app.asar", "darwin"),
      path.join(dir, "codex-metadata/bin/codex"),
    );
    assert.equal(
      yield* resolve(false, "server.asar", "win32"),
      path.join(dir, "codex-metadata/bin/codex.exe"),
    );
    assert.isUndefined(yield* resolve(false, "checkout", "linux"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
