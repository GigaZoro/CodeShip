import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const resolvePackagedCodexMetadataBinary = Effect.fn("codex.resolvePackagedMetadataBinary")(
  function* (moduleDirectory = import.meta.dirname) {
    const path = yield* Path.Path;
    let resources: string;
    if (yield* HostProcess.IsExecutable) {
      resources = path.dirname(yield* HostProcess.ExecutablePath);
    } else {
      // The desktop server bundle lives in {app,server}.asar/apps/server/dist.
      const archive = path.resolve(moduleDirectory, "../../..");
      if (
        (path.basename(archive) !== "app.asar" && path.basename(archive) !== "server.asar") ||
        path.relative(archive, moduleDirectory) !== path.join("apps", "server", "dist")
      ) {
        return undefined;
      }
      resources = path.dirname(archive);
    }
    const fs = yield* FileSystem.FileSystem;
    const root = path.join(resources, "codex-metadata");
    if (!(yield* fs.exists(root).pipe(Effect.orDie))) return undefined;
    return path.join(
      root,
      "bin",
      (yield* HostProcess.Platform) === "win32" ? "codex.exe" : "codex",
    );
  },
);
