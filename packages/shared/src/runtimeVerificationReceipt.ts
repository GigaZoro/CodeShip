// @effect-diagnostics nodeBuiltinImport:off - The dependency-free npm launcher also uses these file descriptors.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Keep revocation attached to the receipt that existed when validation started, across directory renames. */
export function openRuntimeVerificationReceipt(receiptPath: string, version: string) {
  const directory = NodePath.dirname(receiptPath);
  const statDirectory = () => NodeFS.statSync(directory, { bigint: true, throwIfNoEntry: false });
  const original = statDirectory();
  let file: number | undefined;
  let trusted = false;
  try {
    const entry = NodeFS.lstatSync(receiptPath, { bigint: true, throwIfNoEntry: false });
    const limit = Buffer.byteLength(version) + 2;
    if (entry?.isFile() && entry.nlink === 1n && entry.size <= BigInt(limit)) {
      const { O_RDWR, O_NONBLOCK, O_NOFOLLOW } = NodeFS.constants;
      file = NodeFS.openSync(receiptPath, O_RDWR | (O_NONBLOCK ?? 0) | (O_NOFOLLOW ?? 0));
      const opened = NodeFS.fstatSync(file, { bigint: true });
      if (
        opened.isFile() &&
        opened.nlink === 1n &&
        opened.dev === entry.dev &&
        opened.ino === entry.ino &&
        opened.size === entry.size
      ) {
        const bytes = Buffer.alloc(limit + 1);
        const count = NodeFS.readSync(file, bytes);
        trusted =
          count === Number(opened.size) && bytes.toString("utf8", 0, count).trim() === version;
      }
    }
  } catch {
    // A read-only or unavailable receipt cannot authorize a cache hit. The executable can still verify offline.
  }
  return {
    trusted,
    current() {
      const now = statDirectory();
      return (
        now?.dev === original?.dev &&
        now?.ino === original?.ino &&
        now?.birthtimeNs === original?.birthtimeNs
      );
    },
    revoke() {
      if (trusted && file !== undefined && NodeFS.fstatSync(file).nlink === 1)
        NodeFS.ftruncateSync(file, 0);
    },
    close() {
      if (file !== undefined) NodeFS.closeSync(file);
    },
  };
}
