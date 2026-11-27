import * as NodeFS from "node:fs";
import { Hct, SchemeTonalSpot, argbFromHex, hexFromArgb } from "@material/material-color-utilities";

import {
  createMobileThemeVariables,
  type MobileThemeVariable,
  type MobileThemeAppearance,
  type MobileThemeVariables,
} from "./mobileTheme";

import { T3_CHAT_THEME } from "@t3tools/shared/themePalettes";
import { materialYouPaletteToMobileThemeVariables } from "./materialYouTheme.android";
import type { MaterialYouPalette } from "./materialYouPalette";
import { getMobileThemeRuntimeVariables } from "./mobileThemeVariables";

const MOBILE_THEME_VARIABLE_NAMES = Object.keys(
  createMobileThemeVariables(T3_CHAT_THEME.colors, "light"),
) as ReadonlyArray<MobileThemeVariable>;

export function readDefaultMobileThemeVariables(
  appearance: MobileThemeAppearance,
): MobileThemeVariables {
  return readGeneratedMobileThemeVariables(appearance);
}

export function readGeneratedMobileThemeVariables(themeName: string): MobileThemeVariables {
  const stylesheet = NodeFS.readFileSync(
    new URL("../../generated-uniwind-themes.css", import.meta.url),
    "utf8",
  );
  const variant = new RegExp(`@variant ${themeName} \\{([\\s\\S]*?)\\n    \\}`, "u").exec(
    stylesheet,
  )?.[1];
  if (variant === undefined) throw new Error(`Missing generated ${themeName} theme.`);

  return Object.fromEntries(
    Array.from(variant.matchAll(/(--color-[a-z0-9-]+):\s*([^;]+);/gu), ([, name, value]) => [
      name,
      (value ?? "").trim(),
    ]).filter(([name]) =>
      MOBILE_THEME_VARIABLE_NAMES.includes(name as (typeof MOBILE_THEME_VARIABLE_NAMES)[number]),
    ),
  ) as MobileThemeVariables;
}

const MATERIAL_YOU_ROLES = [
  "primary",
  "onPrimary",
  "primaryContainer",
  "onPrimaryContainer",
  "inversePrimary",
  "secondaryContainer",
  "onSecondaryContainer",
  "tertiary",
  "tertiaryContainer",
  "onTertiaryContainer",
  "surface",
  "onSurface",
  "onSurfaceVariant",
  "surfaceContainer",
  "surfaceContainerHigh",
  "surfaceContainerHighest",
  "surfaceContainerLow",
  "surfaceContainerLowest",
  "errorContainer",
  "onErrorContainer",
  "outline",
  "outlineVariant",
  "scrim",
] as const satisfies ReadonlyArray<keyof MaterialYouPalette>;

/** The variables an Android device with dynamic colour from `seed` gets. */
export function materialYouSystemThemeVariables(
  seed: string,
  appearance: MobileThemeAppearance,
): MobileThemeVariables {
  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex(seed)), appearance === "dark", 0);
  const palette = Object.fromEntries(
    MATERIAL_YOU_ROLES.map((role) => [role, `${hexFromArgb(scheme[role])}ff`]),
  ) as Record<(typeof MATERIAL_YOU_ROLES)[number], string>;
  return materialYouPaletteToMobileThemeVariables(
    palette,
    appearance,
    getMobileThemeRuntimeVariables("material-you", appearance, "android"),
  );
}
