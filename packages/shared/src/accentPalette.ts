import type { AccentColorHue } from "@t3tools/contracts/settings";

export type AccentAppearance = "light" | "dark";

export interface AccentColors {
  readonly primary: string;
  readonly primaryForeground: string;
  readonly ring: string;
}

/**
 * The one definition of the accent choices, read by web and mobile. Every entry keeps
 * primaryForeground-on-primary at 4.5:1 or more and ring-on-background at 3:1 or more
 * against each appearance's base background (`ACCENT_BASE_BACKGROUND`); accentPalette.test.ts
 * holds the numbers.
 */
export const ACCENT_PALETTE = {
  blue: {
    light: { primary: "#1d4ed8", primaryForeground: "#ffffff", ring: "#1d4ed8" },
    dark: { primary: "#2563eb", primaryForeground: "#ffffff", ring: "#2563eb" },
  },
  indigo: {
    light: { primary: "#4338ca", primaryForeground: "#ffffff", ring: "#4338ca" },
    dark: { primary: "#4f46e5", primaryForeground: "#ffffff", ring: "#4f46e5" },
  },
  violet: {
    light: { primary: "#6d28d9", primaryForeground: "#ffffff", ring: "#6d28d9" },
    dark: { primary: "#7c3aed", primaryForeground: "#ffffff", ring: "#7c3aed" },
  },
  pink: {
    light: { primary: "#be185d", primaryForeground: "#ffffff", ring: "#be185d" },
    dark: { primary: "#db2777", primaryForeground: "#ffffff", ring: "#db2777" },
  },
  red: {
    light: { primary: "#b91c1c", primaryForeground: "#ffffff", ring: "#b91c1c" },
    dark: { primary: "#dc2626", primaryForeground: "#ffffff", ring: "#dc2626" },
  },
  orange: {
    light: { primary: "#b45309", primaryForeground: "#ffffff", ring: "#b45309" },
    dark: { primary: "#c2410c", primaryForeground: "#ffffff", ring: "#c2410c" },
  },
  green: {
    light: { primary: "#15803d", primaryForeground: "#ffffff", ring: "#15803d" },
    dark: { primary: "#17853f", primaryForeground: "#ffffff", ring: "#17853f" },
  },
  teal: {
    light: { primary: "#0f766e", primaryForeground: "#ffffff", ring: "#0f766e" },
    dark: { primary: "#0e7f76", primaryForeground: "#ffffff", ring: "#0e7f76" },
  },
} as const satisfies Record<AccentColorHue, Record<AccentAppearance, AccentColors>>;

/** The canvas of the built-in light and dark appearances, which the ring must stand out from. */
export const ACCENT_BASE_BACKGROUND = {
  light: "#fcfcfc",
  dark: "#000000",
} as const satisfies Record<AccentAppearance, string>;
