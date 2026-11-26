// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's FileSystem has no way to list /proc cheaply.
import * as NodeFSP from "node:fs/promises";
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
const MAX_LINUX_NICE = 19;
// CAP_SYS_NICE can raise priority and CAP_SYS_RESOURCE can raise hard limits.
const PRIORITY_CAPABILITIES = (1n << 23n) | (1n << 24n);

const isId = (text: string) => /^\d+$/.test(text);

async function readIfVisible<A>(read: Promise<A>): Promise<A | null> {
  try {
    return await read;
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (cause.code === "ENOENT" ||
        cause.code === "ESRCH" ||
        cause.code === "EACCES" ||
        cause.code === "EPERM")
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

function parseThreadStat(text: string) {
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
  const threadCount = Number(fields[17]);
  const start = fields[19];
  const policy = Number(fields[38]);
  if (
    !isId(tid) ||
    fields[0] === "Z" ||
    fields[0] === "X" ||
    fields[0] === "x" ||
    start === undefined ||
    !isId(start) ||
    !Number.isSafeInteger(userTicks) ||
    userTicks < 0 ||
    !Number.isInteger(nice) ||
    nice < -20 ||
    nice > MAX_LINUX_NICE ||
    !Number.isSafeInteger(threadCount) ||
    threadCount < 1 ||
    !Number.isSafeInteger(policy) ||
    policy < 0
  ) {
    return null;
  }
  return { tid, start, userTicks, nice, policy, threadCount };
}

type ThreadStat = NonNullable<ReturnType<typeof parseThreadStat>>;

interface ThreadPath {
  readonly tgid: string;
  readonly tid: string;
  readonly directory: string;
}

interface ThreadObservation {
  readonly thread: ThreadPath;
  readonly stat: ThreadStat;
}

interface Baseline extends ThreadObservation {
  readonly witness: ThreadObservation | undefined;
}

const readFile = (file: string, signal: AbortSignal) =>
  readIfVisible(NodeFSP.readFile(file, { encoding: "utf8", signal }));

async function readThreadStat(thread: ThreadPath, signal: AbortSignal) {
  const text = await readFile(`${thread.directory}/stat`, signal);
  const stat = text === null ? null : parseThreadStat(text);
  return stat?.tid === thread.tid ? stat : null;
}

function sameThreadAndPriority(before: ThreadStat, after: ThreadStat) {
  return (
    before.start === after.start && before.nice === after.nice && before.policy === after.policy
  );
}

async function readThreads(procDir: string, signal: AbortSignal) {
  const pids = (await NodeFSP.readdir(procDir)).filter(isId);
  const taskPaths = await readBatches(pids, signal, async (tgid) => {
    const taskDir = `${procDir}/${tgid}/task`;
    const tids = await readIfVisible(NodeFSP.readdir(taskDir));
    return tids?.filter(isId).map((tid) => ({ tgid, tid, directory: `${taskDir}/${tid}` })) ?? null;
  });
  // A process-wide stat mixes the CPU time of threads that can have different nice values.
  return readBatches(taskPaths.flat(), signal, async (thread) => {
    const stat = await readThreadStat(thread, signal);
    return stat === null ? null : { thread, stat };
  });
}

async function readEligibleGroups(
  procDir: string,
  tgids: Iterable<string>,
  minNice: number,
  signal: AbortSignal,
) {
  const eligible = await readBatches([...new Set(tgids)], signal, async (tgid) => {
    const text = await readFile(`${procDir}/${tgid}/limits`, signal);
    if (text === null) return null;
    const hardNice = /^Max nice priority[ \t]+\d+[ \t]+(\d+)[ \t]*$/m.exec(text)?.[1];
    const hardRealtime = /^Max realtime priority[ \t]+\d+[ \t]+(\d+)[ \t]*$/m.exec(text)?.[1];
    // The soft limit can increase up to the hard limit without privileges.
    return Number(hardNice) < MAX_LINUX_NICE + 1 - minNice && Number(hardRealtime) === 0
      ? tgid
      : null;
  });
  return new Set(eligible);
}

async function lacksPriorityCapabilities(thread: ThreadPath, signal: AbortSignal) {
  const text = await readFile(`${thread.directory}/status`, signal);
  if (text === null) return false;
  const permitted = /^CapPrm:[ \t]+([\da-f]{16})[ \t]*$/im.exec(text)?.[1];
  return permitted !== undefined && (BigInt(`0x${permitted}`) & PRIORITY_CAPABILITIES) === 0n;
}

async function readBaselines(procDir: string, minNice: number, signal: AbortSignal) {
  const observed = await readThreads(procDir, signal);
  const witnesses = new Map<string, ThreadObservation>();
  for (const observation of observed) {
    const { tgid, tid } = observation.thread;
    if (tgid !== tid && !witnesses.has(tgid)) witnesses.set(tgid, observation);
  }
  const candidates = observed.filter(
    ({ stat }) =>
      stat.nice > minNice && (stat.policy === SCHED_OTHER || stat.policy === SCHED_BATCH),
  );
  const eligible = await readEligibleGroups(
    procDir,
    candidates.map(({ thread }) => thread.tgid),
    minNice,
    signal,
  );
  return readBatches(candidates, signal, async ({ thread, stat: discovered }) => {
    if (!eligible.has(thread.tgid) || !(await lacksPriorityCapabilities(thread, signal)))
      return null;
    const stat = await readThreadStat(thread, signal);
    if (stat === null || !sameThreadAndPriority(discovered, stat)) return null;
    // A worker exec can inherit the leader's TID and start time, but kills all its siblings.
    const needsWitness = thread.tid === thread.tgid && stat.threadCount > 1;
    const witness = needsWitness ? witnesses.get(thread.tgid) : undefined;
    return needsWitness && witness === undefined ? null : { thread, stat, witness };
  });
}

async function readElapsed(
  baselines: readonly Baseline[],
  procDir: string,
  minNice: number,
  signal: AbortSignal,
) {
  const deltas = await readBatches(baselines, signal, async ({ thread, stat: before, witness }) => {
    const after = await readThreadStat(thread, signal);
    if (after === null || !sameThreadAndPriority(before, after)) return null;
    // The independently rounded counters can overstate the difference by one tick.
    const ticks = after.userTicks - before.userTicks - 1;
    if (ticks <= 0 || !(await lacksPriorityCapabilities(thread, signal))) return null;
    if (witness !== undefined) {
      const surviving = await readThreadStat(witness.thread, signal);
      if (surviving?.start !== witness.stat.start) return null;
    }
    return { tgid: thread.tgid, ticks };
  });
  const eligible = await readEligibleGroups(
    procDir,
    deltas.map(({ tgid }) => tgid),
    minNice,
    signal,
  );
  return (
    deltas.reduce((sum, { tgid, ticks }) => (eligible.has(tgid) ? sum + ticks : sum), 0) *
    MS_PER_TICK
  );
}

export const startYieldingNiceSample = Effect.fn("YieldingNiceTime.start")(function* (
  commandNice: number,
  procDir = "/proc",
): Effect.fn.Return<
  { readonly elapsed: Effect.Effect<number, YieldingNiceTimeUnreadable> },
  YieldingNiceTimeUnreadable
> {
  const minNice = Math.max(0, commandNice);
  if (minNice >= MAX_LINUX_NICE) return { elapsed: Effect.succeed(0) };

  const baselines = yield* Effect.tryPromise({
    catch: (cause) => new YieldingNiceTimeUnreadable({ cause }),
    try: (signal) => readBaselines(procDir, minNice, signal),
  });

  const elapsed = Effect.tryPromise({
    catch: (cause) => new YieldingNiceTimeUnreadable({ cause }),
    try: (signal) => readElapsed(baselines, procDir, minNice, signal),
  }).pipe(Effect.withSpan("YieldingNiceTime.elapsed"));
  return { elapsed };
});
