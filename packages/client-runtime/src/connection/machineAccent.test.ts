import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { machineAccent } from "./machineAccent.ts";

describe("machineAccent", () => {
  it("gives same-named machines their own colours from their ids", () => {
    const colors = new Set(
      ["env-a", "env-b", "env-c", "env-d"].map(
        (id) => machineAccent(EnvironmentId.make(id), "Zoro-PC").color,
      ),
    );
    expect(colors.size).toBeGreaterThan(1);
    expect(machineAccent(EnvironmentId.make("env-a"), "Renamed")).toEqual({
      color: machineAccent(EnvironmentId.make("env-a"), "Zoro-PC").color,
      initial: "R",
    });
  });

  it.each([
    ["zoro-PC", "Z"],
    ["  (mac) studio", "M"],
    ["2nd box", "2"],
    ["Ноутбук", "Н"],
    ["---", "?"],
  ])("uses the first letter or digit of %j", (label, initial) => {
    expect(machineAccent(EnvironmentId.make("env"), label).initial).toBe(initial);
  });
});
