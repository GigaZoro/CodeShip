import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AutomatedStartMemoryGuard } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerSettings from "../serverSettings.ts";
import { parseVmStat } from "./HostResources.ts";
import {
  describeMemoryShortage,
  MemoryAdmission,
  type MemorySample,
  MemorySample as MemorySampleSchema,
  layerFromSample,
  memoryShortage,
  SAMPLE_SCRIPT,
} from "./MemoryAdmission.ts";

const GIB = 1024 ** 3;
const TOTAL_24_GIB = 24 * GIB;
const defaultGuard = Schema.decodeSync(AutomatedStartMemoryGuard)({});
const decodeSampleJson = Schema.decodeUnknownSync(Schema.fromJsonString(MemorySampleSchema));

const vmStat = (pages: {
  readonly free: number;
  readonly active: number;
  readonly inactive: number;
  readonly speculative: number;
  readonly wired: number;
  readonly fileBacked: number;
  readonly anonymous: number;
  readonly compressor: number;
}) => `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                 ${pages.free}.
Pages active:                            ${pages.active}.
Pages inactive:                          ${pages.inactive}.
Pages speculative:                         ${pages.speculative}.
Pages throttled:                              0.
Pages wired down:                        ${pages.wired}.
Pages purgeable:                              0.
"Translation faults":                 912843021.
Pages copy-on-write:                   41239012.
Pages zero filled:                    401293812.
Pages reactivated:                     91238123.
Pages purged:                           1238123.
File-backed pages:                         ${pages.fileBacked}.
Anonymous pages:                         ${pages.anonymous}.
Pages stored in compressor:             2412931.
Pages occupied by compressor:            ${pages.compressor}.
Decompressions:                        81239123.
Compressions:                          91238123.
Pageins:                               12381238.
Pageouts:                                 12381.
Swapins:                                      0.
Swapouts:                                     0.
`;

/** MacBook-Pro-Andrii at the 2026-11-13 09:55Z kernel panic. */
const panicSample: MemorySample = {
  platform: "darwin",
  totalBytes: TOTAL_24_GIB,
  freeBytes: 908 * 16384,
  vmStat: vmStat({
    free: 908,
    active: 222691,
    inactive: 219336,
    speculative: 3354,
    wired: 208782,
    fileBacked: 9252,
    anonymous: 436129,
    compressor: 873905,
  }),
  pressureLevel: "1\n",
};

/** The same machine on a normal day ("i use only 7 gb of ram"); free, active and inactive are filler. */
const normalDaySample: MemorySample = {
  platform: "darwin",
  totalBytes: TOTAL_24_GIB,
  freeBytes: 20000 * 16384,
  vmStat: vmStat({
    free: 20000,
    active: 300000,
    inactive: 280000,
    speculative: 2000,
    wired: 235930,
    fileBacked: 120000,
    anonymous: 465306,
    compressor: 484966,
  }),
  pressureLevel: "1\n",
};

const linuxSample = (memAvailableKiB: number): MemorySample => ({
  platform: "linux",
  totalBytes: 8 * GIB,
  freeBytes: 64 * 1024 ** 2,
  meminfo: `MemTotal:        8388608 kB\nMemFree:           65536 kB\nMemAvailable:    ${memAvailableKiB} kB\n`,
});

