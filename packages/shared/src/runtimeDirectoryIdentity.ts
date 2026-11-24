// @effect-diagnostics nodeBuiltinImport:off - Shared by the server and the dependency-free npm launcher.
import * as NodeFS from "node:fs";

/** Detect a concurrent publication without holding the directory open during the executable probe. */
export function trackRuntimeDirectory(path: string) {
  const stat = () => NodeFS.statSync(path, { bigint: true, throwIfNoEntry: false });
  const before = stat();
  return () => {
    const after = stat();
    return (
      before?.dev === after?.dev &&
      before?.ino === after?.ino &&
      before?.birthtimeNs === after?.birthtimeNs
    );
  };
}
