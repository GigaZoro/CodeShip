import * as HostProcess from "@t3tools/shared/HostProcess";
import { CODEX_METADATA_INVENTORY } from "@t3tools/shared/cliRelease";
import { embeddedCodexMetadataDigest } from "@t3tools/shared/codexMetadataInventory";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const SeaRequiresCodexMetadata = Context.Reference<boolean>(
  "t3/codex/SeaRequiresCodexMetadata",
  {
    defaultValue: () => Boolean(embeddedCodexMetadataDigest),
  },
);

export const resolvePackagedCodexMetadataBinary = Effect.fn("codex.resolvePackagedMetadataBinary")(
  function* (moduleDirectory = import.meta.dirname) {
    const path = yield* Path.Path;
    let resources: string;
    if (yield* HostProcess.IsExecutable) {
      if (!(yield* SeaRequiresCodexMetadata)) return undefined;
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
      const fs = yield* FileSystem.FileSystem;
      if (
        !(yield* fs.exists(path.join(moduleDirectory, CODEX_METADATA_INVENTORY)).pipe(Effect.orDie))
      )
        return undefined;
      resources = path.dirname(archive);
    }
    return path.join(
      resources,
      "codex-metadata",
      "bin",
      (yield* HostProcess.Platform) === "win32" ? "codex.exe" : "codex",
    );
  },
);
