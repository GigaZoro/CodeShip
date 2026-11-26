export const SYSTEM_LANGUAGE = "system";

// Our `zh` is Simplified, so Traditional tags only match an exact locale.
const TRADITIONAL_CHINESE = /^zh[-_](hant|tw|hk|mo)\b/;

function matchSupportedLocale(tag: string, supported: ReadonlyArray<string>): string | undefined {
  const normalized = tag.trim().toLowerCase();
  const language = normalized.split(/[-_]/)[0];
  const exact = supported.find((locale) => locale.toLowerCase() === normalized);
  if (exact || TRADITIONAL_CHINESE.test(normalized)) return exact;
  return supported.find((locale) => locale.toLowerCase() === language);
}

/** Keep the matching system tag for regional formats while loading a supported catalog. */
export function resolveLocaleSelection(
  language: string,
  systemLocales: ReadonlyArray<string>,
  supported: ReadonlyArray<string>,
  fallback: string,
): { readonly catalogLocale: string; readonly formattingLocale: string } {
  if (supported.includes(language)) return { catalogLocale: language, formattingLocale: language };
  for (const tag of systemLocales) {
    const match = matchSupportedLocale(tag, supported);
    if (match) return { catalogLocale: match, formattingLocale: tag.trim().replaceAll("_", "-") };
  }
  return { catalogLocale: fallback, formattingLocale: fallback };
}
