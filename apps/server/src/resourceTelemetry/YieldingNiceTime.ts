// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's FileSystem has no way to list /proc cheaply.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class YieldingNiceTimeUnreadable extends Schema.TaggedError<YieldingNiceTimeUnreadable>()(
  "YieldingNiceTimeUnreadable",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The scheduling priorities of this host could not be read from /proc.";
  }
}

// Linux exports /proc CPU counters at 100 Hz, the same ticks libuv converts for os.cpus().
const MS_PER_TICK = 10;
const READ_CONCURRENCY = 64;
const SCHED_OTHER = 0;
const SCHED_BATCH = 3;

const isId = (text: string) => /^\d+$/.test(text);

async function readIfPresent<A>(read: Promise<A>): Promise<A | null> {
  try {
    return await read;
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (cause.code === "ENOENT" || cause.code === "ESRCH")
    ) {
      return null;
    }
    throw cause;
  }
}

async function readBatches<A, B>(
  inputs: readonly A[],
  signal: AbortSignal,
  read: (input: A) => Promise<B | null>,
): Promise<B[]> {
  const results: B[] = [];
  for (let index = 0; index < inputs.length; index += READ_CONCURRENCY) {
    signal.throwIfAborted();
    const batch = await Promise.all(inputs.slice(index, index + READ_CONCURRENCY).map(read));
    for (const result of batch) if (result !== null) results.push(result);
  }
  return results;
}

function parseThreadStat(text: string, minNice: number) {
  // The command name sits in parentheses and can contain parentheses itself.
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const tid = text.slice(0, open).trim();
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const userTicks = Number(fields[11]);
  const nice = Number(fields[16]);
  const start = fields[19];
  const policy = Number(fields[38]);
  if (
    !isId(tid) ||
    start === undefined ||
    !isId(start) ||
    !Number.isSafeInteger(userTicks) ||
    userTicks < 0 ||
    !Number.isInteger(nice) ||
    nice <= minNice ||
    nice > 19 ||
    (policy !== SCHED_OTHER && policy !== SCHED_BATCH)
  ) {
    return null;
  }
  return { tid, start, userTicks, nice, policy };
}

export const startYieldingNiceSample = Effect.fn("YieldingNiceTime.start")(function* (
  commandNice: number,
  procDir = "/proc",
): Effect.fn.Return<
  { readonly elapsed: Effect.Effect<number, YieldingNiceTimeUnreadable> },
  YieldingNiceTimeUnreadable
> {
  const minNice = Math.max(0, commandNice);
  if (minNice >= 19) return { elapsed: Effect.succeed(0) };

  const readStat = async (file: string, signal: AbortSignal) => {
    const text = await readIfPresent(NodeFSP.readFile(file, { encoding: "utf8", signal }));
    return text === null ? null : parseThreadStat(text, minNice);
  };

  const candidates = yield* Effect.tryPromise({
    catch: (cause) => new YieldingNiceTimeUnreadable({ cause }),
    try: async (signal) => {
      const pids = (await NodeFSP.readdir(procDir)).filter(isId);
      const taskFiles = await readBatches(pids, signal, async (pid) => {
        const taskDir = NodePath.join(procDir, pid, "task");
        const tids = await readIfPresent(NodeFSP.readdir(taskDir));
        return tids?.filter(isId).map((tid) => NodePath.join(taskDir, tid, "stat")) ?? null;
      });
      // A process-wide stat mixes the CPU time of threads that can have different nice values.
      return readBatches(taskFiles.flat(), signal, async (file) => {
        const stat = await readStat(file, signal);
        return stat === null ? null : { file, stat };
      });
    },
  });

  const elapsed = Effect.tryPromise({
    catch: (cause) => new YieldingNiceTimeUnreadable({ cause }),
    try: async (signal) => {
      const deltas = await readBatches(candidates, signal, async ({ file, stat: before }) => {
        const after = await readStat(file, signal);
        if (
          after === null ||
          after.tid !== before.tid ||
          after.start !== before.start ||
          after.nice !== before.nice ||
          after.policy !== before.policy
        ) {
          return null;
        }
        // The independently rounded counters can overstate the difference by one tick.
        return Math.max(0, after.userTicks - before.userTicks - 1);
      });
      return deltas.reduce((sum, ticks) => sum + ticks, 0) * MS_PER_TICK;
    },
  }).pipe(Effect.withSpan("YieldingNiceTime.elapsed"));
  return { elapsed };
});
