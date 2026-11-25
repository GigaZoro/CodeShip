import { assert, describe, it } from "@effect/vitest";

import { heldNiceDelta, parseNicedProcessStat } from "./HeldNiceTime.ts";

/** One `/proc/<pid>/stat` line: only utime (14), stime (15), cutime (16), cstime (17), nice (19) and starttime (22) matter. */
const stat = (input: {
  name?: string;
  utime: number;
  stime: number;
  cutime?: number;
  cstime?: number;
  nice: number;
}) => {
  const fields = Array.from({ length: 50 }, () => "0");
  fields[0] = "S";
  fields[11] = String(input.utime);
  fields[12] = String(input.stime);
  fields[13] = String(input.cutime ?? 0);
  fields[14] = String(input.cstime ?? 0);
  fields[16] = String(input.nice);
  fields[19] = "777";
  return `4242 (${input.name ?? "node"}) ${fields.join(" ")}`;
};

describe("parseNicedProcessStat", () => {
  it("reads the CPU time of a process niced at or below the limit, in milliseconds", () => {
    assert.deepStrictEqual(parseNicedProcessStat(stat({ utime: 30, stime: 20, nice: 10 }), 10), {
      key: "4242:777",
      cpuMs: 500,
    });
  });

  it("counts the time of children the process already reaped", () => {
    assert.strictEqual(
      parseNicedProcessStat(stat({ utime: 1, stime: 1, cutime: 40, cstime: 8, nice: 10 }), 10)
        ?.cpuMs,
      500,
    );
  });

  it("takes a command name with spaces and parentheses whole", () => {
    assert.deepStrictEqual(
      parseNicedProcessStat(stat({ name: "a (b) c", utime: 1, stime: 1, nice: 5 }), 10),
      { key: "4242:777", cpuMs: 20 },
    );
  });

  it("leaves out processes that run at normal priority or give way to a command", () => {
    assert.isNull(parseNicedProcessStat(stat({ utime: 9, stime: 9, nice: 0 }), 10));
    assert.isNull(parseNicedProcessStat(stat({ utime: 9, stime: 9, nice: 19 }), 10));
    assert.isNull(parseNicedProcessStat("garbage", 10));
  });
});

describe("heldNiceDelta", () => {
  it("counts the time used since the first reading, whole for a process that began after it", () => {
    const before = new Map([
      ["1:1", 100],
      ["2:1", 50],
    ]);
    const after = new Map([
      ["1:1", 160],
      ["3:1", 40],
    ]);
    // The process that ended (2:1) is not in `after`; the new one (3:1) used 40 ms in the window.
    assert.strictEqual(heldNiceDelta(before, after), 100);
  });
});
