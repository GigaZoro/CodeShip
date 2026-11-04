import { validateSkillsSearch, type SkillsSearch } from "../skills/skillsPage.logic";

export const EXTENSIONS_TABS = ["skills", "plugins", "mcp"] as const;
export type ExtensionsTab = (typeof EXTENSIONS_TABS)[number];

export interface ExtensionsSearch extends SkillsSearch {
  readonly tab?: ExtensionsTab;
}

const isTab = (value: unknown): value is ExtensionsTab =>
  EXTENSIONS_TABS.some((tab) => tab === value);

/** Only the Skills tab has filters; the other tabs keep their state on the page. */
export function validateExtensionsSearch(raw: Record<string, unknown>): ExtensionsSearch {
  const tab = isTab(raw.tab) ? raw.tab : undefined;
  if (tab !== undefined && tab !== "skills") return { tab };
  return { ...(tab ? { tab } : {}), ...validateSkillsSearch(raw) };
}
