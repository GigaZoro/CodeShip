import * as NodeOS from "node:os";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

/**
 * The busy share per core at and above which a new `t3_command_run` command waits. It is the
 * limit agent-config's Machine health `cpu-overload` check uses (`tools/cpu-gate.mjs`).
 */
export const CPU_BUSY_SHARE_LIMIT = 0.95;

/** How long one reading watches the CPUs: the two `os.cpus()` samples it compares are this far apart. */
const CPU_SAMPLE_WINDOW = Duration.millis(500);

/** How long a reading stands, so a burst of commands shares one instead of each waiting a window. */
const CPU_READING_TTL = Duration.seconds(2);

/** The cumulative CPU times `os.cpus()` reports for each core, summed over its states. */
export interface CpuTimes {
  readonly idle: number;
  readonly total: number;
}

export interface CpuSaturation {
  readonly busyShare: number;
  readonly limit: number;
  readonly cores: number;
}

/** `os.cpus()` as one core's idle and total ticks each, the form the share is computed from. */
export const cpuTimesOf = (cpus: ReadonlyArray<NodeOS.CpuInfo>): ReadonlyArray<CpuTimes> =>
  cpus.map(({ times }) => ({
    idle: times.idle,
    total: times.user + times.nice + times.sys + times.idle + times.irq,
  }));

/**
 * The share of the CPUs' time spent busy between two samples, over every core together; null when
 * the samples cannot be compared (no cores, a different core count, or no time passed).
 */
export function cpuBusyShare(
  before: ReadonlyArray<CpuTimes>,
  after: ReadonlyArray<CpuTimes>,
): number | null {
  if (before.length === 0 || before.length !== after.length) return null;
  let idle = 0;
  let total = 0;
  for (const [index, start] of before.entries()) {
    idle += after[index]!.idle - start.idle;
    total += after[index]!.total - start.total;
  }
  if (!(total > 0) || idle < 0) return null;
  return Math.min(1, Math.max(0, 1 - idle / total));
}

/**
 * Whether this machine's CPUs are saturated; only `t3_command_run` holds work on it. `delegate_task`
 * refuses on memory instead of queueing, so refusing on CPU would fail a task that only needs to
 * wait out a burst. The chat-resume queue starts one run at a time, and its work reaches the CPU
 * through commands, which this holds.
 */
export class CpuAdmission extends Context.Service<
  CpuAdmission,
  {
    /** The saturation, or null while the CPUs have room or cannot be read. */
    readonly saturation: Effect.Effect<CpuSaturation | null>;
  }
>()("t3/resourceTelemetry/CpuAdmission") {}

export const make = Effect.fn("CpuAdmission.make")(function* (
  sample: Effect.Effect<ReadonlyArray<CpuTimes>>,
  options: {
    readonly limit?: number;
    readonly window?: Duration.Duration;
    readonly ttl?: Duration.Duration;
  } = {},
) {
  const limit = options.limit ?? CPU_BUSY_SHARE_LIMIT;
  const window = options.window ?? CPU_SAMPLE_WINDOW;
  const ttlMs = Duration.toMillis(options.ttl ?? CPU_READING_TTL);
  const reading = yield* Semaphore.make(1);
  let last: { readonly atMs: number; readonly saturation: CpuSaturation | null } | null = null;
  const read = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (last !== null && now - last.atMs < ttlMs) return last.saturation;
    const before = yield* sample;
    yield* Effect.sleep(window);
    const after = yield* sample;
    const busyShare = cpuBusyShare(before, after);
    const saturation: CpuSaturation | null =
      busyShare !== null && busyShare >= limit ? { busyShare, limit, cores: after.length } : null;
    last = { atMs: yield* Clock.currentTimeMillis, saturation };
    return saturation;
  });
  return CpuAdmission.of({
    // Concurrent callers queue behind the one reading and then share its result.
    saturation: reading.withPermits(1)(read).pipe(Effect.withSpan("CpuAdmission.saturation")),
  });
});

export const layer = Layer.effect(CpuAdmission, make(Effect.sync(() => cpuTimesOf(NodeOS.cpus()))));

/** Tests: the CPUs always read `saturation`; the default has room. */
export const layerTest = (saturation: CpuSaturation | null = null) =>
  Layer.succeed(CpuAdmission, CpuAdmission.of({ saturation: Effect.succeed(saturation) }));

/** The reading in a sentence, for agents and logs. */
export const describeCpuSaturation = ({ busyShare, limit, cores }: CpuSaturation) =>
  `the CPUs are ${busyShare.toFixed(2)} busy across ${cores} ${cores === 1 ? "core" : "cores"}, at or over the ${limit} limit`;
