import type { RuntimeMode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveComposerRunChip } from "./composerRunChip";

describe("resolveComposerRunChip", () => {
  it.each<{ mode: RuntimeMode; fallback: RuntimeMode | undefined; shown: boolean }>([
    { mode: "auto", fallback: "auto", shown: false },
    { mode: "approval-required", fallback: "approval-required", shown: false },
    { mode: "auto-accept-edits", fallback: "approval-required", shown: true },
    { mode: "approval-required", fallback: "auto", shown: true },
    { mode: "auto", fallback: undefined, shown: true },
  ])("names the mode only when it differs from the default: $mode", ({ mode, fallback, shown }) => {
    const chip = resolveComposerRunChip({
      runtimeMode: mode,
      defaultRuntimeMode: fallback,
      nonPrimaryMachineLabel: null,
    });
    expect(chip.segments).toEqual(shown ? [{ kind: "mode", mode, risky: false }] : []);
  });

  it("always shows full access and a non-primary machine, emphasised, even as the default", () => {
    const chip = resolveComposerRunChip({
      runtimeMode: "full-access",
      defaultRuntimeMode: "full-access",
      nonPrimaryMachineLabel: "Zoro-VPS",
    });
    expect(chip.segments).toEqual([
      { kind: "mode", mode: "full-access", risky: true },
      { kind: "machine", label: "Zoro-VPS", risky: true },
    ]);
  });

  it("keeps the mode in the accessible name when its text collapses", () => {
    const chip = resolveComposerRunChip({
      runtimeMode: "auto",
      defaultRuntimeMode: "auto",
      nonPrimaryMachineLabel: null,
    });
    expect(chip.accessibleDetail).toBe("Permissions: Auto");
  });
});
