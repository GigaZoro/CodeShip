import type { AccentColor } from "@t3tools/contracts/settings";
import { ACCENT_PALETTE } from "@t3tools/shared/accentPalette";

const ACCENT_VARIABLE_ROLES = [
  ["primary", "primary"],
  ["primary-foreground", "primaryForeground"],
] as const;
const APPEARANCES = ["light", "dark"] as const;

const accentVariableNames = APPEARANCES.flatMap((mode) =>
  ACCENT_VARIABLE_ROLES.map(([name]) => `--accent-${mode}-${name}`),
);

/**
 * Publishes both appearances of the chosen hue; index.css picks the one matching the active
 * appearance and lays it over the theme's own primary. `theme` removes every trace of it.
 * Controls that animate their color would otherwise fade between the old and new hue.
 */
export function applyAccentColor(root: HTMLElement, accent: AccentColor): void {
  root.classList.add("no-transitions");
  for (const name of accentVariableNames) root.style.removeProperty(name);
  if (accent === "theme") {
    delete root.dataset.accentColor;
  } else {
    for (const mode of APPEARANCES) {
      for (const [name, role] of ACCENT_VARIABLE_ROLES) {
        root.style.setProperty(`--accent-${mode}-${name}`, ACCENT_PALETTE[accent][mode][role]);
      }
    }
    root.dataset.accentColor = accent;
  }
  // The reflow commits the new colors while transitions are off.
  void root.offsetHeight;
  requestAnimationFrame(() => root.classList.remove("no-transitions"));
}
