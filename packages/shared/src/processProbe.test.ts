import { assert, it } from "@effect/vitest";

import { isProcessAlive, probeProcess } from "./processProbe.ts";

const throwing = (cause: unknown) => () => {
  throw cause;
};

it("calls a process gone only when signal 0 reports ESRCH", () => {
  const missing = Object.assign(new Error("missing"), { code: "ESRCH" });
  const denied = Object.assign(new Error("denied"), { code: "EPERM" });
  const failed = Object.assign(new Error("failed"), { code: "EIO" });

  assert.deepStrictEqual(probeProcess(4321, throwing(missing)), { state: "gone", code: "ESRCH" });
  assert.deepStrictEqual(probeProcess(4321, throwing(denied)), { state: "alive" });
  assert.deepStrictEqual(probeProcess(4321, throwing(failed)), { state: "unknown", code: "EIO" });
  assert.deepStrictEqual(
    probeProcess(4321, () => true),
    { state: "alive" },
  );
  for (const pid of [0, 2 ** 31, 1.5]) {
    assert.deepStrictEqual(
      probeProcess(pid, () => true),
      { state: "gone", code: "invalid pid" },
    );
  }
  for (const cause of [undefined, null, "unknown failure"]) {
    assert.strictEqual(probeProcess(4321, throwing(cause)).state, "unknown");
    assert.isTrue(isProcessAlive(4321, throwing(cause)));
  }
  assert.isFalse(isProcessAlive(4321, throwing(missing)));
});
