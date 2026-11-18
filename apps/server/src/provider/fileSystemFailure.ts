import * as PlatformError from "effect/PlatformError";

/** Types a rejected Node filesystem promise as the PlatformError that FileSystem calls fail with. */
export const fileSystemFailure = (method: string, pathOrDescriptor: string) => (cause: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor,
    cause,
  });
