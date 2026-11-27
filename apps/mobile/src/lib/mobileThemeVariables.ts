import defaultThemeVariables from "../../generated-uniwind-default-theme-variables.json";
import {
  DEFAULT_MOBILE_THEME_ID,
  flattenThemeColor,
  getMobileThemeVariables,
  themeColorWithAlpha,
  themeColorWithContrast,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeVariables,
} from "./mobileTheme";

const defaults = defaultThemeVariables as Readonly<
  Record<MobileThemeAppearance, MobileThemeVariables>
>;

const CARD_TEXT_ROLES = [
  "--color-foreground-secondary",
  "--color-foreground-muted",
  "--color-placeholder",
  "--color-primary-text",
] as const;

// A selected row in a sidebar sits on the drawer, so it must stay visible there with its labels.
function withVisibleSelection(variables: MobileThemeVariables): MobileThemeVariables {
  const screen = variables["--color-screen"];
  const drawer = flattenThemeColor(variables["--color-drawer"], screen);
  const selected = themeColorWithContrast(
    flattenThemeColor(variables["--color-thread-selected"], variables["--color-drawer"]),
    drawer,
    1.2,
  );
  const statusSurfaces = [
    screen,
    drawer,
    flattenThemeColor(variables["--color-row-hover"], screen),
    flattenThemeColor(variables["--color-thread-hover"], drawer),
    selected,
  ];
  return {
    ...variables,
    "--color-thread-selected": selected,
    "--color-thread-selected-foreground": themeColorWithContrast(
      variables["--color-thread-selected-foreground"],
      selected,
    ),
    "--color-thread-selected-foreground-muted": themeColorWithContrast(
      variables["--color-thread-selected-foreground-muted"],
      selected,
    ),
    "--color-calm-status-quiet": themeColorWithContrast(
      variables["--color-calm-status-quiet"],
      statusSurfaces,
    ),
    "--color-calm-status-attention": themeColorWithContrast(
      variables["--color-calm-status-attention"],
      statusSurfaces,
    ),
    "--color-calm-status-alarm": themeColorWithContrast(
      variables["--color-calm-status-alarm"],
      statusSurfaces,
    ),
  };
}

export function getMobileThemeRuntimeVariables(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
  platform: string,
): MobileThemeVariables {
  return withVisibleSelection(platformThemeVariables(themeId, appearance, platform));
}

function platformThemeVariables(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
  platform: string,
): MobileThemeVariables {
  const usesDefaultPalette = themeId === DEFAULT_MOBILE_THEME_ID || themeId === "material-you";
  const variables = usesDefaultPalette
    ? defaults[appearance]
    : getMobileThemeVariables(themeId, appearance);
  const frame = themeColorWithAlpha(
    variables[usesDefaultPalette ? "--color-row-hover" : "--color-drawer"],
    1,
  );
  if (platform === "ios" && usesDefaultPalette && appearance === "light") {
    return {
      ...variables,
      "--color-header": frame,
      "--color-header-foreground": variables["--color-drawer-foreground"],
      "--color-drawer": frame,
      "--color-drawer-foreground-muted": variables["--color-foreground-muted"],
    };
  }
  if (platform !== "android") return variables;

  // Android paints the drawer as the page inside a lighter frame, so dark cards lift off both.
  const screen = variables["--color-screen"];
  const groupedCard =
    appearance === "dark"
      ? themeColorWithContrast(
          variables["--color-grouped-card"],
          [screen, flattenThemeColor(frame, screen)],
          1.2,
        )
      : variables["--color-grouped-card"];
  const readableOnCard = (role: (typeof CARD_TEXT_ROLES)[number]) =>
    [role, themeColorWithContrast(variables[role], groupedCard)] as const;
  return {
    ...variables,
    ...Object.fromEntries(CARD_TEXT_ROLES.map(readableOnCard)),
    "--color-header": frame,
    "--color-header-foreground": variables["--color-drawer-foreground"],
    "--color-drawer": screen,
    "--color-grouped-card": groupedCard,
  };
}
