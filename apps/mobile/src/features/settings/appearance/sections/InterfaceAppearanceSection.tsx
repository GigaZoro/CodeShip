import { ACCENT_COLOR_HUES, type AccentColor } from "@t3tools/contracts/settings";
import { ACCENT_PALETTE } from "@t3tools/shared/accentPalette";
import { Platform, Pressable, View, useColorScheme } from "react-native";

import { SymbolView } from "../../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../../components/ui/AppText";
import { ListChoiceRow as SettingsChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { cn } from "../../../../lib/cn";
import { msg, t, type Message } from "../../../../lib/i18n";
import { SettingsSection } from "../../components/SettingsSection";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

const ACCENT_COLOR_LABELS: Record<AccentColor, Message> = {
  theme: msg("Theme"),
  blue: msg("Blue"),
  indigo: msg("Indigo"),
  violet: msg("Violet"),
  pink: msg("Pink"),
  red: msg("Red"),
  orange: msg("Orange"),
  green: msg("Green"),
  teal: msg("Teal"),
};

const ACCENT_CHOICES: ReadonlyArray<AccentColor> = ["theme", ...ACCENT_COLOR_HUES];

/** The hit area is 44pt (iOS) / 48dp (Android) in points, not rem; the visible swatch is smaller. */
function AccentSwatch(props: {
  readonly accent: AccentColor;
  readonly appearance: "light" | "dark";
  readonly disabled: boolean;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  const label = t(ACCENT_COLOR_LABELS[props.accent]);
  const colors = props.accent === "theme" ? null : ACCENT_PALETTE[props.accent][props.appearance];
  const fill = colors?.primary;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        Platform.OS === "android" ? "size-[48px]" : "size-[44px]",
        "items-center justify-center",
      )}
    >
      <View
        className={cn(
          "size-8 items-center justify-center rounded-full border",
          fill === undefined && "bg-subtle-strong",
          props.selected ? "border-foreground border-2" : "border-border-subtle",
        )}
        style={fill === undefined ? undefined : { backgroundColor: fill }}
      >
        {props.selected ? (
          <SymbolView
            name="checkmark"
            size={14}
            tintColor={colors?.primaryForeground}
            tintColorClassName={colors ? undefined : "accent-foreground"}
            type="monochrome"
            weight="bold"
          />
        ) : null}
      </View>
    </Pressable>
  );
}

export function InterfaceAppearanceSection() {
  const { isReady, interfaceDensity, setInterfaceDensity, accentColor, setAccentColor } =
    useAppearancePreferences();
  const appearance = useColorScheme() === "dark" ? "dark" : "light";

  return (
    <SettingsSection title={t("Interface")}>
      <View accessibilityRole="radiogroup">
        <SettingsChoiceRow
          label={t("Comfortable")}
          disabled={!isReady}
          selected={interfaceDensity === "comfortable"}
          onPress={() => setInterfaceDensity("comfortable")}
        />
        <SettingsChoiceRow
          label={t("Compact spacing")}
          description={t("Tighter thread rows on the home list.")}
          disabled={!isReady}
          selected={interfaceDensity === "compact"}
          onPress={() => setInterfaceDensity("compact")}
          separated
        />
      </View>
      <View className="gap-1 border-t border-border-subtle bg-grouped-card px-4 py-3">
        <Text className="text-foreground">{t("Accent color")}</Text>
        <View accessibilityRole="radiogroup" className="-ml-1.5 flex-row flex-wrap">
          {ACCENT_CHOICES.map((accent) => (
            <AccentSwatch
              key={accent}
              accent={accent}
              appearance={appearance}
              disabled={!isReady}
              selected={accentColor === accent}
              onPress={() => setAccentColor(accent)}
            />
          ))}
        </View>
      </View>
    </SettingsSection>
  );
}
