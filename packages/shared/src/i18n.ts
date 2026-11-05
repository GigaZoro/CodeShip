/**
 * UI translation. Messages are their English source text, so English needs no catalog and a
 * message missing from a catalog still renders in English.
 */

export const APP_LANGUAGES = ["en", "uk"] as const;
export type AppLanguage = (typeof APP_LANGUAGES)[number];

export const SYSTEM_LANGUAGE_PREFERENCE = "system";
/**
 * Development aid: English with every translated string accented, bracketed, and 30% longer, so
 * text that skipped the translator stands out and tight layouts show clipping.
 */
export const PSEUDO_LANGUAGE_PREFERENCE = "pseudo";
export type LanguagePreference =
  | AppLanguage
  | typeof SYSTEM_LANGUAGE_PREFERENCE
  | typeof PSEUDO_LANGUAGE_PREFERENCE;

/** Each language names itself, so a reader finds theirs whatever language the UI is in. */
const APP_LANGUAGE_NATIVE_NAMES: Readonly<Record<AppLanguage, string>> = {
  en: "English",
  uk: "Українська",
};

interface LanguageChoice {
  readonly preference: AppLanguage | typeof PSEUDO_LANGUAGE_PREFERENCE;
  readonly name: string;
}

const PSEUDO_CHOICE: LanguageChoice = {
  preference: PSEUDO_LANGUAGE_PREFERENCE,
  name: "Pseudo (development)",
};

/** The fixed languages a picker offers, each named in itself; "system" is labelled by the caller. */
export function languageChoices(options: {
  readonly includePseudo: boolean;
}): ReadonlyArray<LanguageChoice> {
  const choices: LanguageChoice[] = APP_LANGUAGES.map((language) => ({
    preference: language,
    name: APP_LANGUAGE_NATIVE_NAMES[language],
  }));
  return options.includePseudo ? [...choices, PSEUDO_CHOICE] : choices;
}

declare const MESSAGE: unique symbol;
/** English text marked with `msg()`, so the catalog extractor has seen it. */
export type Message = string & { readonly [MESSAGE]: true };
/** A string literal, which the extractor reads in place, or a `msg()` value from elsewhere. */
export type MessageKey<M extends string> = string extends M ? Message : M;

export type PluralForms = Readonly<Partial<Record<Intl.LDMLPluralRule, string>>>;
export type MessageCatalog = Readonly<Record<string, string | PluralForms>>;
export type MessageValues = Readonly<Record<string, string | number>>;

const ENGLISH_PLURAL_RULES = new Intl.PluralRules("en");
const PLACEHOLDER = /\{(\w+)\}/g;

let activeLanguage: AppLanguage = "en";
let activeCatalog: MessageCatalog = {};
let activePluralRules = ENGLISH_PLURAL_RULES;
let activeFormattingLocale: string | undefined;
let activeCountFormat = new Intl.NumberFormat();
let pseudoActive = false;

function isAppLanguage(value: string): value is AppLanguage {
  return (APP_LANGUAGES as readonly string[]).includes(value);
}

/** Unknown values, such as a language a newer client saved, fall back to the system language. */
export function normalizeLanguagePreference(value: string | null | undefined): LanguagePreference {
  if (value === PSEUDO_LANGUAGE_PREFERENCE) return value;
  return value && isAppLanguage(value) ? value : SYSTEM_LANGUAGE_PREFERENCE;
}

function languageOf(locale: string): string | undefined {
  try {
    return new Intl.Locale(locale).language;
  } catch {
    return undefined;
  }
}

/** The system's first preferred locale that has a catalog decides; otherwise English. */
export function resolveAppLanguage(
  preference: LanguagePreference,
  systemLocales: readonly string[],
): AppLanguage {
  if (preference === PSEUDO_LANGUAGE_PREFERENCE) return "en";
  if (preference !== SYSTEM_LANGUAGE_PREFERENCE) return preference;
  for (const locale of systemLocales) {
    const language = languageOf(locale);
    if (language !== undefined && isAppLanguage(language)) return language;
  }
  return "en";
}

/**
 * Locale for dates and numbers. Following the system keeps today's regional formats; a chosen
 * language keeps the system's region only when it is the same language (en-GB stays en-GB).
 */
