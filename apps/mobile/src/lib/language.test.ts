import { getActiveLanguage, t, type LanguageActivation } from "@t3tools/shared/i18n";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  loadLanguage: vi.fn<() => Promise<{ activation: LanguageActivation }>>(),
}));
vi.mock("@t3tools/client-runtime/i18n/catalogs", () => ({ loadLanguage: mocks.loadLanguage }));

import { applyLanguagePreference } from "./language";

const activation = (language: "en" | "uk", catalog: Record<string, string>) => ({
  activation: { language, catalog, formattingLocale: undefined },
});

describe("applyLanguagePreference", () => {
  it("activates the loaded language", async () => {
    mocks.loadLanguage.mockResolvedValueOnce(activation("uk", { Archive: "Архів" }));
    await expect(applyLanguagePreference("uk")).resolves.toBe(true);
    expect(getActiveLanguage()).toBe("uk");
    expect(t("Archive")).toBe("Архів");
  });

  it("leaves the language to the newer request when two overlap", async () => {
    let finishFirst!: (loaded: { activation: LanguageActivation }) => void;
    mocks.loadLanguage.mockReturnValueOnce(
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
    );
    mocks.loadLanguage.mockResolvedValueOnce(activation("en", {}));
    const first = applyLanguagePreference("uk");
    await applyLanguagePreference("en");
    finishFirst(activation("uk", { Archive: "Архів" }));
    await expect(first).resolves.toBe(false);
    expect(getActiveLanguage()).toBe("en");
  });
});
