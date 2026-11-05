import { describe, expect, it } from "vite-plus/test";
import {
  activateLanguage,
  normalizeLanguagePreference,
  resolveAppLanguage,
  resolveFormattingLocale,
  t,
  tn,
  translateToParts,
  type MessageCatalog,
} from "./i18n.ts";

const UKRAINIAN: MessageCatalog = {
  "Delete {name}?": "Видалити {name}?",
  "{count} files": { one: "{count} файл", few: "{count} файли", many: "{count} файлів" },
  "Read the {link} first": "Спершу прочитайте {link}",
};

function withLanguage(catalog: MessageCatalog, run: () => void) {
  activateLanguage({ language: "uk", catalog, formattingLocale: "uk" });
  try {
    run();
  } finally {
    activateLanguage({ language: "en", catalog: {}, formattingLocale: undefined });
  }
}

describe("language resolution", () => {
  it("follows the first system locale that has a catalog", () => {
    expect(resolveAppLanguage("system", ["de-DE", "uk-UA", "en-US"])).toBe("uk");
    expect(resolveAppLanguage("system", ["de-DE", "not a locale"])).toBe("en");
    expect(resolveAppLanguage("en", ["uk-UA"])).toBe("en");
  });

  it("reads languages it does not know as the system language", () => {
    expect(normalizeLanguagePreference("uk")).toBe("uk");
    expect(normalizeLanguagePreference("de")).toBe("system");
    expect(normalizeLanguagePreference(undefined)).toBe("system");
  });

  it("keeps the system region only when its language matches the chosen one", () => {
    expect(resolveFormattingLocale("system", "de-DE")).toBe("de-DE");
    expect(resolveFormattingLocale("en", "en-GB")).toBe("en-GB");
    expect(resolveFormattingLocale("uk", "en-US")).toBe("uk");
  });
});

describe("translation", () => {
  it("translates and fills placeholders, falling back to the English source", () => {
    withLanguage(UKRAINIAN, () => {
      expect(t("Delete {name}?", { name: "main" })).toBe("Видалити main?");
      expect(t("Not translated {name}", { name: "x" })).toBe("Not translated x");
      expect(t("Keeps {unknown}", {})).toBe("Keeps {unknown}");
    });
  });

  it("selects the plural form the active language needs", () => {
    withLanguage(UKRAINIAN, () => {
      expect(tn(1, "{count} file", "{count} files")).toBe("1 файл");
      expect(tn(3, "{count} file", "{count} files")).toBe("3 файли");
      expect(tn(5, "{count} file", "{count} files")).toBe("5 файлів");
      expect(tn(1, "{count} folder", "{count} folders")).toBe("1 folder");
    });
    expect(tn(1, "{count} file", "{count} files")).toBe("1 file");
    expect(tn(2, "{count} file", "{count} files")).toBe("2 files");
    expect(tn(1000, "{count} line", "{count} lines")).toBe("1,000 lines");
  });

  it("marks translated text in pseudo mode and leaves placeholder values alone", () => {
    activateLanguage({ language: "en", catalog: {}, formattingLocale: undefined, pseudo: true });
    try {
      expect(t("Delete {name}?", { name: "main" })).toBe("⟦Déléţé main?·····⟧");
      expect(resolveAppLanguage(normalizeLanguagePreference("pseudo"), ["uk"])).toBe("en");
    } finally {
      activateLanguage({ language: "en", catalog: {}, formattingLocale: undefined });
    }
  });

  it("places non-string values where their placeholders fall", () => {
    const link = { element: "docs" };
    withLanguage(UKRAINIAN, () => {
      expect(translateToParts("Read the {link} first", { link })).toEqual([
        "Спершу прочитайте ",
        link,
      ]);
    });
  });
});
