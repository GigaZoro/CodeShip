import {
  languageChoices,
  PSEUDO_LANGUAGE_PREFERENCE,
  SYSTEM_LANGUAGE_PREFERENCE,
} from "@t3tools/shared/i18n";
import { View } from "react-native";

import { ListChoiceRow as SettingsChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { t } from "../../../../lib/i18n";
import { SettingsSection } from "../../components/SettingsSection";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

export function LanguageAppearanceSection() {
  const { isReady, languagePreference, setLanguagePreference } = useAppearancePreferences();
  return (
    <SettingsSection title={t("Language")}>
      <View accessibilityRole="radiogroup">
        <SettingsChoiceRow
          label={t("System default")}
          disabled={!isReady}
          selected={languagePreference === SYSTEM_LANGUAGE_PREFERENCE}
          onPress={() => setLanguagePreference(SYSTEM_LANGUAGE_PREFERENCE)}
        />
        {languageChoices({
          includePseudo: __DEV__ || languagePreference === PSEUDO_LANGUAGE_PREFERENCE,
        }).map((choice) => (
          <SettingsChoiceRow
            key={choice.preference}
            label={choice.name}
            disabled={!isReady}
            selected={languagePreference === choice.preference}
            onPress={() => setLanguagePreference(choice.preference)}
            separated
          />
        ))}
      </View>
    </SettingsSection>
  );
}
