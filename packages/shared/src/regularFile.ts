// @effect-diagnostics nodeBuiltinImport:off - Effect FileSystem.open cannot request a nonblocking descriptor.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

/** Open before checking the file type so path replacement cannot turn a regular-file read into a blocked FIFO read. */
export async function withRegularFile<A>(
  path: string,
  read: (file: NodeFSP.FileHandle, stat: NodeFS.Stats) => Promise<A>,
  options?: { readonly noFollow?: boolean },
): Promise<A> {
  const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = NodeFS.constants;
  const flags = O_RDONLY | (O_NONBLOCK ?? 0) | (options?.noFollow ? (O_NOFOLLOW ?? 0) : 0);
  if (O_NOFOLLOW === undefined && options?.noFollow && !(await NodeFSP.lstat(path)).isFile()) {
    throw new Error(`Expected a regular file at ${path}.`);
  }
  const file = await NodeFSP.open(path, flags);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error(`Expected a regular file at ${path}.`);
    return await read(file, stat);
  } finally {
    await file.close();
  }
}

export const readRegularFileUtf8 = (path: string): Promise<string> =>
  withRegularFile(path, (file) => file.readFile("utf8"));
