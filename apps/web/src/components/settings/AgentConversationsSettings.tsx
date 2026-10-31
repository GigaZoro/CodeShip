import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function AgentConversationsSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { scope } = useSettingsScope();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";

  return (
    <SettingsSection id="agent-conversations" title="Claude Code and Codex">
      <SettingsRow
        serverScoped
        settingKeys={["importAgentConversations"]}
        {...searchableSetting("import-agent-conversations")}
        description={
          isProjectScope
            ? "Brings this project's past and new Claude Code and Codex conversations into CodeShip, including ones from while CodeShip was closed."
            : "Brings past and new Claude Code and Codex conversations from the selected environments into CodeShip, including ones from while CodeShip was closed. Projects can override it."
        }
        status={
          isProjectScope
            ? undefined
            : "Only folders added as projects are imported. Add a project to CodeShip to manage all of its conversations."
        }
        resetAction={
          settings.importAgentConversations ? (
            <SettingResetButton
              label="import conversations"
              tooltip="Reset importing conversations to off"
              onClick={() => updateSettings({ importAgentConversations: false })}
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["importAgentConversations"]}
            checked={settings.importAgentConversations}
            onCheckedChange={(checked) =>
              updateSettings({ importAgentConversations: Boolean(checked) })
            }
            aria-label="Import Claude Code and Codex conversations"
          />
        }
      />
    </SettingsSection>
  );
}
