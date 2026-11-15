/**
 * What signal 0 says of a pid. Only ESRCH proves the process gone: EPERM is a process of another
 * user, and any other error says nothing, so a caller that would stop or forget it waits instead.
 */
export type ProcessProbe =
  | { readonly state: "alive" }
  | { readonly state: "gone"; readonly code: "ESRCH" | "invalid pid" }
  | { readonly state: "unknown"; readonly code: string };

type SignalZero = (pid: number, signal: 0) => unknown;

const signalZero: SignalZero = (pid, signal) => process.kill(pid, signal);

export const probeProcess = (pid: number, signal: SignalZero = signalZero): ProcessProbe => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "gone", code: "invalid pid" };
  try {
    signal(pid, 0);
    return { state: "alive" };
  } catch (cause) {
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? String(cause.code)
        : String(cause);
    if (code === "ESRCH") return { state: "gone", code };
    if (code === "EPERM") return { state: "alive" };
    return { state: "unknown", code };
  }
};

/** False only when the process is proven gone. */
export const isProcessAlive = (pid: number, signal?: SignalZero): boolean =>
  probeProcess(pid, signal).state !== "gone";
