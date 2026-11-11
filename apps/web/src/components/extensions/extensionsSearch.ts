import { EnvironmentId } from "@t3tools/contracts";

import { validateSkillsSearch, type SkillsSearch } from "../skills/skillsPage.logic";

export const EXTENSIONS_TABS = ["skills", "plugins", "mcp"] as const;
export type ExtensionsTab = (typeof EXTENSIONS_TABS)[number];

/** Opens the MCP tab on one machine, filtered to the server a step names. */
export interface McpFocus {
  readonly environmentId?: EnvironmentId;
  readonly server?: string;
}

export interface ExtensionsSearch extends SkillsSearch, McpFocus {
  readonly tab?: ExtensionsTab;
}

const isTab = (value: unknown): value is ExtensionsTab =>
  EXTENSIONS_TABS.some((tab) => tab === value);

const nonEmptyString = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/** Only the Skills tab has filters; the MCP tab also takes a machine and server to open on. */
export function validateExtensionsSearch(raw: Record<string, unknown>): ExtensionsSearch {
  const tab = isTab(raw.tab) ? raw.tab : undefined;
  if (tab === "mcp") {
    const environmentId = nonEmptyString(raw.environmentId);
    const server = nonEmptyString(raw.server);
    return {
      tab,
      ...(environmentId ? { environmentId: EnvironmentId.make(environmentId) } : {}),
      ...(server ? { server } : {}),
    };
  }
  if (tab !== undefined && tab !== "skills") return { tab };
  return { ...(tab ? { tab } : {}), ...validateSkillsSearch(raw) };
}
