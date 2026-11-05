import { activateLanguage, getActiveLanguage, t } from "@t3tools/shared/i18n";
import { expect, it, vi } from "vite-plus/test";

import { startLanguage } from "./languageBoot";

it("waits for the desktop's saved language before activating the interface", async () => {
  const documentElement = { lang: "en" };
  vi.stubGlobal("document", { documentElement });
  vi.stubGlobal("window", {
    desktopBridge: {
      getLanguageSettings: async () => ({ preference: "uk", systemLanguages: ["en-US"] }),
      getSystemLocale: () => "en-US",
    },
  });
  try {
    await startLanguage();

    expect(getActiveLanguage()).toBe("uk");
    expect(documentElement.lang).toBe("uk");
    expect(t("Language")).toBe("Мова");
  } finally {
    activateLanguage({ language: "en", catalog: {}, formattingLocale: undefined });
    vi.unstubAllGlobals();
  }
});
