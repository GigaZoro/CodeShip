import { Link } from "@tanstack/react-router";
import { Button } from "../ui/button";
import { t } from "~/i18n";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { AdvancedSettings } from "./AdvancedSettings";
import { BranchNamingSettings } from "./BranchNamingSettings";
import { WorktreeSubmodulesRow } from "./ProjectDefaultsSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { WorktreesDirectoryRow } from "./StorageSettings";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function StartFromRemoteRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["newWorktreesStartFromOrigin"]}
      {...searchableSetting("start-from-origin")}
      description={t(
        "Uses the latest commit of the base branch’s tracked remote branch, even if its name differs. Otherwise uses the same-named branch on origin. Uses your local branch if that remote branch is missing.",
      )}
      resetAction={
        settings.newWorktreesStartFromOrigin !==
        DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
          <SettingResetButton
            label={t("new worktrees start from remote")}
            onClick={() =>
              updateSettings({
                newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["newWorktreesStartFromOrigin"]}
          checked={settings.newWorktreesStartFromOrigin}
          onCheckedChange={(checked) =>
            updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
          }
          aria-label={t("Start new worktrees from remote by default")}
        />
      }
    />
  );
}

/** Worktree creation, naming, and cleanup, shown on Source control & worktrees. */
export function WorktreesSettingsSections() {
  const { scope } = useSettingsScope();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";

  return (
    <>
      <SettingsSection id="worktree-creation" title={t("Creation")}>
        {!isProjectScope && <WorktreesDirectoryRow />}
        <StartFromRemoteRow />
        <AdvancedSettings targetIds={[searchableSetting("worktree-submodules").id]}>
          <WorktreeSubmodulesRow />
        </AdvancedSettings>
      </SettingsSection>
      <SettingsSection id="worktree-branches" title={t("Branches")}>
        <BranchNamingSettings />
      </SettingsSection>
      <SettingsSection title={t("Storage & cleanup")}>
        <SettingsRow
          title={t("Worktree cleanup")}
          description={t(
            "Configure automatic deletion in Maintenance & about → Storage & cleanup.",
          )}
          control={
            <Button
              variant="outline"
              size="sm"
              render={<Link to="/settings/maintenance" search={{}} hash="storage-worktrees" />}
            >
              {t("Open")}
            </Button>
          }
        />
      </SettingsSection>
    </>
  );
}