describe("memoryShortage", () => {
  it("refuses at the panic reading, which macOS still called normal pressure", () => {
    assert.deepStrictEqual(memoryShortage(panicSample, defaultGuard), {
      kind: "compressor",
      totalBytes: TOTAL_24_GIB,
      compressorBytes: 873905 * 16384,
      compressorShareLimit: 0.35,
      pressure: "normal",
    });
  });

  it("admits the normal 7 GB day, where compressed memory is not counted as used", () => {
    assert.strictEqual(memoryShortage(normalDaySample, defaultGuard), null);
  });

  it("refuses at warn or critical pressure even when the compressor share is low", () => {
    for (const [level, pressure] of [
      ["2", "warn"],
      ["4", "critical"],
    ] as const) {
      const shortage = memoryShortage({ ...normalDaySample, pressureLevel: level }, defaultGuard);
      assert.strictEqual(shortage?.kind === "compressor" ? shortage.pressure : null, pressure);
    }
  });

  it("refuses at critical pressure when vm_stat cannot be read", () => {
    assert.deepStrictEqual(
      memoryShortage({ ...normalDaySample, vmStat: undefined, pressureLevel: "4\n" }, defaultGuard),
      { kind: "pressure", totalBytes: TOTAL_24_GIB, pressure: "critical" },
    );
  });

  it("refuses on Linux when MemAvailable is under the reserve, and admits above it", () => {
    assert.deepStrictEqual(memoryShortage(linuxSample(1024 * 1024), defaultGuard), {
      kind: "available",
      totalBytes: 8 * GIB,
      availableBytes: GIB,
      reserveBytes: 2 * GIB,
    });
    assert.strictEqual(memoryShortage(linuxSample(3 * 1024 * 1024), defaultGuard), null);
  });

  it("judges other platforms by free memory", () => {
    const windows: MemorySample = { platform: "win32", totalBytes: 16 * GIB, freeBytes: GIB };
    assert.strictEqual(memoryShortage(windows, defaultGuard)?.kind, "available");
  });

  it("never refuses when it cannot tell, or when the guard is off", () => {
    assert.strictEqual(memoryShortage({ ...panicSample, vmStat: "garbage" }, defaultGuard), null);
    assert.strictEqual(memoryShortage({ ...panicSample, vmStat: undefined }, defaultGuard), null);
    // 64 MiB free, but without MemAvailable the reclaimable cache is unknown.
    assert.strictEqual(
      memoryShortage({ ...linuxSample(0), meminfo: "MemTotal: 8388608 kB\n" }, defaultGuard),
      null,
    );
    assert.strictEqual(memoryShortage(panicSample, { ...defaultGuard, enabled: false }), null);
  });
});

describe("describeMemoryShortage", () => {
  it("names the reading and the limit it crossed", () => {
    const panic = memoryShortage(panicSample, defaultGuard);
    const warn = memoryShortage({ ...normalDaySample, pressureLevel: "2" }, defaultGuard);
    const linux = memoryShortage(linuxSample(1024 * 1024), defaultGuard);
    const pressureOnly = memoryShortage(
      { ...normalDaySample, vmStat: undefined, pressureLevel: "2" },
      defaultGuard,
    );
    assert.deepStrictEqual(
      [panic, warn, linux, pressureOnly].map((shortage) =>
        shortage === null ? null : describeMemoryShortage(shortage),
      ),
      [
        "the memory compressor occupies 13.3 GiB, 0.56 of 24 GiB (the limit is 0.35)",
        "memory pressure is warn, and the memory compressor occupies 7.4 GiB, 0.31 of 24 GiB (the limit is 0.35)",
        "1 GiB of 8 GiB is available, under the 2 GiB reserve",
        "memory pressure is warn",
      ],
    );
  });
});

describe("MemoryAdmission", () => {
  it.effect("judges by the machine's own setting", () =>
    Effect.gen(function* () {
      const shortage = (overrides: Parameters<typeof ServerSettings.layerTest>[0]) =>
        Effect.gen(function* () {
          return yield* (yield* MemoryAdmission).shortage;
        }).pipe(
          Effect.provide(
            layerFromSample(panicSample).pipe(Layer.provide(ServerSettings.layerTest(overrides))),
          ),
        );
      assert.strictEqual((yield* shortage({}))?.kind, "compressor");
      assert.strictEqual(
        yield* shortage({ automatedStartMemoryGuard: { compressorShare: 0.6 } }),
        null,
      );
      assert.strictEqual(yield* shortage({ automatedStartMemoryGuard: { enabled: false } }), null);
    }),
  );

  it.effect("judges a device host by the sample its script prints", () =>
    Effect.gen(function* () {
      const admission = yield* MemoryAdmission;
      const printed = (code: number, stdout: string) => () => Effect.succeed({ code, stdout });
      assert.strictEqual(
        (yield* admission.shortageOn(printed(0, JSON.stringify(panicSample))))?.kind,
        "compressor",
      );
      assert.strictEqual(yield* admission.shortageOn(printed(0, "node: not found")), null);
      assert.strictEqual(yield* admission.shortageOn(printed(127, "")), null);
    }).pipe(
      Effect.provide(
        layerFromSample(normalDaySample).pipe(Layer.provide(ServerSettings.layerTest())),
      ),
    ),
  );

  it.live("the device host script prints a sample of the machine it runs on", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const platform = yield* HostProcess.Platform;
      const stdout = yield* spawner.string(
        ChildProcess.make(yield* HostProcess.ExecutablePath, ["-e", SAMPLE_SCRIPT], {
          stdin: "ignore",
        }),
      );
      const sample = decodeSampleJson(stdout);
      assert.strictEqual(sample.platform, platform);
      assert.strictEqual(sample.totalBytes, NodeOS.totalmem());
      if (platform === "darwin") {
        assert.notStrictEqual(parseVmStat(sample.vmStat ?? ""), null);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
