import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CODEX_METADATA_INVENTORY,
  WSL_CODEX_METADATA_RUNTIME_ROOT_ENV,
} from "@t3tools/shared/cliRelease";
import { embeddedCodexMetadataDigest } from "@t3tools/shared/codexMetadataInventory";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const SeaRequiresCodexMetadata = Context.Reference<boolean>(
  "t3/codex/SeaRequiresCodexMetadata",
  {
    defaultValue: () => Boolean(embeddedCodexMetadataDigest),
  },
);

class WslMetadataUnavailable extends Data.TaggedError("WslMetadataUnavailable") {
  override readonly message =
    "Reinstall CodeShip to restore its bundled Linux Codex metadata runtime for WSL, then restart the WSL backend.";
}

export const resolvePackagedCodexMetadataBinary = Effect.fn("codex.resolvePackagedMetadataBinary")(
  function* (moduleDirectory = import.meta.dirname) {
    const path = yield* Path.Path;
    let resources: string;
    if (yield* HostProcess.IsExecutable) {
      if (!(yield* SeaRequiresCodexMetadata)) return undefined;
      resources = path.dirname(yield* HostProcess.ExecutablePath);
    } else {
      const serverRoot = path.resolve(moduleDirectory, "../../..");
      if (path.relative(serverRoot, moduleDirectory) !== path.join("apps", "server", "dist")) {
        return undefined;
      }
      if (path.basename(serverRoot) === "app.asar" || path.basename(serverRoot) === "server.asar") {
        const fs = yield* FileSystem.FileSystem;
        if (
          !(yield* fs
            .exists(path.join(moduleDirectory, CODEX_METADATA_INVENTORY))
            .pipe(Effect.orDie))
        ) {
          return undefined;
        }
        resources = path.dirname(serverRoot);
      } else if (
        (yield* HostProcess.Platform) === "linux" &&
        path.basename(path.dirname(serverRoot)) === "wsl-server-tree"
      ) {
        const linuxRoot = (yield* HostProcess.Environment)[WSL_CODEX_METADATA_RUNTIME_ROOT_ENV];
        if (linuxRoot === undefined) return undefined;
        if (!path.isAbsolute(linuxRoot)) return yield* new WslMetadataUnavailable();
        resources = linuxRoot;
      } else {
        return undefined;
      }
    }
    return path.join(
      resources,
      "codex-metadata",
      "bin",
      (yield* HostProcess.Platform) === "win32" ? "codex.exe" : "codex",
    );
  },
);
