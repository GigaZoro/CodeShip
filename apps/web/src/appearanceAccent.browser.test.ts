import { MIN_INTERFACE_FONT_SIZE } from "@t3tools/contracts/settings";
import { ACCENT_PALETTE } from "@t3tools/shared/accentPalette";
import { OCEAN_THEME, getThemeColorsForAppearance } from "@t3tools/shared/themePalettes";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { applyAccentColor } from "./appearanceAccent";
import { applyThemePalette } from "./themePalette";

const root = document.documentElement;
const token = (name: string) => getComputedStyle(root).getPropertyValue(name).trim();
const ACCENT_TOKENS = [
  "--primary",
  "--primary-foreground",
  "--ring",
  "--message-action",
  "--message-action-foreground",
  "--message-action-hover",
] as const;
const readAccentTokens = () => ACCENT_TOKENS.map(token);

/** Runs `check` with Ocean applied the way the app applies it, then puts the root back. */
function withOcean(mode: "light" | "dark", check: () => void): void {
  const style = root.getAttribute("style");
  const wasDark = root.classList.contains("dark");
  applyThemePalette(OCEAN_THEME.id, mode);
  root.classList.toggle("dark", mode === "dark");
  try {
    check();
  } finally {
    delete root.dataset.themeId;
    delete root.dataset.accentColor;
    delete root.dataset.interfaceDensity;
    root.classList.toggle("dark", wasDark);
    if (style === null) root.removeAttribute("style");
    else root.setAttribute("style", style);
  }
}

describe("applyAccentColor", () => {
  it.each(["light", "dark"] as const)(
    "lays the hue over a theme's primary and ring in %s",
    (mode) => {
      withOcean(mode, () => {
        applyAccentColor(root, "violet");

        expect(token("--primary")).toBe(ACCENT_PALETTE.violet[mode].primary);
        expect(token("--primary-foreground")).toBe(ACCENT_PALETTE.violet[mode].primaryForeground);
        expect(token("--ring")).toBe(ACCENT_PALETTE.violet[mode].primary);
      });
    },
  );

  it.each(["light", "dark"] as const)(
    "returns to the theme's own tokens in %s when set back to theme",
    (mode) => {
      withOcean(mode, () => {
        const themeTokens = readAccentTokens();
        applyAccentColor(root, "teal");
        expect(readAccentTokens()).not.toEqual(themeTokens);

        applyAccentColor(root, "theme");

        expect(token("--primary")).toBe(
          getThemeColorsForAppearance(OCEAN_THEME, mode)?.messageAction,
        );
        expect(readAccentTokens()).toEqual(themeTokens);
        expect(root.dataset.accentColor).toBeUndefined();
        expect(root.style.getPropertyValue("--accent-light-primary")).toBe("");
      });
    },
  );
});

describe("interface density tokens", () => {
  it.each(["--sidebar-thread-row-height", "--sidebar-folder-header-height"])(
    "keep %s at 24px or more at the smallest interface font, compact or not",
    (variable) => {
      withOcean("light", () => {
        const probe = document.createElement("div");
        probe.style.height = `var(${variable})`;
        document.body.append(probe);
        root.style.fontSize = `${MIN_INTERFACE_FONT_SIZE}px`;
        try {
          const heights = (["comfortable", "compact"] as const).map((density) => {
            root.dataset.interfaceDensity = density;
            return probe.getBoundingClientRect().height;
          });
          expect(Math.min(...heights)).toBeGreaterThanOrEqual(24);
        } finally {
          probe.remove();
        }
      });
    },
  );
});
