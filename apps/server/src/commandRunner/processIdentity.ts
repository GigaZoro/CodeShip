/**
 * Tells a command's wrapper from a later process under its pid. Linux: boot id and start ticks.
 * macOS and legacy rows: the stored creation time or launch window, which proves loss, not ownership.
 * A Windows stop needs the full FILETIME, which a legacy row takes from a root started in its ms.
 * `ended`: the wrapper was already gone when recorded, so a live process under its pid is another.
 */
export const ENDED_IDENTITY = "ended";

const BOOT_PREFIX = "boot:";
const TIME_PREFIX = "time:";
const WINDOW_PREFIX = "window:";
/** Field 22 of proc(5)'s stat, which counts from the state, field 3, after the command name. */
const STAT_START_TICKS_INDEX = 22 - 3;

export const timeIdentity = (startedAtMs: number) => `${TIME_PREFIX}${startedAtMs}`;

/** A wrapper whose start its launch could not read, which started between `from` and `to`. */
export const windowIdentity = (from: number, to: number) => `${WINDOW_PREFIX}${from}:${to}`;

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
  return now >= was.from && now <= was.to ? "same" : "other";
};
