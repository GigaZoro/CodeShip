import type { RuntimeMode } from "@t3tools/contracts";

import { t } from "~/i18n";
import { runtimeModeConfig } from "./runtimeModeConfig";

/** Modes that run without asking; the run chip names them even when they are the default. */
const RISKY_RUNTIME_MODES: ReadonlySet<RuntimeMode> = new Set(["full-access"]);

export type ComposerRunChipSegment =
  | { readonly kind: "mode"; readonly mode: RuntimeMode; readonly risky: boolean }
  | { readonly kind: "machine"; readonly label: string; readonly risky: true };

/**
 * What the composer's run chip adds after the model and effort: only choices that differ from
 * the defaults, plus anything that runs with more reach than the user may expect.
 */
export function resolveComposerRunChip(input: {
  readonly runtimeMode: RuntimeMode;
  readonly defaultRuntimeMode: RuntimeMode | undefined;
  /** The machine the turn runs on, when it is not this app's primary one. */
  readonly nonPrimaryMachineLabel: string | null;
}): { segments: ComposerRunChipSegment[]; accessibleDetail: string } {
  const segments: ComposerRunChipSegment[] = [];
  const risky = RISKY_RUNTIME_MODES.has(input.runtimeMode);
  if (risky || input.runtimeMode !== input.defaultRuntimeMode) {
    segments.push({ kind: "mode", mode: input.runtimeMode, risky });
  }
  if (input.nonPrimaryMachineLabel !== null) {
    segments.push({ kind: "machine", label: input.nonPrimaryMachineLabel, risky: true });
  }
  const details = [
    t("Permissions: {mode}", { mode: t(runtimeModeConfig[input.runtimeMode].label) }),
    ...(input.nonPrimaryMachineLabel !== null
      ? [t("Runs on {machine}", { machine: input.nonPrimaryMachineLabel })]
      : []),
  ];
  return { segments, accessibleDetail: details.join(", ") };
}
