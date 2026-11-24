import { ACCENT_COLOR_HUES } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { ACCENT_PALETTE, type AccentAppearance } from "./accentPalette.ts";
import {
  BUILT_IN_THEMES,
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
  getThemeColorsForAppearance,
} from "./themePalettes.ts";

type Rgb = readonly [number, number, number];

function hexChannels(hex: string): Rgb {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function oklchChannels(color: string): Rgb {
  const match = /^oklch\(([\d.]+)(%?) ([\d.]+) ([\d.]+)\)$/u.exec(color);
  if (!match) throw new Error(`unparsed theme color ${color}`);
  const lightness = Number(match[1]) / (match[2] ? 100 : 1);
  const hue = (Number(match[4]) * Math.PI) / 180;
  const a = Number(match[3]) * Math.cos(hue);
  const b = Number(match[3]) * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((linear) => {
    const clamped = Math.min(1, Math.max(0, linear));
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  }) as [number, number, number];
}

const channels = (color: string | Rgb): Rgb =>
  typeof color !== "string"
    ? color
    : color.startsWith("#")
      ? hexChannels(color)
      : oklchChannels(color);

function luminance(color: string | Rgb): number {
  const [r, g, b] = channels(color).map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(first: string | Rgb, second: string | Rgb): number {
  const [lighter, darker] = [luminance(first), luminance(second)].toSorted((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

/** index.css `color-mix(in srgb, var(--primary) 90%, black | white)` for `--message-action-hover`. */
function hovered(primary: string, mode: AccentAppearance): Rgb {
  const toward = mode === "light" ? 0 : 1;
  return channels(primary).map((channel) => channel * 0.9 + toward * 0.1) as [
    number,
    number,
    number,
  ];
}

const APPEARANCES: ReadonlyArray<AccentAppearance> = ["light", "dark"];

/** Where the accent paints text and focus rings: index.css's own tokens, then every theme's. */
const SURFACES: Record<AccentAppearance, ReadonlyArray<readonly [string, string]>> = (() => {
  const surfaces: Record<AccentAppearance, Array<readonly [string, string]>> = {
    light: [
      ["default --background", "oklch(99.2% 0 0)"],
      ["default --card", "#ffffff"],
      ["default --sidebar", "#fafafa"],
    ],
    dark: [
      ["default --background", "#000000"],
      ["default --card", "#111111"],
    ],
  };
  const roles = ["canvas", "surface", "surfaceRaised", "surfaceOverlay", "sidebar"] as const;
  for (const mode of APPEARANCES) {
    const themes = [
      ["t3-code", mode === "light" ? T3_CODE_LIGHT_THEME_COLORS : T3_CODE_DARK_THEME_COLORS],
      ...BUILT_IN_THEMES.map(
        (theme) => [theme.id, getThemeColorsForAppearance(theme, mode)] as const,
      ),
    ] as const;
    for (const [id, colors] of themes) {
      if (colors) for (const role of roles) surfaces[mode].push([`${id} ${role}`, colors[role]]);
    }
  }
  return surfaces;
})();

describe("accent palette", () => {
  it("defines every hue the settings accept", () => {
    expect(Object.keys(ACCENT_PALETTE).toSorted()).toEqual([...ACCENT_COLOR_HUES].toSorted());
  });

  describe.each(
    ACCENT_COLOR_HUES.flatMap((hue) => APPEARANCES.map((mode) => [hue, mode] as const)),
  )("%s in %s", (hue, mode) => {
    const colors = ACCENT_PALETTE[hue][mode];

    it("keeps text on the primary and on its hover at 4.5:1 (WCAG 1.4.3)", () => {
      expect(contrastRatio(colors.primaryForeground, colors.primary)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(colors.primaryForeground, hovered(colors.primary, mode)),
      ).toBeGreaterThanOrEqual(4.5);
    });

    it.each(SURFACES[mode])(
      "reads at 4.5:1 as text, and so as a focus ring, on %s",
      (_name, surface) => {
        expect(contrastRatio(colors.primary, surface)).toBeGreaterThanOrEqual(4.5);
      },
    );
  });
});
