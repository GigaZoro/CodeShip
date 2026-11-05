import { t } from "~/i18n";
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
    <SettingsSection id="agent-conversations" title={t("Claude Code and Codex")}>
      <SettingsRow
        serverScoped
        settingKeys={["importAgentConversations"]}
        {...searchableSetting("import-agent-conversations")}
        description={
          isProjectScope
            ? t(
                "Brings this project's past and new Claude Code and Codex conversations into T3.CodeShip, including ones from while T3.CodeShip was closed.",
              )
            : t(
                "Brings past and new Claude Code and Codex conversations from the selected environments into T3.CodeShip, including ones from while T3.CodeShip was closed. Projects can override it.",
              )
        }
        status={
          isProjectScope
            ? undefined
            : t(
                "Only folders added as projects are imported, plus Codex app chats without a project, which go to No project.",
              )
        }
        resetAction={
          settings.importAgentConversations ? (
            <SettingResetButton
              label={t("import conversations")}
              tooltip={t("Reset importing conversations to off")}
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
            aria-label={t("Import Claude Code and Codex conversations")}
          />
        }
      />
    </SettingsSection>
  );
}
