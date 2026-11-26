import { languageChoices, PSEUDO_LANGUAGE_PREFERENCE } from "@t3tools/shared/i18n";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { t } from "../../lib/i18n";
import { useAppearancePreferences } from "./appearance/AppearancePreferencesProvider";
import { LanguageAppearanceSection } from "./appearance/sections/LanguageAppearanceSection";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

export function LanguageSettingsSection() {
  const { languagePreference } = useAppearancePreferences();
  const value =
    languageChoices({ includePseudo: languagePreference === PSEUDO_LANGUAGE_PREFERENCE }).find(
      (option) => option.preference === languagePreference,
    )?.name ?? t("System default");
  return (
    <SettingsSection>
      <SettingsRow icon="globe" label={t("Language")} value={value} target="SettingsLanguage" />
    </SettingsSection>
  );
}

export function SettingsLanguageRouteScreen() {
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title={t("Language")}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <LanguageAppearanceSection />
      </ScreenScrollView>
    </SettingsScreen>
  );
}
