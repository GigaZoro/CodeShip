import {
  conversationImportNotice,
  conversationImportReport,
  importPolicyChanged,
} from "@t3tools/client-runtime/agent-conversation-import";
import { useNavigate } from "@tanstack/react-router";

import { t } from "~/i18n";
import { agentSessionSync } from "../../state/agentSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { expandSettledShelf } from "../sidebar/settledShelf";
import { toastManager } from "../ui/toast";
import type { SavedScopedServerWrite } from "./scopedSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

// The import runs on the server after the setting saves, and its threads land settled, so say
// what it brought in and where; otherwise turning it on looks like it did nothing.
function useReportConversationImport() {
  const sync = useAtomCommand(agentSessionSync, { reportFailure: false });
  const navigate = useNavigate();
  return (saved: ReadonlyArray<SavedScopedServerWrite>) => {
    const changed = saved.filter(importPolicyChanged);
    if (changed.length === 0) return;
    const toastId = toastManager.add({
      type: "loading",
      title: t("Importing conversations…"),
      timeout: 0,
    });
    void Promise.all(
      changed.map(async (environment) =>
        conversationImportReport(
          environment,
          await sync({ environmentId: environment.environmentId, input: {} }),
        ),
      ),
    ).then((reports) => {
      const { thread, ...notice } = conversationImportNotice(reports);
      toastManager.update(toastId, {
        ...notice,
        timeout: notice.type === "error" ? 0 : 8_000,
        ...(thread === null
          ? {}
          : {
              actionProps: {
                children: t("Show"),
                onClick: () => {
                  toastManager.close(toastId);
                  expandSettledShelf();
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(thread),
                  });
                },
              },
            }),
      });
    });
  };
}

export function AgentConversationsSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const reportImport = useReportConversationImport();
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
              updateSettings(
                { importAgentConversations: Boolean(checked) },
                checked ? { onSaved: reportImport } : undefined,
              )
            }
            aria-label={t("Import Claude Code and Codex conversations")}
          />
        }
      />
    </SettingsSection>
  );
}
