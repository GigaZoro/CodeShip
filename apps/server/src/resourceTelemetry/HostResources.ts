// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's FileSystem has no statfs for free disk space.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import type { HostResourcesSnapshot, HostSpaceUsage } from "@t3tools/contracts/resourceTelemetry";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";

export class HostResources extends Context.Service<
  HostResources,
  { readonly read: Effect.Effect<HostResourcesSnapshot> }
>()("t3/resourceTelemetry/HostResources") {}

function readCpu() {
  const cpus = NodeOS.cpus();
  const cpu = cpus.reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 },
  );
  return { ...cpu, count: cpus.length };
}

interface VmStatPages {
  readonly pageSize: number;
  readonly free: number;
  readonly inactive: number;
  readonly speculative: number;
  readonly occupiedByCompressor: number;
}

export function parseVmStat(output: string): VmStatPages | null {
  const pages = (label: string) => {
    const value = new RegExp(`^${label}:\\s+(\\d+)\\.`, "m").exec(output)?.[1];
    return value === undefined ? null : Number(value);
  };
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1] ?? Number.NaN);
  const free = pages("Pages free");
  const inactive = pages("Pages inactive");
  const speculative = pages("Pages speculative");
  const occupiedByCompressor = pages("Pages occupied by compressor");
  if (
    !(pageSize > 0) ||
    free === null ||
    inactive === null ||
    speculative === null ||
    occupiedByCompressor === null
  ) {
    return null;
  }
  return { pageSize, free, inactive, speculative, occupiedByCompressor };
}

function darwinAvailableMemory(output: string): number | null {
  const pages = parseVmStat(output);
  if (pages === null) return null;
  // vm_stat excludes speculative from free; add it once, without overlapping purgeable pages.
  const available = (pages.free + pages.inactive + pages.speculative) * pages.pageSize;
  return Number.isSafeInteger(available) ? available : null;
}

function loadAverage(): readonly [number, number, number] {
  const [one = 0, five = 0, fifteen = 0] = NodeOS.loadavg();
  return [one, five, fifteen];
}

function spaceUsage(totalBytes: number, availableBytes: number): HostSpaceUsage | null {
  if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(availableBytes)) return null;
  if (totalBytes < 0) return null;
  return { totalBytes, availableBytes: Math.min(totalBytes, Math.max(0, availableBytes)) };
}

export function parseLinuxMeminfo(output: string) {
  const bytes = (label: string) => {
    const kilobytes = new RegExp(`^${label}:\\s+(\\d+)\\s+kB$`, "m").exec(output)?.[1];
    return kilobytes === undefined ? null : Number(kilobytes) * 1024;
  };
  const swapTotal = bytes("SwapTotal");
  const swapFree = bytes("SwapFree");
  return {
    availableMemoryBytes: bytes("MemAvailable"),
    swap: swapTotal === null || swapFree === null ? null : spaceUsage(swapTotal, swapFree),
  };
}

const SWAP_UNIT_BYTES: Readonly<Record<string, number>> = {
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

/** Parses `sysctl -n vm.swapusage`: `total = 2048.00M  used = 1081.25M  free = 966.75M`. */
export function parseDarwinSwapUsage(output: string): HostSpaceUsage | null {
  const bytes = (label: string) => {
    const match = new RegExp(`\\b${label} = (\\d+(?:\\.\\d+)?)([KMGT])\\b`).exec(output);
    const unit = match ? SWAP_UNIT_BYTES[match[2]!] : undefined;
    return match && unit !== undefined ? Math.round(Number(match[1]) * unit) : null;
  };
  const total = bytes("total");
  const free = bytes("free");
  return total === null || free === null ? null : spaceUsage(total, free);
}

type StatFs = (
  path: string,
) => Promise<{ readonly blocks: number; readonly bsize: number; readonly bavail: number }>;

/** Free space on `path`'s drive, or null when it cannot be read within a second. */
export function makeDiskSpaceReader(statfs: StatFs, path: string) {
  // A hung network mount parks a libuv thread per call; reuse the stuck probe instead of stacking more.
  let inFlight: ReturnType<StatFs> | null = null;
  const probe = () =>
    (inFlight ??= statfs(path).finally(() => {
      inFlight = null;
    }));
  return Effect.tryPromise(probe).pipe(
    Effect.timeout("1 second"),
    Effect.map((stats) => spaceUsage(stats.blocks * stats.bsize, stats.bavail * stats.bsize)),
    Effect.catch((cause) =>
      Effect.logWarning("Could not read disk space", { cause }).pipe(Effect.as(null)),
    ),
  );
}

const make = Effect.fn("makeHostResources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { baseDir } = yield* ServerConfig.ServerConfig;

  const readCommand = (command: string, args: ReadonlyArray<string>) =>
    spawner.string(ChildProcess.make(command, args, { stdin: "ignore", stderr: "ignore" })).pipe(
      Effect.timeout("1 second"),
      Effect.orElseSucceed(() => ""),
    );

  const readDisk = makeDiskSpaceReader(NodeFSP.statfs, baseDir);

  const sample = Effect.fn("HostResources.sample")(function* () {
    const previousCpu = readCpu();
    yield* Effect.sleep("200 millis");
    const cpu = readCpu();
    const totalDelta = cpu.total - previousCpu.total;
    const idleDelta = cpu.idle - previousCpu.idle;
    const cpuUtilization =
      previousCpu.count === cpu.count && totalDelta > 0 && idleDelta >= 0
        ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
        : null;
    const totalMemoryBytes = NodeOS.totalmem();
    // On Windows libuv returns GlobalMemoryStatusEx.ullAvailPhys, including standby memory.
    let availableMemoryBytes = NodeOS.freemem();
    let swap: HostSpaceUsage | null = null;
    if (platform === "linux") {
      const meminfo = parseLinuxMeminfo(
        yield* fs.readFileString("/proc/meminfo").pipe(Effect.orElseSucceed(() => "")),
      );
      availableMemoryBytes = meminfo.availableMemoryBytes ?? availableMemoryBytes;
      swap = meminfo.swap;
    } else if (platform === "darwin") {
      const [vmStat, swapUsage] = yield* Effect.all(
        [
          readCommand("/usr/bin/vm_stat", []),
          readCommand("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
        ],
        { concurrency: "unbounded" },
      );
      availableMemoryBytes = darwinAvailableMemory(vmStat) ?? availableMemoryBytes;
      swap = parseDarwinSwapUsage(swapUsage);
    }
    return {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cpuUtilization,
      cpuCount: cpu.count,
      availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, availableMemoryBytes)),
      totalMemoryBytes,
      loadAverage: platform === "win32" ? null : loadAverage(),
      swap,
      disk: yield* readDisk,
      uptimeSeconds: Math.floor(NodeOS.uptime()),
    };
  });

  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "host") => sample(),
    timeToLive: "5 seconds",
  });
  return HostResources.of({ read: Cache.get(cache, "host") });
});

export const layer = Layer.effect(HostResources, make());
