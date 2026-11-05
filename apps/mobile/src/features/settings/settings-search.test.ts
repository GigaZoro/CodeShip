import { activateLanguage, msg } from "@t3tools/shared/i18n";
import { describe, expect, it } from "vite-plus/test";

import { filterSettingsSections } from "./settings-search";

const SECTIONS = [
  { rows: [{ id: "usage", label: msg("Usage") }] },
  {
    title: msg("Connections"),
    rows: [
      { id: "account", label: msg("T3 Account") },
      { id: "SettingsEnvironments", label: msg("Environments") },
    ],
  },
  {
    title: msg("Interface"),
    rows: [
      { id: "SettingsAppearance", label: msg("Appearance") },
      { id: "SettingsKeyboard", label: msg("Keyboard") },
    ],
  },
  {
    title: msg("Server settings"),
    rows: [
      { id: "SettingsProviderAccounts", label: msg("Provider accounts") },
      { id: "SettingsEnvironmentSourceControl", label: msg("Source control") },
    ],
  },
];

function visible(query: string) {
  return filterSettingsSections(SECTIONS, query).map((section) => [
    section.title ?? null,
    section.rows.map((row) => row.label),
  ]);
}

describe("filterSettingsSections", () => {
  it.each([
    {
      query: "",
      expected: SECTIONS.map((section) => [
        section.title ?? null,
        section.rows.map((row) => row.label),
      ]),
    },
    { query: "   ", expected: visible("") },
    { query: "appear", expected: [["Interface", ["Appearance"]]] },
    { query: "KEYBOARD", expected: [["Interface", ["Keyboard"]]] },
    { query: "dark mode", expected: [["Interface", ["Appearance"]]] },
    { query: "agent credits", expected: [["Server settings", ["Source control"]]] },
    {
      query: "server settings",
      expected: [["Server settings", ["Provider accounts", "Source control"]]],
    },
    {
      query: "accounts",
      expected: [["Server settings", ["Provider accounts"]]],
    },
    { query: "usage", expected: [[null, ["Usage"]]] },
    { query: "zzzz", expected: [] },
  ])("$query", ({ query, expected }) => {
    expect(visible(query)).toEqual(expected);
  });

  it("drops sections that start empty", () => {
    expect(filterSettingsSections([{ rows: [] }, ...SECTIONS], "").length).toBe(SECTIONS.length);
  });

  it("matches a query in the active language and in English", () => {
    activateLanguage({
      language: "uk",
      catalog: { Keyboard: "Клавіатура", Interface: "Інтерфейс" },
      formattingLocale: "uk",
    });
    try {
      expect(visible("клавіат")).toEqual([["Interface", ["Keyboard"]]]);
      expect(visible("keyboard")).toEqual([["Interface", ["Keyboard"]]]);
    } finally {
      activateLanguage({ language: "en", catalog: {}, formattingLocale: undefined });
    }
  });
});
