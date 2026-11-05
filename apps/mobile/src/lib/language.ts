import { activateLanguage, type LanguagePreference } from "@t3tools/shared/i18n";
import { loadLanguage } from "@t3tools/client-runtime/i18n/catalogs";

let latestRequest = 0;

/**
 * Activates the language `preference` resolves to; a catalog that fails to load leaves English.
 * Returns false when a newer request superseded this one, which then leaves the language alone.
 */
export async function applyLanguagePreference(preference: LanguagePreference): Promise<boolean> {
  const request = ++latestRequest;
  const deviceLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  const { activation, error } = await loadLanguage(preference, {
    languages: [deviceLocale],
    locale: deviceLocale,
  });
  if (error !== undefined) console.error("Could not load the UI language catalog.", { error });
  if (request !== latestRequest) return false;
  activateLanguage(activation);
  return true;
}
