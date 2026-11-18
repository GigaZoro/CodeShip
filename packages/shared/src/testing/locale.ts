import { beforeEach } from "vite-plus/test";

import { activateLanguage, type LanguageActivation } from "../i18n.ts";

// Client tests run with a Ukrainian runtime default locale on every host, so a test that expects
// English from the host locale fails everywhere, not only on a non-English machine. `LANG` cannot
// do this: Node ignores it on Windows.
const FORCED_DEFAULT_LOCALE = "uk-UA";

/** The app always activates a formatting locale at startup; every test starts with this one. */
export const TEST_LANGUAGE: LanguageActivation = {
  language: "en",
  catalog: {},
  formattingLocale: "en-US",
};

const INTL_CONSTRUCTORS = [
  "Collator",
  "DateTimeFormat",
  "DisplayNames",
  "DurationFormat",
  "ListFormat",
  "NumberFormat",
  "PluralRules",
  "RelativeTimeFormat",
  "Segmenter",
];

const LOCALE_METHODS: ReadonlyArray<
  readonly [prototype: object, method: string, localesIndex: number]
> = [
  [Date.prototype, "toLocaleString", 0],
  [Date.prototype, "toLocaleDateString", 0],
  [Date.prototype, "toLocaleTimeString", 0],
  [Number.prototype, "toLocaleString", 0],
  [BigInt.prototype, "toLocaleString", 0],
  [String.prototype, "localeCompare", 1],
  [String.prototype, "toLocaleLowerCase", 0],
  [String.prototype, "toLocaleUpperCase", 0],
];

function withForcedDefault(locales: unknown): unknown {
  const isDefault = locales === undefined || (Array.isArray(locales) && locales.length === 0);
  return isDefault ? FORCED_DEFAULT_LOCALE : locales;
}

for (const name of INTL_CONSTRUCTORS) {
  const constructor: unknown = Reflect.get(Intl, name);
  if (typeof constructor !== "function") continue;
  Reflect.set(
    Intl,
    name,
    new Proxy(constructor, {
      construct: (target, [locales, ...rest]: unknown[], newTarget) =>
        Reflect.construct(target, [withForcedDefault(locales), ...rest], newTarget),
      apply: (target, thisArg, [locales, ...rest]: unknown[]) =>
        Reflect.apply(target, thisArg, [withForcedDefault(locales), ...rest]),
    }),
  );
}

for (const [prototype, method, localesIndex] of LOCALE_METHODS) {
  const original: unknown = Reflect.get(prototype, method);
  if (typeof original !== "function") continue;
  Reflect.set(prototype, method, function (this: unknown, ...args: unknown[]) {
    args[localesIndex] = withForcedDefault(args[localesIndex]);
    return Reflect.apply(original, this, args);
  });
}

// Node and Chromium read these from the host, not from Intl's default.
const FORCED_LANGUAGES = Object.freeze([FORCED_DEFAULT_LOCALE]);
Object.defineProperties(navigator, {
  language: { configurable: true, get: () => FORCED_DEFAULT_LOCALE },
  languages: { configurable: true, get: () => FORCED_LANGUAGES },
});

// Modules a test file imports read the language when they load; each test may switch it freely.
activateLanguage(TEST_LANGUAGE);
beforeEach(() => activateLanguage(TEST_LANGUAGE));
