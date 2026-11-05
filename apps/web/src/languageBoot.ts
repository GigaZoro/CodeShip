import { activateLanguage, normalizeLanguagePreference } from "@t3tools/shared/i18n";
import { loadLanguage } from "@t3tools/client-runtime/i18n/catalogs";

// Read raw so the boot path stays free of the settings schema; `clientPersistenceStorage` owns the key.
const BROWSER_CLIENT_SETTINGS_KEY = "t3code:client-settings:v1";

function readBrowserLanguagePreference(): unknown {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(BROWSER_CLIENT_SETTINGS_KEY) ?? "null");
    return stored !== null && typeof stored === "object" && "language" in stored
      ? stored.language
      : undefined;
  } catch {
    return undefined;
  }
}

async function readLanguageSettings() {
  const bridge = window.desktopBridge;
  if (bridge) {
    // The packaged desktop app pins `navigator.language` to en-US, so the OS answers instead.
    const { preference, systemLanguages } = await bridge.getLanguageSettings();
    return {
      preference: normalizeLanguagePreference(preference),
      systemLanguages,
      systemLocale: bridge.getSystemLocale() ?? undefined,
    };
  }
  const preference = readBrowserLanguagePreference();
  return {
    preference: normalizeLanguagePreference(typeof preference === "string" ? preference : null),
    systemLanguages: navigator.languages,
    systemLocale: navigator.language,
  };
}

/** Runs before the app's modules load, so everything renders in the chosen language. */
export async function startLanguage(): Promise<void> {
  const { preference, systemLanguages, systemLocale } = await readLanguageSettings();
  const { activation, error } = await loadLanguage(preference, {
    languages: systemLanguages,
    locale: systemLocale,
  });
  // A catalog chunk that fails to load leaves the app in English rather than blocking boot.
  if (error !== undefined) console.error("Could not load the UI language catalog.", { error });
  activateLanguage(activation);
  document.documentElement.lang = activation.language;
}
