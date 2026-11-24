import type { AccentColor } from "@t3tools/contracts/settings";
import { ACCENT_PALETTE } from "@t3tools/shared/accentPalette";

const ACCENT_VARIABLE_ROLES = [
  ["primary", "primary"],
  ["primary-foreground", "primaryForeground"],
  ["ring", "ring"],
] as const;
const APPEARANCES = ["light", "dark"] as const;

const accentVariableNames = APPEARANCES.flatMap((mode) =>
  ACCENT_VARIABLE_ROLES.map(([name]) => `--accent-${mode}-${name}`),
);

/**
 * Publishes both appearances of the chosen hue; index.css picks the one matching the active
 * appearance and lays it over the theme's own primary. `theme` removes every trace of it.
 */
export function applyAccentColor(root: HTMLElement, accent: AccentColor): void {
  for (const name of accentVariableNames) root.style.removeProperty(name);
  if (accent === "theme") {
    delete root.dataset.accentColor;
    return;
  }
  for (const mode of APPEARANCES) {
    for (const [name, role] of ACCENT_VARIABLE_ROLES) {
      root.style.setProperty(`--accent-${mode}-${name}`, ACCENT_PALETTE[accent][mode][role]);
    }
  }
  root.dataset.accentColor = accent;
}
