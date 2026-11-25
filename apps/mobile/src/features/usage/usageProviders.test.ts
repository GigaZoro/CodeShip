import * as NodeFS from "node:fs";
import { expect, it, vi } from "vite-plus/test";
import { providerColors } from "./usageProviders";

vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));

function luminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722;
}

it.each(["light", "dark"] as const)(
  "keeps every mobile provider above 3:1 on the %s chart card",
  (theme) => {
    const css = NodeFS.readFileSync(
      new URL("../../../generated-uniwind-themes.css", import.meta.url),
      "utf8",
    );
    const root = css.match(new RegExp(`@variant ${theme} \\{([^}]+)\\}`))?.[1];
    const canvas = luminance(root!.match(/--color-grouped-card: (#[\da-f]{6});/i)![1]!);
    for (const [provider, color] of Object.entries(providerColors(theme))) {
      const foreground = luminance(color);
      expect(
        (Math.max(canvas, foreground) + 0.05) / (Math.min(canvas, foreground) + 0.05),
        `${provider} on the ${theme} chart card`,
      ).toBeGreaterThanOrEqual(3);
    }
  },
);
