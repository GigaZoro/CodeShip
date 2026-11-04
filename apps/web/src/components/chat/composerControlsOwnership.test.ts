import { describe, expect, it } from "vite-plus/test";

import { resolveComposerControlsOwnership } from "./composerControlsOwnership";

describe("resolveComposerControlsOwnership", () => {
  it("shows a labelled chip that stays in the row while there is room", () => {
    expect(
      resolveComposerControlsOwnership({ collapsed: false, measuredHiddenBlockCount: 0 }),
    ).toMatchObject({ accessDisplay: "label", hiddenBlockIds: [] });
  });

  it("shows the chip as an icon in the compacted row", () => {
    expect(
      resolveComposerControlsOwnership({ collapsed: true, measuredHiddenBlockCount: 0 })
        .accessDisplay,
    ).toBe("icon");
  });

  it("moves the chip into the overflow menu when the measurement has no room for it", () => {
    expect(
      resolveComposerControlsOwnership({ collapsed: true, measuredHiddenBlockCount: 1 }),
    ).toMatchObject({ hiddenBlockIds: ["mode"], hiddenBlockCount: 1 });
  });
});
