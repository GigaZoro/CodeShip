import { describe, expect, it } from "vite-plus/test";

import { shouldRecedeThreadRow, threadRowLastKnownMachine } from "./thread-row-emphasis";

describe("threadRowLastKnownMachine", () => {
  it.each([
    ["working", "offline", "offline"],
    ["approval", "reconnecting", "reconnecting"],
    ["input", "error", "error"],
    ["working", "connecting", null],
    ["working", "live", null],
    ["failed", "offline", null],
    ["working", undefined, null],
  ] as const)("%s on a %s machine is last known on %s", (status, machine, expected) => {
    expect(threadRowLastKnownMachine(status, machine)).toBe(expected);
  });
});

describe("shouldRecedeThreadRow", () => {
  it("recedes any unselected row from an unreachable machine", () => {
    expect(
      shouldRecedeThreadRow({ status: "input", selected: false, machineUnreachable: true }),
    ).toBe(true);
    expect(
      shouldRecedeThreadRow({ status: "input", selected: true, machineUnreachable: true }),
    ).toBe(false);
  });
});
