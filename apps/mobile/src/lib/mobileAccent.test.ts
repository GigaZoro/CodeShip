import { describe, expect, it } from "vite-plus/test";
import { ACCENT_PALETTE } from "@t3tools/shared/accentPalette";

import { applyAccentToMobileThemeVariables } from "./mobileAccent";
import { getMobileThemeVariables } from "./mobileTheme";

describe("applyAccentToMobileThemeVariables", () => {
  const base = getMobileThemeVariables("t3-chat", "dark");

  it("paints the primary, its text and the switch track with the palette hue", () => {
    const tinted = applyAccentToMobileThemeVariables(base, "orange", "dark");

    expect([
      tinted["--color-primary"],
      tinted["--color-primary-foreground"],
      tinted["--color-switch-active-track"],
    ]).toEqual([
      ACCENT_PALETTE.orange.dark.primary,
      ACCENT_PALETTE.orange.dark.primaryForeground,
      ACCENT_PALETTE.orange.dark.primary,
    ]);
  });

  it("returns the theme's variables unchanged for theme", () => {
    expect(applyAccentToMobileThemeVariables(base, "theme", "dark")).toBe(base);
  });
});
