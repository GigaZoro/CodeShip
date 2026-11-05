import {
  PSEUDO_LANGUAGE_PREFERENCE,
  resolveAppLanguage,
  resolveFormattingLocale,
  type AppLanguage,
  type LanguageActivation,
  type LanguagePreference,
  type MessageCatalog,
} from "@t3tools/shared/i18n";

// Loaded on demand so English sessions never download another language's catalog.
const CATALOG_LOADERS: Readonly<Record<Exclude<AppLanguage, "en">, () => Promise<MessageCatalog>>> =
  {
    uk: () => import("./locales/uk.ts").then((module) => module.default),
  };

export function loadMessageCatalog(language: AppLanguage): Promise<MessageCatalog> {
  return language === "en" ? Promise.resolve({}) : CATALOG_LOADERS[language]();
}

/**
 * Resolves a preference against the system's languages and loads its catalog, ready for
 * `activateLanguage`. A catalog that fails to load leaves English and returns the error.
 */
export async function loadLanguage(
  preference: LanguagePreference,
  system: { readonly languages: readonly string[]; readonly locale: string | undefined },
  load: (language: AppLanguage) => Promise<MessageCatalog> = loadMessageCatalog,
): Promise<{ readonly activation: LanguageActivation; readonly error?: unknown }> {
  const settings = {
    formattingLocale: resolveFormattingLocale(preference, system.locale),
    pseudo: preference === PSEUDO_LANGUAGE_PREFERENCE,
  };
  const language = resolveAppLanguage(preference, system.languages);
  try {
    return { activation: { ...settings, language, catalog: await load(language) } };
  } catch (error) {
    return { activation: { ...settings, language: "en", catalog: {} }, error };
  }
}
