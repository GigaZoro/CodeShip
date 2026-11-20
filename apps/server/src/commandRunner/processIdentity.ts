/**
 * What tells a command's wrapper from a later process under the same pid, read on a clock that
 * never steps. Linux: the start in clock ticks since boot with the boot id, both fixed when the
 * process starts. Windows and macOS: the start time the system stored at creation. `ended` marks a
 * wrapper that was already gone when recorded, so any live process under its pid is another one.
 */
export const ENDED_IDENTITY = "ended";

const BOOT_PREFIX = "boot:";
const TIME_PREFIX = "time:";
/** ps reports whole seconds. */
const TIME_SLACK_MS = 1_000;
/** Field 22 of proc(5)'s stat, which counts from the state, field 3, after the command name. */
const STAT_START_TICKS_INDEX = 22 - 3;

export const timeIdentity = (startedAtMs: number) => `${TIME_PREFIX}${startedAtMs}`;

/** The start time of an identity that holds one. */
export const identityTime = (identity: string | null): number | undefined => {
  if (identity === null || !identity.startsWith(TIME_PREFIX)) return undefined;
  const ms = Number(identity.slice(TIME_PREFIX.length));
  return Number.isFinite(ms) ? ms : undefined;
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

/** Whether a live process reading `current` is the one `stored` names; "unknown" when it cannot be told. */
export const compareIdentity = (
  stored: string,
  current: string | undefined,
): "same" | "other" | "unknown" => {
  if (stored === ENDED_IDENTITY) return "other";
  if (current === undefined) return "unknown";
  if (stored.startsWith(BOOT_PREFIX) && current.startsWith(BOOT_PREFIX)) {
    return stored === current ? "same" : "other";
  }
  const was = identityTime(stored);
  const now = identityTime(current);
  if (was === undefined || now === undefined) return "unknown";
  return Math.abs(was - now) <= TIME_SLACK_MS ? "same" : "other";
};
