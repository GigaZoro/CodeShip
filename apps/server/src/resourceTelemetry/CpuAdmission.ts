import * as NodeOS from "node:os";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { AGENT_NICE_INCREMENT } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { startYieldingNiceSample } from "./YieldingNiceTime.ts";

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
  /** Time of processes running niced (nice above 0). */
  readonly nice: number;
  readonly total: number;
}

export interface CpuSaturation {
  /** The share of the CPUs' time that a new command would have to compete with. */
  readonly busyShare: number;
  readonly nicedShare: number;
  /** The part of total CPU time attributed to threads below the new command's priority. */
  readonly excludedShare: number;
  readonly limit: number;
  readonly cores: number;
}

/** From this niced share on, the queued message names it. */
const NICED_SHARE_WORTH_NAMING = 0.1;

/** `os.cpus()` as one core's idle, nice and total ticks each, the form the share is computed from. */
export const cpuTimesOf = (cpus: ReadonlyArray<NodeOS.CpuInfo>): ReadonlyArray<CpuTimes> =>
  cpus.map(({ times }) => ({
    idle: times.idle,
    nice: times.nice,
    total: times.user + times.nice + times.sys + times.idle + times.irq,
  }));

/** Shares of total CPU time in the sample window. Unattributed niced time stays busy. */
export function cpuShares(
  before: ReadonlyArray<CpuTimes>,
  after: ReadonlyArray<CpuTimes>,
  yieldingNiceMs = 0,
) {
  if (before.length === 0 || before.length !== after.length) return null;
  let idle = 0;
  let nice = 0;
  let total = 0;
  for (const [index, start] of before.entries()) {
    idle += after[index]!.idle - start.idle;
    nice += after[index]!.nice - start.nice;
    total += after[index]!.total - start.total;
  }
  if (!(total > 0) || idle < 0 || nice < 0) return null;
  const excluded = Math.min(nice, Math.max(0, yieldingNiceMs));
  const clamp = (share: number) => Math.min(1, Math.max(0, share));
  return {
    busyShare: clamp((total - idle - excluded) / total),
    nicedShare: clamp(nice / total),
    excludedShare: clamp(excluded / total),
  };
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
    readonly startYieldingNiceSample?: ReturnType<typeof startYieldingNiceSample>;
  } = {},
) {
  const limit = options.limit ?? CPU_BUSY_SHARE_LIMIT;
  const window = options.window ?? CPU_SAMPLE_WINDOW;
  const ttlMs = Duration.toMillis(options.ttl ?? CPU_READING_TTL);
  const reading = yield* Semaphore.make(1);
  let last: { readonly atMs: number; readonly saturation: CpuSaturation | null } | null = null;
  let procReadFailing = false;
  const yieldingNiceMs = options.startYieldingNiceSample?.pipe(
    Effect.flatMap(({ elapsed }) => Effect.sleep(window).pipe(Effect.andThen(elapsed))),
    Effect.tap(() => Effect.sync(() => void (procReadFailing = false))),
    Effect.catch((cause) => {
      // One warning per outage while queued commands repeat the reading.
      const log = procReadFailing ? Effect.logDebug : Effect.logWarning;
      procReadFailing = true;
      return log("CPU admission cannot read niced threads, so niced time counts as busy", {
        cause,
      }).pipe(Effect.as(null));
    }),
  );
  const read = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (last !== null && now - last.atMs < ttlMs) return last.saturation;
    const before = yield* sample;
    yield* Effect.sleep(window);
    const after = yield* sample;
    let shares = cpuShares(before, after);
    // Idle hosts and fully normal-priority loads need only the cheap per-core samples.
    if (
      yieldingNiceMs !== undefined &&
      shares !== null &&
      shares.busyShare >= limit &&
      shares.nicedShare > 0
    ) {
      const elapsed = yield* yieldingNiceMs;
      if (elapsed !== null) {
        shares = cpuShares(after, yield* sample, elapsed) ?? shares;
      }
    }
    const saturation: CpuSaturation | null =
      shares !== null && shares.busyShare >= limit
        ? { ...shares, limit, cores: after.length }
        : null;
    last = { atMs: yield* Clock.currentTimeMillis, saturation };
    return saturation;
  });
  return CpuAdmission.of({
    // Concurrent callers queue behind the one reading and then share its result.
    saturation: reading.withPermits(1)(read).pipe(Effect.withSpan("CpuAdmission.saturation")),
  });
});

/**
 * AgentScope launches commands at the server's nice level plus its increment. Only threads
 * with a higher nice value can provide room. Other platforms keep the aggregate busy reading.
 */
export const layer = Layer.effect(
  CpuAdmission,
  Effect.gen(function* () {
    const linux = (yield* HostProcess.Platform) === "linux";
    const sample = Effect.sync(() => cpuTimesOf(NodeOS.cpus()));
    return yield* linux
      ? make(sample, {
          startYieldingNiceSample: Effect.suspend(() =>
            startYieldingNiceSample(NodeOS.getPriority() + AGENT_NICE_INCREMENT),
          ),
        })
      : make(sample);
  }),
);

/** Tests: the CPUs always read `saturation`; the default has room. */
export const layerTest = (saturation: CpuSaturation | null = null) =>
  Layer.succeed(CpuAdmission, CpuAdmission.of({ saturation: Effect.succeed(saturation) }));

/** The reading in a sentence, for agents and logs. */
export const describeCpuSaturation = ({
  busyShare,
  nicedShare,
  excludedShare,
  limit,
  cores,
}: CpuSaturation) =>
  `the CPUs are ${busyShare.toFixed(2)} busy across ${cores} ${cores === 1 ? "core" : "cores"}, at or over the ${limit} limit` +
  (nicedShare >= NICED_SHARE_WORTH_NAMING
    ? ` (${nicedShare.toFixed(2)} niced, ${excludedShare.toFixed(2)} excluded from the busy share as lower-priority work)`
    : "");
