import {
  activateLanguage,
  getActiveLanguage,
  isPseudoLanguageActive,
  normalizeLanguagePreference,
  SYSTEM_LANGUAGE_PREFERENCE,
  type LanguagePreference,
} from "@t3tools/shared/i18n";
import { loadLanguage } from "@t3tools/client-runtime/i18n/catalogs";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopClientSettings from "./DesktopClientSettings.ts";

/** Unset or unreadable settings follow the system language. */
export const readLanguagePreference = Effect.fn("desktop.language.readPreference")(function* () {
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const settings = yield* clientSettings.get.pipe(Effect.orElseSucceed(() => Option.none()));
  return Option.isSome(settings)
    ? normalizeLanguagePreference(settings.value.language)
    : SYSTEM_LANGUAGE_PREFERENCE;
});

/** Activates the language `preference` resolves to and returns whether it changed. */
export const activateLanguagePreference = Effect.fn("desktop.language.activate")(function* (
  preference: LanguagePreference,
) {
  const electronApp = yield* ElectronApp.ElectronApp;
  const system = {
    languages: yield* electronApp.preferredSystemLanguages,
    locale: yield* electronApp.systemLocale,
  };
  const { activation, error } = yield* Effect.promise(() => loadLanguage(preference, system));
  if (error !== undefined) {
    yield* Effect.logWarning("Could not load the message catalog.", { cause: error });
  }
  const changed =
    activation.language !== getActiveLanguage() || activation.pseudo !== isPseudoLanguageActive();
  activateLanguage(activation);
  return changed;
});

export const activateSavedLanguage = Effect.fn("desktop.language.activateSaved")(function* () {
  return yield* activateLanguagePreference(yield* readLanguagePreference());
});
