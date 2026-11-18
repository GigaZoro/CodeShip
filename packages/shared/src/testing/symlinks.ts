// @effect-diagnostics nodeBuiltinImport:off - one synchronous probe at module load, outside any Effect runtime.
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Whether file symlinks can be created. Windows needs Developer Mode or elevation for them, so a
 * test that needs a real file symlink skips on `!symlinksSupported`. A directory link needs no
 * privilege: use `linkDirectory`.
 */
export const symlinksSupported: boolean = (() => {
  let directory: string | undefined;
  try {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-symlink-probe-"));
    NodeFS.symlinkSync(NodePath.join(directory, "target"), NodePath.join(directory, "link"));
    return true;
  } catch {
    return false;
  } finally {
    // Cleanup EPERM/EBUSY must not fail module initialization or decide symlink support.
    try {
      if (directory !== undefined) NodeFS.rmSync(directory, { recursive: true, force: true });
    } catch {}
  }
})();

/** Links a directory with a junction on Windows (no privilege needed) and a symlink elsewhere. */
export const linkDirectory = (target: string, link: string) =>
  Effect.sync(() => NodeFS.symlinkSync(target, link, "junction"));
