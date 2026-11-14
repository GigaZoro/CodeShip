import * as NodeOS from "node:os";
import type {
  AutomatedStartMemoryGuard,
  MemoryPressureLevel,
  MemoryShortage,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerSettings from "../serverSettings.ts";
import { parseVmStat } from "./HostResources.ts";

const GIB = 1024 ** 3;

/** One look at a machine's memory, as raw as its probes gave it; a failed probe leaves its part out. */
export const MemorySample = Schema.Struct({
  platform: Schema.String,
  totalBytes: Schema.Number,
  /** `os.freemem()`: on Windows, free plus standby memory. */
  freeBytes: Schema.Number,
  vmStat: Schema.optional(Schema.String),
  /** `sysctl -n kern.memorystatus_vm_pressure_level`. */
  pressureLevel: Schema.optional(Schema.String),
  meminfo: Schema.optional(Schema.String),
});
export type MemorySample = typeof MemorySample.Type;

const decodeSampleJson = Schema.decodeUnknownOption(Schema.fromJsonString(MemorySample));

/** Takes a `MemorySample` with the device host's own Node, so its memory is judged, not this machine's. */
export const SAMPLE_SCRIPT = `const os = require("node:os");
const { spawnSync } = require("node:child_process");
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
  return result.status === 0 ? result.stdout : undefined;
};
const sample = { platform: process.platform, totalBytes: os.totalmem(), freeBytes: os.freemem() };
if (process.platform === "darwin") {
  sample.vmStat = run("/usr/bin/vm_stat", []);
  sample.pressureLevel = run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]);
}
if (process.platform === "linux") {
  try { sample.meminfo = require("node:fs").readFileSync("/proc/meminfo", "utf8"); } catch {}
}
process.stdout.write(JSON.stringify(sample));`;

const PRESSURE_LEVELS: Readonly<Record<string, MemoryPressureLevel>> = {
  "1": "normal",
  "2": "warn",
  "4": "critical",
};

/**
 * Null while memory leaves room, or when the sample cannot tell: a failed probe never holds a start
 * back. On macOS only the compressor's share and the kernel's pressure level count. The pressure
 * level alone flaps back to normal between warn readings, so the share is what holds the gate shut.
 */
export function memoryShortage(
  sample: MemorySample,
  guard: AutomatedStartMemoryGuard,
): MemoryShortage | null {
  if (!guard.enabled || !(sample.totalBytes > 0)) return null;
  const totalBytes = Math.round(sample.totalBytes);
  if (sample.platform === "darwin") {
    const pressure = PRESSURE_LEVELS[sample.pressureLevel?.trim() ?? ""] ?? null;
    const pressing = pressure === "warn" || pressure === "critical" ? pressure : null;
    const pages = sample.vmStat === undefined ? null : parseVmStat(sample.vmStat);
    if (pages === null) {
      return pressing === null ? null : { kind: "pressure", totalBytes, pressure: pressing };
    }
    const compressorBytes = pages.occupiedByCompressor * pages.pageSize;
    if (compressorBytes / totalBytes < guard.compressorShare && pressing === null) return null;
    return {
      kind: "compressor",
      totalBytes,
      compressorBytes,
      compressorShareLimit: guard.compressorShare,
      pressure,
    };
  }
  let available = sample.freeBytes;
  if (sample.platform === "linux") {
    // Linux free memory leaves out the page cache it reclaims on demand, so it is no stand-in.
    const memAvailableKiB = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(sample.meminfo ?? "")?.[1];
    if (memAvailableKiB === undefined) return null;
    available = Number(memAvailableKiB) * 1024;
  }
  if (!Number.isFinite(available) || available < 0) return null;
  const availableBytes = Math.round(available);
  const reserveBytes = Math.round(guard.reserveGiB * GIB);
  if (availableBytes >= reserveBytes) return null;
  return { kind: "available", totalBytes, availableBytes, reserveBytes };
}

const gib = (bytes: number) => `${Number((bytes / GIB).toFixed(1))} GiB`;

/** The reading in a sentence, for agents and logs. */
export function describeMemoryShortage(shortage: MemoryShortage): string {
  if (shortage.kind === "available") {
    return `${gib(shortage.availableBytes)} of ${gib(shortage.totalBytes)} is available, under the ${gib(shortage.reserveBytes)} reserve`;
  }
  if (shortage.kind === "pressure") return `memory pressure is ${shortage.pressure}`;
  const share = (shortage.compressorBytes / shortage.totalBytes).toFixed(2);
  const compressor = `the memory compressor occupies ${gib(shortage.compressorBytes)}, ${share} of ${gib(shortage.totalBytes)} (the limit is ${shortage.compressorShareLimit})`;
  return shortage.pressure === "warn" || shortage.pressure === "critical"
    ? `memory pressure is ${shortage.pressure}, and ${compressor}`
    : compressor;
}

export class MemoryAdmission extends Context.Service<
  MemoryAdmission,
  {
    /** This machine's shortage, or null while an automated start may go ahead. */
    readonly shortage: Effect.Effect<MemoryShortage | null>;
    /** Another machine's shortage, sampled by running `node -e SAMPLE_SCRIPT` there. */
    readonly shortageOn: (
      runNode: (
        args: ReadonlyArray<string>,
      ) => Effect.Effect<{ readonly code: number; readonly stdout: string }>,
    ) => Effect.Effect<MemoryShortage | null>;
  }
>()("t3/resourceTelemetry/MemoryAdmission") {}

const make = Effect.fn("makeMemoryAdmission")(function* (sampleHere: Effect.Effect<MemorySample>) {
  const settings = yield* ServerSettings.ServerSettingsService;
  // A setting that cannot be read never holds a start back either.
  const guard = settings.getSettings.pipe(
    Effect.map((current) => current.automatedStartMemoryGuard),
    Effect.tapError((cause) =>
      Effect.logWarning("Could not read the memory guard setting", { cause }),
    ),
    Effect.option,
  );
  const judge = Effect.fnUntraced(function* (sample: Effect.Effect<MemorySample | null>) {
    const current = yield* guard;
    if (Option.isNone(current) || !current.value.enabled) return null;
    const taken = yield* sample;
    return taken === null ? null : memoryShortage(taken, current.value);
  });
  return MemoryAdmission.of({
    shortage: judge(sampleHere).pipe(Effect.withSpan("MemoryAdmission.shortage")),
    shortageOn: Effect.fn("MemoryAdmission.shortageOn")(function* (runNode) {
      return yield* judge(
        runNode(["-e", SAMPLE_SCRIPT]).pipe(
          Effect.map((result) =>
            result.code === 0 ? Option.getOrNull(decodeSampleJson(result.stdout)) : null,
          ),
          Effect.tap((sample) =>
            sample === null
              ? Effect.logWarning("Could not read a device host's memory")
              : Effect.void,
          ),
        ),
      );
    }),
  });
});

const sampleThisMachine = Effect.fn("MemoryAdmission.sampleThisMachine")(function* () {
  const platform = yield* HostProcess.Platform;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const probe = (command: string, args: ReadonlyArray<string>) =>
    spawner.string(ChildProcess.make(command, args, { stdin: "ignore", stderr: "ignore" })).pipe(
      // A machine that is already swapping starts processes slowly, and a timeout admits the start.
      Effect.timeout("5 seconds"),
      Effect.tapError((cause) =>
        Effect.logWarning("Could not read this machine's memory", { command, cause }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
  return Effect.gen(function* () {
    const base = { platform, totalBytes: NodeOS.totalmem(), freeBytes: NodeOS.freemem() };
    if (platform === "darwin") {
      const [vmStat, pressureLevel] = yield* Effect.all(
        [
          probe("/usr/bin/vm_stat", []),
          probe("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
        ],
        { concurrency: 2 },
      );
      return {
        ...base,
        ...(vmStat === undefined ? {} : { vmStat }),
        ...(pressureLevel === undefined ? {} : { pressureLevel }),
      };
    }
    if (platform === "linux") {
      const meminfo = yield* fs
        .readFileString("/proc/meminfo")
        .pipe(Effect.orElseSucceed(() => undefined));
      return meminfo === undefined ? base : { ...base, meminfo };
    }
    return base;
  });
});

export const layer = Layer.effect(
  MemoryAdmission,
  Effect.gen(function* () {
    return yield* make(yield* sampleThisMachine());
  }),
);

/** Tests: this machine always reads `sample`, judged by the setting in place. */
export const layerFromSample = (sample: MemorySample) =>
  Layer.effect(MemoryAdmission, make(Effect.succeed(sample)));

/** Tests: every machine reports `shortage`; the default admits every start. */
export const layerTest = (shortage: MemoryShortage | null = null) =>
  Layer.succeed(
    MemoryAdmission,
    MemoryAdmission.of({
      shortage: Effect.succeed(shortage),
      shortageOn: Effect.fn("MemoryAdmission.shortageOn")(function* () {
        return shortage;
      }),
    }),
  );
