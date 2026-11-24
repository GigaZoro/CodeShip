import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  SeaRequiresCodexMetadata,
  resolvePackagedCodexMetadataBinary,
} from "./packagedCodexMetadata.ts";

it.effect("selects only the installed server's native metadata package", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const resolve = (sea: boolean, archive: string, platform: NodeJS.Platform, required: boolean) =>
      resolvePackagedCodexMetadataBinary(path.join(dir, archive, "apps/server/dist")).pipe(
        Effect.provideService(SeaRequiresCodexMetadata, required),
        Effect.provideService(HostProcess.IsExecutable, sea),
        Effect.provideService(HostProcess.ExecutablePath, path.join(dir, "t3")),
        Effect.provideService(HostProcess.Platform, platform),
      );
    assert.isUndefined(yield* resolve(true, "", "linux", false));
    assert.equal(
      yield* resolve(true, "", "linux", true),
      path.join(dir, "codex-metadata/bin/codex"),
    );
    for (const [archive, platform, executable] of [
      ["app.asar", "darwin", "codex"],
      ["server.asar", "win32", "codex.exe"],
    ] as const) {
      const dist = path.join(dir, archive, "apps/server/dist");
      yield* fs.makeDirectory(dist, { recursive: true });
      assert.isUndefined(yield* resolve(false, archive, platform, false));
      yield* fs.writeFileString(path.join(dist, "codex-metadata.files"), "required");
      assert.equal(
        yield* resolve(false, archive, platform, false),
        path.join(dir, "codex-metadata/bin", executable),
      );
    }
    assert.isUndefined(yield* resolve(false, "checkout", "linux", true));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "uses the verified Linux runtime or reports the mounted WSL installation needs repair",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const mounted = path.join(dir, "wsl-server-tree", "1.2.3", "apps/server/dist");
      const runtime = path.join(dir, "linux-runtime");
      const resolve = (root?: string, moduleDirectory = mounted) =>
        resolvePackagedCodexMetadataBinary(moduleDirectory).pipe(
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, {
            T3CODE_WSL_CODEX_METADATA_RUNTIME_ROOT: root,
          }),
        );
      assert.isUndefined(yield* resolve());
      assert.isUndefined(yield* resolve(runtime, path.join(dir, "checkout/apps/server/dist")));
      assert.equal(yield* resolve(runtime), path.join(runtime, "codex-metadata/bin/codex"));
      for (const invalidRoot of ["", "relative/runtime"]) {
        const failure = yield* Effect.flip(resolve(invalidRoot));
        assert.match(String(failure), /Reinstall CodeShip.*Linux Codex metadata runtime.*WSL/);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
