import { ACCENT_COLOR_HUES } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { ACCENT_BASE_BACKGROUND, ACCENT_PALETTE, type AccentAppearance } from "./accentPalette.ts";

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].toSorted((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

const APPEARANCES: ReadonlyArray<AccentAppearance> = ["light", "dark"];

describe("accent palette", () => {
  it("defines every hue the settings accept", () => {
    expect(Object.keys(ACCENT_PALETTE).toSorted()).toEqual([...ACCENT_COLOR_HUES].toSorted());
  });

  describe.each(
    ACCENT_COLOR_HUES.flatMap((hue) => APPEARANCES.map((mode) => [hue, mode] as const)),
  )("%s in %s", (hue, mode) => {
    const colors = ACCENT_PALETTE[hue][mode];

    it("keeps text on the primary at 4.5:1 (WCAG 1.4.3)", () => {
      expect(contrastRatio(colors.primaryForeground, colors.primary)).toBeGreaterThanOrEqual(4.5);
    });

    it("keeps the focus ring at 3:1 against the background (WCAG 1.4.11)", () => {
      expect(contrastRatio(colors.ring, ACCENT_BASE_BACKGROUND[mode])).toBeGreaterThanOrEqual(3);
    });
  });
});
