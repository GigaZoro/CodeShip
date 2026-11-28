import {
  ACCENT_COLOR_HUES,
  type AccentColor,
  type InterfaceDensity,
  type StatusColors,
} from "@t3tools/contracts/settings";
import { ACCENT_PALETTE } from "@t3tools/shared/accentPalette";
import { Platform, Pressable, View, useColorScheme } from "react-native";

import { SymbolView } from "../../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../../components/ui/AppText";
import { Button } from "../../../../components/ui/Button";
import { ListChoiceRow as SettingsChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { cn } from "../../../../lib/cn";
import { msg, t, type Message } from "../../../../lib/i18n";
import {
  planMobileCalmPreset,
  type MobileCalmPresetChange,
} from "../../../../persistence/mobile-preferences";
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

const INTERFACE_DENSITY_LABELS: Record<InterfaceDensity, Message> = {
  comfortable: msg("Comfortable"),
  compact: msg("Compact spacing"),
};

const STATUS_COLORS_LABELS: Record<StatusColors, Message> = {
  calm: msg("Calm"),
  vivid: msg("Vivid"),
};

function formatMobileCalmPresetChange(change: MobileCalmPresetChange): string {
  if (change.key === "interfaceDensity") {
    return t("{label}: {from} → {to}", {
      label: t("Interface density"),
      from: t(INTERFACE_DENSITY_LABELS[change.from]),
      to: t(INTERFACE_DENSITY_LABELS[change.to]),
    });
  }
  return t("{label}: {from} → {to}", {
    label: t("Status colors"),
    from: t(STATUS_COLORS_LABELS[change.from]),
    to: t(STATUS_COLORS_LABELS[change.to]),
  });
}

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
  const {
    isReady,
    interfaceDensity,
    setInterfaceDensity,
    statusColors,
    setStatusColors,
    accentColor,
    setAccentColor,
    lastAppliedCalmPreset,
    applyCalmPreset,
    undoCalmPreset,
  } = useAppearancePreferences();
  const appearance = useColorScheme() === "dark" ? "dark" : "light";
  const calmPlan = planMobileCalmPreset({ interfaceDensity, statusColors });

  return (
    <SettingsSection title={t("Interface")}>
      <View className="gap-3 bg-grouped-card px-4 py-3.5">
        <View className="gap-1">
          <Text className="font-t3-medium text-foreground">{t("Calm preset")}</Text>
          <Text className="text-sm text-foreground-muted">
            {t("Applies compact spacing and calm status colors. Notifications stay unchanged.")}
          </Text>
        </View>
        <View className="flex-row flex-wrap items-center gap-2">
          {calmPlan.isActive ? (
            <View className="flex-row items-center gap-1.5 py-1">
              <SymbolView
                name="checkmark"
                size={14}
                tintColorClassName="accent-foreground-muted"
                type="monochrome"
                weight="semibold"
              />
              <Text className="text-sm font-t3-medium text-foreground-muted">{t("Active")}</Text>
            </View>
          ) : (
            <Button
              label={t("Apply Calm")}
              tone="secondary"
              disabled={!isReady}
              onPress={() => {
                applyCalmPreset();
              }}
            />
          )}
          {lastAppliedCalmPreset !== null ? (
            <Button
              label={t("Undo")}
              icon="arrow.uturn.backward"
              tone="text"
              disabled={!isReady}
              onPress={undoCalmPreset}
            />
          ) : null}
        </View>
        {lastAppliedCalmPreset !== null ? (
          <View
            accessibilityLiveRegion="polite"
            className="gap-1 rounded-xl border border-border-subtle bg-subtle px-3 py-2.5"
          >
            <Text className="text-xs font-t3-medium text-foreground">
              {t("Changed by Calm preset")}
            </Text>
            {lastAppliedCalmPreset.changes.map((change) => (
              <Text key={change.key} className="text-xs text-foreground-muted">
                {formatMobileCalmPresetChange(change)}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
      <View accessibilityRole="radiogroup" className="border-t border-border-subtle">
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
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={t("Status colors")}
        className="border-t border-border-subtle"
      >
        <SettingsChoiceRow
          label={t("Calm status colors")}
          description={t("Only what needs you has color: amber to answer, red when it failed.")}
          disabled={!isReady}
          selected={statusColors === "calm"}
          onPress={() => setStatusColors("calm")}
        />
        <SettingsChoiceRow
          label={t("Vivid status colors")}
          description={t("Every status has its own color.")}
          disabled={!isReady}
          selected={statusColors === "vivid"}
          onPress={() => setStatusColors("vivid")}
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
