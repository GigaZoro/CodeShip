import type { AccentColorHue } from "@t3tools/contracts/settings";

export type AccentAppearance = "light" | "dark";

export interface AccentColors {
  readonly primary: string;
  readonly primaryForeground: string;
}

/**
 * The one definition of the accent choices, read by web and mobile. Each primary is also the
 * focus ring and colors plain text, so it reads at 4.5:1 on every built-in surface of its
 * appearance, and its foreground reads at 4.5:1 on it. Dark entries are light shades with dark
 * text: a saturated mid shade cannot clear both white text and dark surfaces.
 */
export const ACCENT_PALETTE = {
  blue: {
    light: { primary: "#1d4ed8", primaryForeground: "#ffffff" },
    dark: { primary: "#93c5fd", primaryForeground: "#172554" },
  },
  indigo: {
    light: { primary: "#4338ca", primaryForeground: "#ffffff" },
    dark: { primary: "#c7d2fe", primaryForeground: "#1e1b4b" },
  },
  violet: {
    light: { primary: "#6d28d9", primaryForeground: "#ffffff" },
    dark: { primary: "#c4b5fd", primaryForeground: "#2e1065" },
  },
  pink: {
    light: { primary: "#be185d", primaryForeground: "#ffffff" },
    dark: { primary: "#f9a8d4", primaryForeground: "#500724" },
  },
  red: {
    light: { primary: "#b91c1c", primaryForeground: "#ffffff" },
    dark: { primary: "#fca5a5", primaryForeground: "#450a0a" },
  },
  orange: {
    light: { primary: "#9a3412", primaryForeground: "#ffffff" },
    dark: { primary: "#fdba74", primaryForeground: "#431407" },
  },
  green: {
    light: { primary: "#166534", primaryForeground: "#ffffff" },
    dark: { primary: "#86efac", primaryForeground: "#052e16" },
  },
  teal: {
    light: { primary: "#115e59", primaryForeground: "#ffffff" },
    dark: { primary: "#5eead4", primaryForeground: "#042f2e" },
  },
} as const satisfies Record<AccentColorHue, Record<AccentAppearance, AccentColors>>;
