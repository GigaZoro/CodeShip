import { describe, expect, it } from "vite-plus/test";

import { loadLanguage } from "./catalogs.ts";

describe("loadLanguage", () => {
  it("loads the catalog of the system language the preference resolves to", async () => {
    const { activation, error } = await loadLanguage("system", {
      languages: ["de-DE", "uk-UA"],
      locale: "uk-UA",
    });
    expect(error).toBeUndefined();
    expect(activation.language).toBe("uk");
    expect(activation.formattingLocale).toBe("uk-UA");
    expect(activation.catalog["Settings"]).toBe("Налаштування");
  });

  it("leaves English when the catalog fails to load", async () => {
    const failure = new Error("chunk failed");
    const { activation, error } = await loadLanguage("uk", { languages: [], locale: "en-US" }, () =>
      Promise.reject(failure),
    );
    expect(error).toBe(failure);
    expect(activation).toEqual({
      language: "en",
      catalog: {},
      formattingLocale: "uk",
      pseudo: false,
    });
  });

  it("builds the pseudo-language on English with the system's formats", async () => {
    const { activation } = await loadLanguage("pseudo", { languages: ["uk"], locale: "uk-UA" });
    expect(activation).toEqual({
      language: "en",
      catalog: {},
      formattingLocale: "uk-UA",
      pseudo: true,
    });
  });
});
