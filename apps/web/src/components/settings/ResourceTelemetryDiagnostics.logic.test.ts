import { describe, expect, it } from "vite-plus/test";

import type { ResourceTelemetryProcess } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  formatCpuTime,
  formatSamplingStatus,
  hasLiveResourceCounters,
  visibleResourceTelemetryProcesses,
} from "./ResourceTelemetryDiagnostics.logic";

const process = (pid: number, ppid: number, depth: number): ResourceTelemetryProcess => ({
  identity: { pid, startTimeMs: pid * 1_000 },
  ppid,
  childPids: [],
  depth,
  name: `process-${pid}`,
  command: `process-${pid}`,
  status: "Running",
  category: pid === 1 ? "server" : "server-child",
  cpuPercent: 0,
  cpuTimeMs: 0,
  residentBytes: 0,
  peakResidentBytes: 0,
  virtualBytes: 0,
  ioReadBytes: 0,
  ioWriteBytes: 0,
  ioReadBytesPerSecond: 0,
  ioWriteBytesPerSecond: 0,
  ioSemantics: "storage",
  runTimeMs: 0,
  firstSeenAt: DateTime.makeUnsafe(0),
  lastSeenAt: DateTime.makeUnsafe(0),
});

describe("visibleResourceTelemetryProcesses", () => {
  it("hides descendants by parentage even when rows are not depth-first", () => {
    const processes = [
      process(1, 0, 0),
      process(10, 0, 0),
      process(2, 1, 1),
      process(11, 10, 1),
      process(3, 2, 2),
    ];

    expect(visibleResourceTelemetryProcesses(processes, new Set(["1:1000"]))).toEqual([
      processes[0],
      processes[1],
      processes[3],
    ]);
  });

  it("keeps a root row visible when its launcher is collapsed", () => {
    const processes = [process(1, 10, 0), process(2, 1, 1), process(10, 0, 0), process(11, 10, 1)];

    expect(visibleResourceTelemetryProcesses(processes, new Set(["10:10000"]))).toEqual([
      processes[0],
      processes[1],
      processes[2],
    ]);
  });
});

describe("hasLiveResourceCounters", () => {
  it.each([
    { nativeStatus: null, sampleIntervalMs: 0, expected: false },
    { nativeStatus: "unavailable", sampleIntervalMs: 0, expected: false },
    { nativeStatus: "unavailable", sampleIntervalMs: 1000, expected: false },
    { nativeStatus: "starting", sampleIntervalMs: 1000, expected: false },
    { nativeStatus: "stopped", sampleIntervalMs: 1000, expected: false },
    { nativeStatus: "healthy", sampleIntervalMs: 0, expected: false },
    { nativeStatus: "healthy", sampleIntervalMs: 1000, expected: true },
    { nativeStatus: "degraded", sampleIntervalMs: 1000, expected: true },
  ] as const)(
    "distinguishes live samples from placeholders: $nativeStatus / $sampleIntervalMs",
    ({ expected, ...input }) => {
      expect(hasLiveResourceCounters(input)).toBe(expected);
    },
  );
});

describe("formatCpuTime", () => {
  it("switches units when rounding reaches the next unit", () => {
    expect([59.94, 59.97, 3_599.7, 3_600].map((seconds) => formatCpuTime(seconds))).toEqual([
      "59.9s",
      "1m",
      "1h",
      "1h",
    ]);
  });
});

describe("formatSamplingStatus", () => {
  it("reads an idle interval as on demand rather than every 0 ms", () => {
    expect([0, 500, 2_000].map((intervalMs) => formatSamplingStatus(intervalMs))).toEqual([
      "Sampling on demand",
      "Sampling every 500 ms",
      "Sampling every 2 seconds",
    ]);
  });
});
