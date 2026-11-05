import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";

import { isElectron } from "../../env";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { McpServersPanel } from "../mcp/McpServersPage";
import { PluginsPanel } from "../plugins/PluginsPage";
import { SkillsPanel } from "../skills/SkillsPage";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { EXTENSIONS_TABS, type ExtensionsTab } from "./extensionsSearch";

const TAB_LABELS: Record<ExtensionsTab, string> = {
  skills: "Skills",
  plugins: "Plugins",
  mcp: "MCP servers",
};

export function ExtensionsPage() {
  const search = useSearch({ from: "/_chat/extensions" });
  const navigate = useNavigate({ from: "/extensions" });
  const tab = search.tab ?? "skills";
  // Each tab puts its machine picker, search, and filters here, on the header's right.
  const [controlsSlot, setControlsSlot] = useState<HTMLElement | null>(null);

  return (
    <SidebarInset
      {...workspaceAreaProps("extensions", 1, "Extensions")}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b">
          <WorkspaceBreadcrumb ariaLabel="Extensions breadcrumb" className="shrink-0">
            <WorkspaceBreadcrumbItem current>
              <h1>Extensions</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <ToggleGroup
            aria-label="Extension type"
            className="min-w-0 overflow-x-auto"
            value={[tab]}
            onValueChange={(next) => {
              const chosen = EXTENSIONS_TABS.find((candidate) => candidate === next[0]);
              // Pressing the open tab again reports no value; it stays open.
              if (chosen === undefined) return;
              void navigate({
                search: chosen === "skills" ? {} : { tab: chosen },
                replace: true,
                resetScroll: false,
              });
            }}
          >
            {EXTENSIONS_TABS.map((candidate) => (
              <Toggle key={candidate} value={candidate}>
                {TAB_LABELS[candidate]}
              </Toggle>
            ))}
          </ToggleGroup>
          <div ref={setControlsSlot} className="ml-auto flex items-center gap-2" />
        </WorkspacePageHeader>
        {tab === "skills" ? (
          <SkillsPanel controlsSlot={controlsSlot} />
        ) : tab === "plugins" ? (
          <PluginsPanel controlsSlot={controlsSlot} />
        ) : (
          <McpServersPanel controlsSlot={controlsSlot} />
        )}
      </div>
    </SidebarInset>
  );
}
