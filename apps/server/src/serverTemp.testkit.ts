// @effect-diagnostics nodeBuiltinImport:off -- runs at test setup, before the folder's first use.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.join(import.meta.dirname, "..", "tmp");

/**
 * apps/server/tmp, for a test folder that must stay in the checkout. tmp/ is gitignored, so
 * `vp run check:changed` does not see what tests make there as changes.
 */
export const serverTempRoot = () => {
  NodeFS.mkdirSync(root, { recursive: true });
  return root;
};

/**
 * Where a test makes a folder of fake binaries for PATH, relative to cwd: a POSIX delimiter splits
 * an absolute Windows path at its drive colon, and only a folder in the checkout is surely on cwd's drive.
 */
export const pathEntryTempRoot = () => NodePath.relative(process.cwd(), serverTempRoot());
