import { describe, expect, it } from "vite-plus/test";

import { resolveRestingComposerControlsLayout } from "./composerFooterLayout";

describe("resolveRestingComposerControlsLayout", () => {
  it("hides the run chip once its narrowest width no longer fits", () => {
    expect(resolveRestingComposerControlsLayout({ minimumWidth: 120, hostWidth: 120 })).toEqual({
      visible: true,
    });
    expect(resolveRestingComposerControlsLayout({ minimumWidth: 120, hostWidth: 119 })).toEqual({
      visible: false,
    });
  });

  it("settles when the host width jitters below a pixel at the threshold", () => {
    let layout = { visible: true };
    const settled: boolean[] = [];
    for (let index = 0; index < 10; index += 1) {
      layout = resolveRestingComposerControlsLayout({
        minimumWidth: 120,
        hostWidth: index % 2 === 0 ? 119.6 : 120.4,
        previous: layout,
      });
      if (index >= 2) settled.push(layout.visible);
    }
    expect(new Set(settled).size).toBe(1);
  });
});