export function resolveFormattingLocale(
  preference: LanguagePreference,
  systemLocale: string | undefined,
): string | undefined {
  if (preference === SYSTEM_LANGUAGE_PREFERENCE || preference === PSEUDO_LANGUAGE_PREFERENCE) {
    return systemLocale;
  }
  if (systemLocale !== undefined && languageOf(systemLocale) === preference) return systemLocale;
  return preference;
}

export interface LanguageActivation {
  readonly language: AppLanguage;
  readonly catalog: MessageCatalog;
  readonly formattingLocale: string | undefined;
  readonly pseudo?: boolean;
}

export function activateLanguage(options: LanguageActivation): void {
  activeLanguage = options.language;
  activeCatalog = options.catalog;
  activePluralRules =
    options.language === "en" ? ENGLISH_PLURAL_RULES : new Intl.PluralRules(options.language);
  activeFormattingLocale = options.formattingLocale;
  activeCountFormat = new Intl.NumberFormat(options.formattingLocale);
  pseudoActive = options.pseudo === true;
}

export function getActiveLanguage(): AppLanguage {
  return activeLanguage;
}

export function isPseudoLanguageActive(): boolean {
  return pseudoActive;
}

/** Pass to `Intl` formatters and `toLocale*String`; `undefined` means the runtime default. */
export function getFormattingLocale(): string | undefined {
  return activeFormattingLocale;
}

const PSEUDO_LETTERS: Readonly<Record<string, string>> = {
  a: "á",
  c: "ç",
  e: "é",
  g: "ĝ",
  i: "î",
  n: "ñ",
  o: "ö",
  s: "š",
  t: "ţ",
  u: "ü",
  y: "ý",
  A: "Á",
  C: "Ç",
  E: "É",
  G: "Ĝ",
  I: "Î",
  N: "Ñ",
  O: "Ö",
  S: "Š",
  T: "Ţ",
  U: "Ü",
  Y: "Ý",
};

function pseudoize(text: string): string {
  const body = text
    .split(/(\{\w+\})/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(/[A-Za-z]/g, (letter) => PSEUDO_LETTERS[letter] ?? letter),
    )
    .join("");
  return `⟦${body}${"·".repeat(Math.ceil(text.length * 0.3))}⟧`;
}

function displayed(translated: string | PluralForms | undefined, message: string): string {
  const text = typeof translated === "string" ? translated : message;
  return pseudoActive ? pseudoize(text) : text;
}

function interpolate(text: string, values: MessageValues | undefined): string {
  if (values === undefined) return text;
  return text.replace(PLACEHOLDER, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder,
  );
}

/** Translates English source text. `{name}` placeholders take `values`. */
export function t<M extends string>(message: MessageKey<M>, values?: MessageValues): string {
  return interpolate(displayed(activeCatalog[message], message), values);
}

/**
 * Translates a count-dependent message; `other` is the catalog key and `{count}` is filled in,
 * grouped for the formatting locale ("1,000").
 * Catalogs give each plural category the target language uses (Ukrainian: one, few, many).
 */
export function tn(count: number, one: string, other: string, values?: MessageValues): string {
  const translated = activeCatalog[other];
  const text =
    translated !== undefined && typeof translated !== "string"
      ? (translated[activePluralRules.select(count)] ?? translated.other ?? other)
      : ENGLISH_PLURAL_RULES.select(count) === "one"
        ? one
        : other;
  return interpolate(pseudoActive ? pseudoize(text) : text, {
    count: activeCountFormat.format(count),
    ...values,
  });
}

/**
 * Marks English text for translation without translating it yet, for tables built at module
 * load. Translate the stored value with `t(...)` where it renders.
 */
export function msg(message: string): Message {
  return message as Message;
}

/** Like `t`, but placeholders may take non-string values such as React elements. */
export function translateToParts<M extends string, T>(
  message: MessageKey<M>,
  values: Readonly<Record<string, T>>,
): Array<string | T> {
  const text = displayed(activeCatalog[message], message);
  const parts: Array<string | T> = [];
  let cursor = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? "";
    if (!Object.hasOwn(values, name)) continue;
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push(values[name] as T);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}
