import { ACCENT_PALETTE } from "@t3tools/shared/accentPalette";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { applyAccentColor } from "./appearanceAccent";

const root = document.documentElement;
const token = (name: string) => getComputedStyle(root).getPropertyValue(name).trim();

/** Runs `check` on a root with a theme applied, then puts the root back as it was. */
function withThemedRoot(check: () => void): void {
  const style = root.getAttribute("style");
  const wasDark = root.classList.contains("dark");
  root.dataset.themeId = "ocean";
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
  it("lays the hue over a theme's primary in each appearance", () => {
    withThemedRoot(() => {
      applyAccentColor(root, "violet");

      root.classList.remove("dark");
      expect(token("--primary")).toBe(ACCENT_PALETTE.violet.light.primary);
      expect(token("--ring")).toBe(ACCENT_PALETTE.violet.light.ring);

      root.classList.add("dark");
      expect(token("--primary")).toBe(ACCENT_PALETTE.violet.dark.primary);
      expect(token("--primary-foreground")).toBe(ACCENT_PALETTE.violet.dark.primaryForeground);
    });
  });

  it("returns to the theme's own primary and leaves no variables when set back to theme", () => {
    withThemedRoot(() => {
      const themePrimary = token("--primary");
      applyAccentColor(root, "teal");

      applyAccentColor(root, "theme");

      expect(token("--primary")).toBe(themePrimary);
      expect(root.dataset.accentColor).toBeUndefined();
      expect(root.style.getPropertyValue("--accent-light-primary")).toBe("");
    });
  });
});

describe("interface density tokens", () => {
  it("tighten the sidebar rows when compact and restore them when comfortable", () => {
    withThemedRoot(() => {
      const comfortable = token("--sidebar-thread-row-height");

      root.dataset.interfaceDensity = "compact";
      const compact = token("--sidebar-thread-row-height");
      root.dataset.interfaceDensity = "comfortable";

      expect([comfortable, compact, token("--sidebar-thread-row-height")]).toEqual([
        "2.25rem",
        "1.75rem",
        "2.25rem",
      ]);
    });
  });
});
