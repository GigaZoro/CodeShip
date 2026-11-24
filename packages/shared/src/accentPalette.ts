import type { AccentColorHue } from "@t3tools/contracts/settings";

export type AccentAppearance = "light" | "dark";

export interface AccentColors {
  readonly primary: string;
  readonly primaryForeground: string;
  readonly ring: string;
}

/**
 * The one definition of the accent choices, read by web and mobile. Every entry keeps
 * primaryForeground-on-primary at 4.5:1 or more and the ring at 3:1 or more against every
 * surface in `ACCENT_RING_SURFACES`; dark rings are lighter than their primary so they clear
 * dark cards and popovers too.
 */
export const ACCENT_PALETTE = {
  blue: {
    light: { primary: "#1d4ed8", primaryForeground: "#ffffff", ring: "#1d4ed8" },
    dark: { primary: "#2563eb", primaryForeground: "#ffffff", ring: "#60a5fa" },
  },
  indigo: {
    light: { primary: "#4338ca", primaryForeground: "#ffffff", ring: "#4338ca" },
    dark: { primary: "#4f46e5", primaryForeground: "#ffffff", ring: "#818cf8" },
  },
  violet: {
    light: { primary: "#6d28d9", primaryForeground: "#ffffff", ring: "#6d28d9" },
    dark: { primary: "#7c3aed", primaryForeground: "#ffffff", ring: "#a78bfa" },
  },
  pink: {
    light: { primary: "#be185d", primaryForeground: "#ffffff", ring: "#be185d" },
    dark: { primary: "#db2777", primaryForeground: "#ffffff", ring: "#f472b6" },
  },
  red: {
    light: { primary: "#b91c1c", primaryForeground: "#ffffff", ring: "#b91c1c" },
    dark: { primary: "#dc2626", primaryForeground: "#ffffff", ring: "#f87171" },
  },
  orange: {
    light: { primary: "#b45309", primaryForeground: "#ffffff", ring: "#b45309" },
    dark: { primary: "#c2410c", primaryForeground: "#ffffff", ring: "#fb923c" },
  },
  green: {
    light: { primary: "#15803d", primaryForeground: "#ffffff", ring: "#15803d" },
    dark: { primary: "#17853f", primaryForeground: "#ffffff", ring: "#4ade80" },
  },
  teal: {
    light: { primary: "#0f766e", primaryForeground: "#ffffff", ring: "#0f766e" },
    dark: { primary: "#0e7f76", primaryForeground: "#ffffff", ring: "#2dd4bf" },
  },
} as const satisfies Record<AccentColorHue, Record<AccentAppearance, AccentColors>>;

/** The built-in canvas and card surfaces (index.css `--background`, `--card`) a focus ring sits on. */
export const ACCENT_RING_SURFACES = {
  light: ["#fcfcfc", "#ffffff"],
  dark: ["#000000", "#111111"],
} as const satisfies Record<AccentAppearance, ReadonlyArray<string>>;
