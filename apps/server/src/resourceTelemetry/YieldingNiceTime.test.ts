import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { startYieldingNiceSample } from "./YieldingNiceTime.ts";

interface CpuStat {
  readonly userTicks: number;
  readonly nice: number;
  readonly start?: number;
  readonly threads?: number;
  readonly permittedCaps?: string;
  readonly systemAndChildTicks?: number;
  readonly policy?: number;
}

function statLine(tid: string, stat: CpuStat) {
  const fields = Array.from({ length: 50 }, () => "0");
  fields[0] = "R";
  fields[11] = String(stat.userTicks);
  fields[12] = String(stat.systemAndChildTicks ?? 0);
  fields[13] = String(stat.systemAndChildTicks ?? 0);
  fields[14] = String(stat.systemAndChildTicks ?? 0);
  fields[16] = String(stat.nice);
  fields[17] = String(stat.threads ?? 1);
  fields[19] = String(stat.start ?? 777);
  fields[38] = String(stat.policy ?? 0);
  return `${tid} (worker (pool)) ${fields.join(" ")}\n`;
}

const makeProc = Effect.fn("YieldingNiceTimeTest.makeProc")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-yielding-nice-" });
  const processDir = path.join(root, "42");
  yield* fs.makeDirectory(processDir);
  const setPriorityLimits = (nice: string, realtime = "0") =>
    fs.writeFileString(
      path.join(processDir, "limits"),
      `Max nice priority          0                    ${nice}\nMax realtime priority      0                    ${realtime}\n`,
    );
  yield* setPriorityLimits("0");
  const threadDir = (tid: string) => path.join(processDir, "task", tid);
  const writeThread = Effect.fn("YieldingNiceTimeTest.writeThread")(function* (
    tid: string,
    stat: CpuStat,
  ) {
    yield* fs.makeDirectory(threadDir(tid), { recursive: true });
    yield* fs.writeFileString(path.join(threadDir(tid), "stat"), statLine(tid, stat));
    yield* fs.writeFileString(
      path.join(threadDir(tid), "status"),
      `CapPrm:\t${stat.permittedCaps ?? "0000000000000000"}\n`,
    );
  });
  return {
    root,
    writeThread,
    setPriorityLimits,
    writeProcessStat: (stat: CpuStat) =>
      fs.writeFileString(path.join(root, "42", "stat"), statLine("42", stat)),
    removeThread: (tid: string) => fs.remove(threadDir(tid), { recursive: true }),
    missingProc: path.join(root, "missing"),
  };
});

it.layer(NodeServices.layer)("Linux yielding CPU time", (it) => {
  it.effect("credits only user time of lower-priority threads in a mixed-priority process", () =>
    Effect.gen(function* () {
      const proc = yield* makeProc();
      yield* proc.writeThread("42", { userTicks: 1, nice: 19, threads: 3 });
      yield* proc.writeThread("43", { userTicks: 2, nice: 10 });
      yield* proc.writeThread("44", { userTicks: 3, nice: 19, policy: 1 });
      yield* proc.writeProcessStat({ userTicks: 6, nice: 19, threads: 3 });

      const { elapsed } = yield* startYieldingNiceSample(10, proc.root);
      yield* proc.writeThread("42", {
        userTicks: 12,
        nice: 19,
        threads: 3,
        systemAndChildTicks: 50,
      });
      yield* proc.writeThread("43", { userTicks: 52, nice: 10 });
      yield* proc.writeThread("44", { userTicks: 53, nice: 19, policy: 1 });
      yield* proc.writeProcessStat({ userTicks: 117, nice: 19, threads: 3 });

      assert.strictEqual(yield* elapsed, 100);
    }),
  );

  it.effect("credits no historical worker CPU when exec replaces the group leader", () =>
    Effect.gen(function* () {
      const proc = yield* makeProc();
      yield* proc.writeThread("42", { userTicks: 1, nice: 19, threads: 2 });
      yield* proc.writeThread("43", { userTicks: 53, nice: 10, threads: 2 });
      const { elapsed } = yield* startYieldingNiceSample(10, proc.root);

      // Linux gives the execing worker its former leader's TID and start time.
      yield* proc.removeThread("43");
      yield* proc.writeThread("42", { userTicks: 53, nice: 19 });
      assert.strictEqual(yield* elapsed, 0);
    }),
  );

  it.effect(
    "credits only threads whose privileges and hard limits keep them below the incoming priority",
    () =>
      Effect.gen(function* () {
        const proc = yield* makeProc();
        for (const [nice, realtime, permittedCaps, expectedMs] of [
          ["9", "0", "0000000000000000", 120],
          ["10", "0", "0000000000000000", 0],
          ["unlimited", "0", "0000000000000000", 0],
          ["unknown", "0", "0000000000000000", 0],
          ["0", "1", "0000000000000000", 0],
          ["0", "0", "0000000000800000", 0],
          ["0", "0", "0000000001000000", 0],
        ] as const) {
          yield* proc.setPriorityLimits(nice, realtime);
          yield* proc.writeThread("42", { userTicks: 1, nice: 19, permittedCaps });
          const { elapsed } = yield* startYieldingNiceSample(10, proc.root);
          yield* proc.writeThread("42", { userTicks: 14, nice: 19, permittedCaps });
          assert.strictEqual(yield* elapsed, expectedMs);
        }
      }),
  );

  it.effect("leaves new, vanished, reused, and reniced threads unattributed", () =>
    Effect.gen(function* () {
      const proc = yield* makeProc();
      yield* proc.writeThread("42", { userTicks: 1, nice: 19 });
      yield* proc.writeThread("43", { userTicks: 1, nice: 19 });
      yield* proc.writeThread("44", { userTicks: 1, nice: 19 });

      const { elapsed } = yield* startYieldingNiceSample(10, proc.root);
      yield* proc.removeThread("42");
      yield* proc.writeThread("43", { userTicks: 40, nice: 19, start: 888 });
      yield* proc.writeThread("44", { userTicks: 40, nice: 18 });
      yield* proc.writeThread("45", { userTicks: 40, nice: 19 });

      assert.strictEqual(yield* elapsed, 0);
    }),
  );

  it.effect("reports an unreadable proc root to the caller", () =>
    Effect.gen(function* () {
      const { missingProc } = yield* makeProc();

      const failure = yield* Effect.flip(startYieldingNiceSample(10, missingProc));

      assert.strictEqual(failure._tag, "YieldingNiceTimeUnreadable");
    }),
  );
});
