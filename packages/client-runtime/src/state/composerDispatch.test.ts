import { describe, expect, it } from "vite-plus/test";

import {
  alternateComposerDispatchAction,
  resolveActiveTurnDefault,
  resolveComposerDispatchMode,
} from "./composerDispatch.ts";

describe("resolveActiveTurnDefault", () => {
  it.each([
    { preferred: "restart", canRestart: true, expected: "restart" },
    { preferred: "restart", canRestart: false, expected: "steer" },
    { preferred: "queue", canRestart: false, expected: "queue" },
    { preferred: "steer", canRestart: true, expected: "steer" },
  ] as const)("$preferred with canRestart=$canRestart sends as $expected", (row) => {
    expect(resolveActiveTurnDefault({ preferred: row.preferred, canRestart: row.canRestart })).toBe(
      row.expected,
    );
  });
});

describe("resolveComposerDispatchMode", () => {
  it("stops and sends by default, and queues with the modifier", () => {
    const input = { running: true, activeTurnDefault: "restart" } as const;
    expect(resolveComposerDispatchMode({ ...input, alternateModifier: false })).toBe("restart");
    expect(resolveComposerDispatchMode({ ...input, alternateModifier: true })).toBe("queue");
    expect(alternateComposerDispatchAction("restart")).toBe("queue");
  });

  it("queues while the turn cannot take input", () => {
    expect(
      resolveComposerDispatchMode({
        running: true,
        alternateModifier: false,
        activeTurnDefault: "restart",
        canSteer: false,
      }),
    ).toBe("queue");
  });
});
