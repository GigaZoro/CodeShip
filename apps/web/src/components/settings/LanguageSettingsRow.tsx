import {
  languageChoices,
  normalizeLanguagePreference,
  PSEUDO_LANGUAGE_PREFERENCE,
  SYSTEM_LANGUAGE_PREFERENCE,
  type LanguagePreference,
} from "@t3tools/shared/i18n";

import { persistClientSettingsPatch, useClientSettings } from "../../hooks/useSettings";
import { t } from "../../i18n";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

// Every module reads the language once at startup, so a reload is what applies a new one.
async function changeLanguage(language: LanguagePreference) {
  await persistClientSettingsPatch({ language });
  window.location.reload();
}

export function LanguageSettingsRow() {
  const preference = normalizeLanguagePreference(
    useClientSettings((settings) => settings.language),
  );
  const choices = [
    { preference: SYSTEM_LANGUAGE_PREFERENCE, name: t("System default") },
    ...languageChoices({
      includePseudo: import.meta.env.DEV || preference === PSEUDO_LANGUAGE_PREFERENCE,
    }),
  ];
  const label = choices.find((choice) => choice.preference === preference)?.name;
  return (
    <SettingsRow
      {...searchableSetting("language")}
      description={t(
        "System default follows your browser or OS language. Changing it reloads the app.",
      )}
      resetAction={
        preference === SYSTEM_LANGUAGE_PREFERENCE ? null : (
          <SettingResetButton
            label={t("language")}
            onClick={() => void changeLanguage(SYSTEM_LANGUAGE_PREFERENCE)}
          />
        )
      }
      control={
        <Select
          value={preference}
          onValueChange={(value) => {
            const next = normalizeLanguagePreference(value);
            if (next !== preference) void changeLanguage(next);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={t("Language")}>
            <SelectValue>{label}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {choices.map((choice) => (
              <SelectItem key={choice.preference} hideIndicator value={choice.preference}>
                {choice.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
