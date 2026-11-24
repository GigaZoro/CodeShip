// @effect-diagnostics nodeBuiltinImport:off - a Windows junction, which FileSystem.symlink cannot make.
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import { hostCapabilities } from "./hostCapabilities.ts";

/**
 * Whether file symlinks can be created. Windows needs Developer Mode or elevation for them, so a
 * test that needs a real file symlink skips on `!symlinksSupported`. A directory link needs no
 * privilege: use `linkDirectory`.
 */
export const symlinksSupported = hostCapabilities.symlinks;

/** Links a directory with a junction on Windows (no privilege needed) and a symlink elsewhere. */
export const linkDirectory = (target: string, link: string) =>
  Effect.sync(() => NodeFS.symlinkSync(target, link, "junction"));
