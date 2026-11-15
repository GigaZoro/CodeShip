import * as HostProcess from "../HostProcess.ts";

/** For `it.skipIf`/`it.runIf`, which decide before any Effect runs. */
export const isWindowsHost: boolean = HostProcess.Platform.defaultValue() === "win32";
export const isDarwinHost: boolean = HostProcess.Platform.defaultValue() === "darwin";
