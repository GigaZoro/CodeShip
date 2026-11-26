import type { WindowsProcessTreeRoot } from "@t3tools/shared/windowsProcessTree";

/**
 * Tells a command's wrapper from a later process under its pid. Linux: boot id and start ticks.
 * Windows and macOS: the stored creation time; on Windows the window the launch bounds it to when
 * unread.
 * `ended`: the wrapper was already gone when recorded, so a live process under its pid is another.
 */
export const ENDED_IDENTITY = "ended";

const BOOT_PREFIX = "boot:";
const TIME_PREFIX = "time:";
const WINDOW_PREFIX = "window:";
/**
 * ps reports whole seconds. Wider than the Windows tree stop allows its root, so a process this
 * calls another one, that stop leaves out too.
 */
const TIME_SLACK_MS = 1_000;
/** Field 22 of proc(5)'s stat, which counts from the state, field 3, after the command name. */
const STAT_START_TICKS_INDEX = 22 - 3;

export const timeIdentity = (startedAtMs: number) => `${TIME_PREFIX}${startedAtMs}`;

/** A wrapper whose start its launch could not read, which started between `from` and `to`. */
export const windowIdentity = (from: number, to: number) => `${WINDOW_PREFIX}${from}:${to}`;

/**
 * A start no process has, which a gone wrapper's stop passes as its root's, so a holder of the pid
 * is another process and bounds the wrapper's children by its start, not by a clock reading.
 */
const NO_ROOT = { from: 0, to: 0 };

/** The start time of an identity that holds one. */
export const identityTime = (identity: string | null): number | undefined => {
  if (identity === null || !identity.startsWith(TIME_PREFIX)) return undefined;
  const ms = Number(identity.slice(TIME_PREFIX.length));
  return Number.isFinite(ms) ? ms : undefined;
};

/** When the process an identity names started, as closely as it tells. */
export const identityWindow = (
  identity: string | null,
): { readonly from: number; readonly to: number } | undefined => {
  const time = identityTime(identity);
  if (time !== undefined) return { from: time, to: time };
  if (identity === null || !identity.startsWith(WINDOW_PREFIX)) return undefined;
  const [from, to] = identity.slice(WINDOW_PREFIX.length).split(":").map(Number);
  return from !== undefined && to !== undefined && Number.isFinite(from) && Number.isFinite(to)
    ? { from, to }
    : undefined;
};

/**
 * A launched wrapper's identity from a read under its pid. Windows soon gives an ended wrapper's
 * pid to another process, so there a start outside the window the launch bounds the wrapper to is
 * taken for that process's, and the window stands in, as for no read. macOS hands pids out in
 * turn, and opposite clock steps can put the wrapper's own start outside: its read stands.
 */
export const launchIdentity = (
  read: string | undefined,
  window: { readonly from: number; readonly to: number },
  platform: NodeJS.Platform,
): string | null => {
  if (platform !== "win32") return read ?? null;
  const time = identityTime(read ?? null);
  return read !== undefined && time !== undefined && time >= window.from && time <= window.to
    ? read
    : windowIdentity(window.from, window.to);
};

/** The Linux identity from `/proc/<pid>/stat` and the boot id; undefined when either is malformed. */
export const linuxIdentity = (stat: string, bootId: string): string | undefined => {
  // The command name may hold spaces and parentheses, so fields count from the last one.
  const rest = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/);
  const ticks = rest[STAT_START_TICKS_INDEX];
  const boot = bootId.trim();
  return ticks !== undefined && /^\d+$/.test(ticks) && boot !== ""
    ? `${BOOT_PREFIX}${boot}:${ticks}`
    : undefined;
};

/**
 * Whether a live process reading `current` started when `stored` says; "unknown" when it cannot
 * be told.
 */
export const compareIdentity = (
  stored: string,
  current: string | undefined,
): "same" | "other" | "unknown" => {
  if (current === undefined) return "unknown";
  if (stored.startsWith(BOOT_PREFIX) && current.startsWith(BOOT_PREFIX)) {
    return stored === current ? "same" : "other";
  }
  const was = identityWindow(stored);
  const now = identityTime(current);
  if (was === undefined || now === undefined) return "unknown";
  return now >= was.from - TIME_SLACK_MS && now <= was.to + TIME_SLACK_MS ? "same" : "other";
};

/** The identity a wrapper recorded for itself: its stat line and boot id on Linux, else ps's start. */
export const recordedIdentity = (platform: NodeJS.Platform, text: string): string | undefined => {
  const [first = "", second = ""] = text.split("\n");
  if (platform === "linux") return linuxIdentity(first, second);
  const startedAt = Date.parse(`${first.trim()} UTC`);
  return first.trim() !== "" && Number.isFinite(startedAt) ? timeIdentity(startedAt) : undefined;
};

/**
 * The root a Windows stop of a wrapper takes (`windowsStopTreeArgs`): its pid, its identity as
 * recorded at `recordedAt`, `namedAt`, when it wrote its pid just before it started the command, and
 * `ended`, when the runner saw it exit.
 */
export const windowsStopRoot = (wrapper: {
  readonly pid: number;
  readonly identity: string | null;
  readonly recordedAt: number;
  readonly namedAt: number | undefined;
  readonly ended: WindowsProcessTreeRoot["ended"];
}): WindowsProcessTreeRoot => {
  const created = wrapper.identity === ENDED_IDENTITY ? NO_ROOT : identityWindow(wrapper.identity);
  // With a window or an ended record, take nothing made before the record or before the wrapper
  // named itself, since the window may hold what an earlier holder of its pid made; a clock set back
  // spares the command's own processes. Without a window, `since` also places the root.
  const since =
    identityTime(wrapper.identity) ??
    (created === undefined
      ? wrapper.recordedAt
      : Math.max(wrapper.recordedAt, wrapper.namedAt ?? wrapper.recordedAt));
  return { pid: wrapper.pid, since, created: created ?? "unknown", ended: wrapper.ended };
};
