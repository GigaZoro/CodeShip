// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's FileSystem has no way to list /proc cheaply.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class HeldNiceTimeUnreadable extends Schema.TaggedError<HeldNiceTimeUnreadable>()(
  "HeldNiceTimeUnreadable",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The niced processes of this host could not be read from /proc.";
  }
}

/** Cumulative CPU milliseconds of each process that does not give way to a new command, by `pid:start`. */
export type HeldNiceTime = ReadonlyMap<string, number>;

// Linux counts CPU time in ticks of 1/CLK_TCK s; os.cpus() multiplies by the same 1000/CLK_TCK.
const MS_PER_TICK = 10;

const BATCH = 64;

/**
 * One process's `/proc/<pid>/stat`: its identity and CPU time when it runs niced (nice above 0),
 * at or below `maxNice`. A process above `maxNice` yields to a command started at `maxNice`. The
 * time of children it already reaped counts too, so a build of short-lived children is not lost when
 * they end between two readings; a child's earlier time may count again, which errs toward busy.
 */
export function parseNicedProcessStat(
  text: string,
  maxNice: number,
): { readonly key: string; readonly cpuMs: number } | null {
  // The command name sits in parentheses and may hold spaces and parentheses itself.
  const close = text.lastIndexOf(")");
  const open = text.indexOf("(");
  if (open < 0 || close < open) return null;
  const pid = text.slice(0, open).trim();
  const fields = text
    .slice(close + 1)
    .trim()
    .split(" ");
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const cutime = Number(fields[13]);
  const cstime = Number(fields[14]);
  const nice = Number(fields[16]);
  const start = fields[19];
  if (
    !/^\d+$/.test(pid) ||
    start === undefined ||
    !Number.isFinite(utime + stime + cutime + cstime) ||
    !Number.isFinite(nice)
  ) {
    return null;
  }
  if (nice <= 0 || nice > maxNice) return null;
  return { key: `${pid}:${start}`, cpuMs: (utime + stime + cutime + cstime) * MS_PER_TICK };
}

/** The CPU time these processes used between two readings; a process that started in between counts whole. */
export function heldNiceDelta(before: HeldNiceTime, after: HeldNiceTime): number {
  let used = 0;
  for (const [key, cpuMs] of after) used += Math.max(0, cpuMs - (before.get(key) ?? 0));
  return used;
}

const gone = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ESRCH");

/**
 * The niced processes of a Linux host that a command started at `maxNice` does not displace:
 * those at or below its priority. `/proc/stat` reports every niced process as one `nice` time,
 * so the share that a new command would displace cannot be told from it alone.
 */
export const readHeldNiceTimeFromProc = (
  maxNice: number,
): Effect.Effect<HeldNiceTime, HeldNiceTimeUnreadable> =>
  Effect.tryPromise({
    catch: (cause) => new HeldNiceTimeUnreadable({ cause }),
    try: async () => {
      const pids = (await NodeFSP.readdir("/proc")).filter((name) => /^\d+$/.test(name));
      const held = new Map<string, number>();
      for (let index = 0; index < pids.length; index += BATCH) {
        const texts = await Promise.all(
          pids.slice(index, index + BATCH).map(async (pid) => {
            try {
              return await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8");
            } catch (cause) {
              // The process ended between the listing and the read.
              if (gone(cause)) return null;
              throw cause;
            }
          }),
        );
        for (const text of texts) {
          const process = text === null ? null : parseNicedProcessStat(text, maxNice);
          if (process !== null) held.set(process.key, process.cpuMs);
        }
      }
      return held;
    },
  });
