import type { AccentColor } from "@t3tools/contracts/settings";
import { ACCENT_PALETTE } from "@t3tools/shared/accentPalette";

import {
  themeColorWithContrast,
  type MobileThemeAppearance,
  type MobileThemeVariables,
} from "./mobileTheme";

/** Tints the theme's primary color with one palette hue; `theme` returns the variables as they are. */
export function applyAccentToMobileThemeVariables(
  variables: MobileThemeVariables,
  accent: AccentColor,
  appearance: MobileThemeAppearance,
): MobileThemeVariables {
  if (accent === "theme") return variables;
  const { primary, primaryForeground } = ACCENT_PALETTE[accent][appearance];
  const surfaces = [
    variables["--color-screen"],
    variables["--color-card"],
    variables["--color-grouped-card"],
  ];
  return {
    ...variables,
    "--color-primary": primary,
    "--color-primary-foreground": primaryForeground,
    "--color-primary-text": themeColorWithContrast(primary, surfaces),
    "--color-switch-active-track": primary,
    "--color-switch-active-thumb": primaryForeground,
    "--color-focus": primary,
    "--color-md-link": themeColorWithContrast(primary, variables["--color-screen"]),
  };
}
