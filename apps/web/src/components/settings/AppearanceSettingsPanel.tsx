import type { CSSProperties } from "react";
import { useState } from "react";
import {
  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
  DEFAULT_UNIFIED_SETTINGS,
  type ChatWidth,
  type EffortDisplay,
  type EnvironmentIdentificationMode,
  MAX_APPEARANCE_CONTRAST,
  MAX_GLASS_OPACITY,
  MAX_PANEL_ANIMATION_DURATION_MS,
  MIN_APPEARANCE_CONTRAST,
  MIN_GLASS_OPACITY,
  MIN_PANEL_ANIMATION_DURATION_MS,
} from "@t3tools/contracts/settings";
import {
  resolveSidebarStageBackdropVariant,
  type SidebarStageBackdropVariant,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { useCustomThemes } from "../../hooks/useCustomThemes";
import { msg, t, type Message } from "~/i18n";
import { useClientSettings, useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { deviceSettingsProfileAvailability } from "@t3tools/client-runtime/state/device-settings-profile";
import { useTheme } from "../../hooks/useTheme";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { setFollowDeviceSettingsProfile } from "./DeviceSettingsProfileCoordinator";
import { ThemeLibrary } from "./ThemeSettings";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { AdvancedSettings } from "./AdvancedSettings";
import { PanelAnimationsPreview } from "./PanelAnimationsPreview";
import { TypographySection } from "./TypographySettings";

const ENVIRONMENT_IDENTIFICATION_LABELS: Record<EnvironmentIdentificationMode, Message> = {
  artwork: msg("Artwork"),
  "nightly-artwork": msg("Nightly artwork"),
  "dev-artwork": msg("Dev artwork"),
  pill: msg("Version pill"),
  none: msg("None"),
};

// The default "artwork" follows the running channel, so it is labeled as that channel's art,
// or as "None" on Latest. The other channel's art is offered as a fixed choice.
function environmentIdentificationOptions(
  stageVariant: SidebarStageBackdropVariant | null,
): ReadonlyArray<readonly [EnvironmentIdentificationMode, string]> {
  if (stageVariant === "dev") {
    return [
      ["artwork", t("Dev artwork")],
      ["nightly-artwork", t("Nightly artwork")],
      ["pill", t("Version pill")],
      ["none", t("None")],
    ];
  }
  if (stageVariant === "nightly") {
    return [
      ["artwork", t("Nightly artwork")],
      ["dev-artwork", t("Dev artwork")],
      ["pill", t("Version pill")],
      ["none", t("None")],
    ];
  }
  return [
    ["artwork", t("None")],
    ["nightly-artwork", t("Nightly artwork")],
    ["dev-artwork", t("Dev artwork")],
  ];
}

const CHAT_WIDTH_LABELS: Record<ChatWidth, Message> = {
  comfortable: msg("Comfortable"),
  wide: msg("Wide"),
  full: msg("Full"),
};

const EFFORT_DISPLAY_LABELS: Record<EffortDisplay, Message> = {
  label: msg("Word"),
  bars: msg("Bars"),
};

/** Why this device cannot follow its profile now, or null when it can. */
function deviceSettingsProfileProblem(
  status: ReturnType<typeof deviceSettingsProfileAvailability>["status"],
  machine: string,
): string | null {
  switch (status) {
    case "ready":
      return null;
    case "offline":
      return t("{machine} is not connected. Changes sync when it is back.", { machine });
    case "no-primary":
      return t("Open this from the desktop app or a server's own address to use this.");
    case "unsupported":
      return t("{machine} is on a version that cannot hold these settings. Update it.", {
        machine,
      });
    case "not-following":
      return t("Turn on Follow shared settings for {machine} under Connections first.", {
        machine,
      });
  }
}

function DeviceSettingsProfileRow() {
  const follows = useClientSettings((settings) => settings.followDeviceSettingsProfile);
  const primary = usePrimaryEnvironment();
  const { status } = deviceSettingsProfileAvailability(primary);
  const problem = deviceSettingsProfileProblem(status, primary?.label ?? "");
  const blocked = status === "no-primary" || status === "unsupported" || status === "not-following";
  return (
    <SettingsRow
      {...searchableSetting("device-settings-profile")}
      description={
        problem ??
        t(
          "Fonts, sidebar, confirmations, diffs, language and more follow what you set on your other devices that use this.",
        )
      }
      control={
        <Switch
          checked={follows}
          disabled={blocked && !follows}
          // A fresh start each time: turning it on takes the shared profile, and a device that was
          // off must not carry old changes back into it.
          onCheckedChange={(checked) => void setFollowDeviceSettingsProfile(Boolean(checked))}
          aria-label={t("Use the same appearance and layout on all my devices")}
        />
      }
    />
  );
}

export function AppearanceSettingsPanel() {
  const {
    appearanceMode,
    refreshTheme,
    resolvedTheme,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
    theme,
    themeHalves,
  } = useTheme();
  const customThemes = useCustomThemes();
  const [isImportThemeOpen, setIsImportThemeOpen] = useState(false);
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const environmentStageLabel = useEnvironmentStageLabel();
  const environmentStageVariant = resolveSidebarStageBackdropVariant(environmentStageLabel);
  const environmentIdentificationOptionList =
    environmentIdentificationOptions(environmentStageVariant);
  const environmentIdentificationLabel =
    environmentIdentificationOptionList.find(
      ([value]) => value === settings.environmentIdentificationMode,
    )?.[1] ?? t(ENVIRONMENT_IDENTIFICATION_LABELS[settings.environmentIdentificationMode]);
  const effectiveEnvironmentIdentificationMode = useEnvironmentIdentificationMode();
  const themeHidesEnvironmentArtwork =
    effectiveEnvironmentIdentificationMode === "pill" &&
    resolveSidebarStageBackdropVariant(
      environmentStageLabel,
      settings.environmentIdentificationMode,
    ) !== null;
  const environmentIdentificationDescription = themeHidesEnvironmentArtwork
    ? environmentStageVariant
      ? t("Only built-in themes show artwork, so this theme shows the version pill.")
      : t("Only built-in themes show artwork.")
    : environmentStageVariant
      ? t("Choose how Dev and Nightly environments are identified.")
      : t("Show Dev or Nightly artwork in the sidebar header.");
  const glassOpacityRatio =
    (settings.glassOpacity - MIN_GLASS_OPACITY) / (MAX_GLASS_OPACITY - MIN_GLASS_OPACITY);
  const glassOpacitySliderStyle = {
    "--settings-slider-progress": `${glassOpacityRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - glassOpacityRatio}rem`,
  } as CSSProperties;
  const appearanceContrastRatio =
    (settings.appearanceContrast - MIN_APPEARANCE_CONTRAST) /
    (MAX_APPEARANCE_CONTRAST - MIN_APPEARANCE_CONTRAST);
  const appearanceContrastSliderStyle = {
    "--settings-slider-progress": `${appearanceContrastRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - appearanceContrastRatio}rem`,
  } as CSSProperties;
  const panelAnimationDurationRatio =
    (settings.panelAnimationDurationMs - MIN_PANEL_ANIMATION_DURATION_MS) /
    (MAX_PANEL_ANIMATION_DURATION_MS - MIN_PANEL_ANIMATION_DURATION_MS);
  const panelAnimationDurationSliderStyle = {
    "--settings-slider-progress": `${panelAnimationDurationRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - panelAnimationDurationRatio}rem`,
  } as CSSProperties;

  return (
    <SettingsPageContainer>
      <SettingsSection id="appearance" title={t("Colors & themes")} variant="plain" hideTitle>
        <div id={searchableSetting("theme").id}>
          <ThemeLibrary
            appearanceMode={appearanceMode}
            customThemes={customThemes}
            initialAppearance={resolvedTheme}
            refreshTheme={refreshTheme}
            isImportOpen={isImportThemeOpen}
            setAppearanceMode={setAppearanceMode}
            setTheme={setTheme}
            setThemeHalf={setThemeHalf}
            theme={theme}
            themeHalves={themeHalves}
            onImportOpenChange={setIsImportThemeOpen}
          />
        </div>
      </SettingsSection>

      <SettingsSection id="appearance-interface" title={t("Interface")}>
        <DeviceSettingsProfileRow />
        <SettingsRow
          {...searchableSetting("setting-appearance-contrast")}
          description={t("Adjust the contrast of colors and borders across the interface.")}
          resetAction={
            settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast ? (
              <SettingResetButton
                label={t("contrast")}
                onClick={() =>
                  updateSettings({
                    appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="appearance-contrast"
              >
                {settings.appearanceContrast}%
              </output>
              <input
                aria-label={t("Contrast")}
                className="settings-slider min-w-0 flex-1"
                id="appearance-contrast"
                max={MAX_APPEARANCE_CONTRAST}
                min={MIN_APPEARANCE_CONTRAST}
                onChange={(event) => {
                  const appearanceContrast = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(appearanceContrast) &&
                    appearanceContrast >= MIN_APPEARANCE_CONTRAST &&
                    appearanceContrast <= MAX_APPEARANCE_CONTRAST
                  ) {
                    updateSettings({ appearanceContrast });
                  }
                }}
                step={5}
                style={appearanceContrastSliderStyle}
                type="range"
                value={settings.appearanceContrast}
              />
            </div>
          }
        />

        <SettingsRow
          {...searchableSetting("setting-glass-opacity")}
          description={t("Higher values make menus, dialogs, and the composer more solid.")}
          resetAction={
            settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? (
              <SettingResetButton
                label={t("glass opacity")}
                onClick={() =>
                  updateSettings({ glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="glass-opacity"
              >
                {settings.glassOpacity}%
              </output>
              <input
                aria-label={t("Glass opacity")}
                className="settings-slider min-w-0 flex-1"
                id="glass-opacity"
                max={MAX_GLASS_OPACITY}
                min={MIN_GLASS_OPACITY}
                onChange={(event) => {
                  const glassOpacity = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(glassOpacity) &&
                    glassOpacity >= MIN_GLASS_OPACITY &&
                    glassOpacity <= MAX_GLASS_OPACITY
                  ) {
                    updateSettings({ glassOpacity });
                  }
                }}
                step={5}
                style={glassOpacitySliderStyle}
                type="range"
                value={settings.glassOpacity}
              />
            </div>
          }
        />

        <SettingsRow
          {...searchableSetting("chat-width")}
          description={t("Set how wide messages and the composer can grow on large screens.")}
          resetAction={
            settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? (
              <SettingResetButton
                label={t("chat width")}
                onClick={() => updateSettings({ chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth })}
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={settings.chatWidth}
                onValueChange={(value) => {
                  if (value === "comfortable" || value === "wide" || value === "full")
                    updateSettings({ chatWidth: value });
                }}
              >
                <SelectTrigger size="sm" className="w-full min-w-0" aria-label={t("Chat width")}>
                  <SelectValue>{t(CHAT_WIDTH_LABELS[settings.chatWidth])}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="comfortable">{t("Comfortable (default)")}</SelectItem>
                  <SelectItem value="wide">{t("Wide")}</SelectItem>
                  <SelectItem value="full">{t("Full")}</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting("effort-display")}
          description={t(
            "Show reasoning effort in the composer as its name, such as High, or as bars.",
          )}
          resetAction={
            settings.effortDisplay !== DEFAULT_UNIFIED_SETTINGS.effortDisplay ? (
              <SettingResetButton
                label={t("effort display")}
                onClick={() =>
                  updateSettings({ effortDisplay: DEFAULT_UNIFIED_SETTINGS.effortDisplay })
                }
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={settings.effortDisplay}
                onValueChange={(value) => {
                  if (value === "bars" || value === "label")
                    updateSettings({ effortDisplay: value });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full min-w-0"
                  aria-label={t("Effort display")}
                >
                  <SelectValue>{t(EFFORT_DISPLAY_LABELS[settings.effortDisplay])}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="label">{t("Word (default)")}</SelectItem>
                  <SelectItem value="bars">{t("Bars")}</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          }
        />
        <AdvancedSettings
          targetIds={[
            searchableSetting("panel-animations").id,
            searchableSetting("environment-identification").id,
            // Environment identification's search result lands on this section.
            "appearance-interface",
          ]}
        >
          <SettingsRow
            {...searchableSetting("panel-animations")}
            description={t("Set how fast panels open and close.")}
            control={
              <div className="grid w-full grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 sm:w-auto sm:grid-cols-[7rem_13rem] sm:gap-4">
                <PanelAnimationsPreview durationMs={settings.panelAnimationDurationMs} />
                <div className="flex w-full items-center gap-3">
                  <output
                    className="min-w-16 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                    htmlFor="panel-animation-duration"
                  >
                    {t("{value} ms", { value: settings.panelAnimationDurationMs })}
                  </output>
                  <input
                    aria-label={t("Panel animation duration")}
                    className="settings-slider min-w-0 flex-1"
                    id="panel-animation-duration"
                    max={MAX_PANEL_ANIMATION_DURATION_MS}
                    min={MIN_PANEL_ANIMATION_DURATION_MS}
                    onChange={(event) => {
                      const panelAnimationDurationMs = Number(event.currentTarget.value);
                      if (
                        Number.isInteger(panelAnimationDurationMs) &&
                        panelAnimationDurationMs >= MIN_PANEL_ANIMATION_DURATION_MS &&
                        panelAnimationDurationMs <= MAX_PANEL_ANIMATION_DURATION_MS
                      ) {
                        updateSettings({ panelAnimationDurationMs });
                      }
                    }}
                    step={25}
                    style={panelAnimationDurationSliderStyle}
                    type="range"
                    value={settings.panelAnimationDurationMs}
                  />
                </div>
              </div>
            }
            resetAction={
              settings.panelAnimationDurationMs !==
              DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs ? (
                <SettingResetButton
                  label={t("panel animations")}
                  onClick={() =>
                    updateSettings({
                      panelAnimationDurationMs: DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs,
                    })
                  }
                />
              ) : null
            }
          />
          <SettingsRow
            {...searchableSetting("environment-identification")}
            description={environmentIdentificationDescription}
            resetAction={
              settings.environmentIdentificationMode !== DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE ? (
                <SettingResetButton
                  label={t("environment identification")}
                  onClick={() =>
                    updateSettings({
                      environmentIdentificationMode: DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.environmentIdentificationMode}
                onValueChange={(value) => {
                  const option = environmentIdentificationOptionList.find(
                    ([optionValue]) => optionValue === value,
                  );
                  if (option) updateSettings({ environmentIdentificationMode: option[0] });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label={t("Environment identification")}
                >
                  <SelectValue>{environmentIdentificationLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {environmentIdentificationOptionList.map(([value, label]) => (
                    <SelectItem hideIndicator key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </AdvancedSettings>
      </SettingsSection>

      <TypographySection />
    </SettingsPageContainer>
  );
}
