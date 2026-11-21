import { assert, describe, it } from "@effect/vitest";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as EventLoopMonitor from "./EventLoopMonitor.ts";

const ms = (value: number) => value * 1e6;

// Node reports a stall of S as a gap of up to S + 1 s, the histogram resolution.
const stalled: EventLoopMonitor.EventLoopReadings = {
  delayMaxNs: ms(5_950),
  activeMs: 6_200,
  utilization: 0.176,
  usage: {
    userCPUTime: 310_400,
    systemCPUTime: 95_600,
    majorPageFault: 8_412,
    minorPageFault: 20_031,
    involuntaryContextSwitches: 57,
  },
  rssBytes: 1536 * 1024 * 1024,
  heapUsedBytes: 512 * 1024 * 1024,
  elapsedMs: 30_000,
  loadAverage: 219.43,
  cpuCount: 18,
};

describe("EventLoopMonitor", () => {
  it("ignores delay the loop spent idle, such as a system sleep", () => {
    const asleep: EventLoopMonitor.EventLoopReadings = {
      ...stalled,
      delayMaxNs: ms(600_000),
      activeMs: 900,
    };
    assert.isUndefined(EventLoopMonitor.stallMs(asleep));
    assert.strictEqual(EventLoopMonitor.stallMs({ ...asleep, activeMs: 600_000 }), 599_000);
  });

  it.effect("writes overlapping span names to the stall log", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-event-loop-monitor" });
      const filePath = path.join(dir, "event-loop-stalls.ndjson");
      const context = yield* Layer.build(
        EventLoopMonitor.layerWith(Effect.succeed(Effect.succeed(stalled)), {
          filePath,
          maxBytes: 64 * 1024,
        }).pipe(
          Layer.provide(
            Layer.succeed(EventLoopMonitor.StallSpanNames, () => ["UsageService.scanSummary"]),
          ),
        ),
      );
      yield* TestClock.adjust("30 seconds");
      yield* EventLoopMonitor.EventLoopMonitor.pipe(
        Effect.flatMap((monitor) => monitor.latestNoticeableStall),
        Effect.provideContext(context),
      );
      const log = yield* fs.readFileString(filePath);
      const decode = Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ spanNames: Schema.Array(Schema.String) })),
      );
      assert.deepStrictEqual((yield* decode(log)).spanNames, ["UsageService.scanSummary"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
