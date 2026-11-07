import {
  globalIdleCompaction,
  type EnvironmentId,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { idleCompactionModeLabel } from "@t3tools/shared/claudeCompaction";
import * as Equal from "effect/Equal";

import {
  searchableSetting,
  settingsSearchItemPage,
  type SettingsPath,
  type SettingsSearchItemId,
} from "./settingsSearch";
import { formatSettingValue } from "./settingValueFormat";

interface ComparedSetting {
  readonly id: SettingsSearchItemId;
  readonly key: keyof ServerSettings;
  /** For settings each server version stores differently, compares what they resolve to. */
  readonly resolve?: (settings: ServerSettings) => unknown;
  readonly format?: (value: unknown) => string;
  readonly patch?: (value: unknown) => ServerSettingsPatch;
}

/**
 * Settings that people keep the same on every machine. Paths, accounts, provider instances, devices,
 * and per-project overrides belong to one machine, so they are left out.
 */
const COMPARED_SETTINGS: ReadonlyArray<ComparedSetting> = [
  { id: "default-model", key: "defaultModelSelection" },
  { id: "last-picked-model", key: "newThreadsUseLastModel" },
  { id: "scheduled-task-model", key: "scheduledTaskModelSelection" },
  { id: "fallback-model", key: "fallbackModelSelection" },
  { id: "text-generation-model", key: "textGenerationModelSelection" },
  { id: "thread-title-instructions", key: "threadTitleInstructions" },
  { id: "source-control-writer-model", key: "sourceControlWriterModelSelection" },
  { id: "review-guide-model", key: "reviewGuideModelSelection" },
  { id: "final-review", key: "finalReviewByDefault" },
  { id: "default-permissions", key: "defaultRuntimeMode" },
  { id: "new-threads", key: "defaultThreadEnvMode" },
  { id: "response-streaming", key: "responseStreamingMode" },
  {
    id: "compact-idle-threads",
    key: "idleCompaction",
    resolve: globalIdleCompaction,
    format: (mode) => idleCompactionModeLabel(mode as ReturnType<typeof globalIdleCompaction>),
    patch: (mode) => ({ idleCompaction: mode as ReturnType<typeof globalIdleCompaction> }),
  },
  { id: "snooze-options", key: "snoozePresets" },
  { id: "snooze-limited-threads", key: "snoozeLimitedThreads" },
  { id: "auto-resume-limited-threads", key: "autoResumeLimitedThreads" },
  { id: "days-before-auto-settle", key: "sidebarAutoSettleAfterDays" },
  { id: "auto-settle-merged-threads", key: "sidebarAutoSettleOnMerge" },
  { id: "keep-threads-with-pull-requests", key: "sidebarAutoSettleKeepPullRequests" },
  { id: "auto-settle-opens-pull-requests", key: "sidebarAutoSettleOpensPullRequests" },
  { id: "scheduled-task-default-placement", key: "scheduledTaskDefaultPlacement" },
  { id: "skill-availability", key: "skillAvailability" },
  { id: "agent-browser-access", key: "enableAgentBrowserAccess" },
  { id: "agent-device-access", key: "enableAgentDeviceAccess" },
  { id: "agent-terminal-access", key: "agentTerminalAccess" },
  { id: "worktree-submodules", key: "worktreeSubmodules" },
  { id: "start-from-origin", key: "newWorktreesStartFromOrigin" },
  { id: "automatic-pull", key: "defaultAutoPull" },
  { id: "storage-worktrees", key: "worktreeCleanup" },
  { id: "worktree-branch-naming", key: "branchNamingMode" },
  { id: "source-control-writing-style", key: "sourceControlWritingStyle" },
  { id: "remove-agent-credits-on-merge", key: "removeAgentCreditsOnMerge" },
  { id: "pull-request-merge-method", key: "pullRequestMergeMethod" },
  { id: "review-guides", key: "reviewGuidesEnabled" },
  { id: "review-guide-instructions", key: "reviewGuideInstructions" },
  { id: "project-actions", key: "defaultProjectScripts" },
  { id: "import-agent-conversations", key: "importAgentConversations" },
  { id: "ghq-clone-layout", key: "ghqCloneLayout" },
  { id: "provider-update-checks", key: "enableProviderUpdateChecks" },
  { id: "auto-update-providers", key: "autoUpdateProviders" },
  { id: "continue-threads-after-server-update", key: "continueThreadsAfterServerUpdate" },
  { id: "background-activity", key: "backgroundActivity" },
  { id: "guest-links", key: "guestSharingEnabled" },
  { id: "linked-environments-beta", key: "linkedEnvironmentsEnabled" },
];

interface DifferenceMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly settings: ServerSettings;
}

interface MachineSettingValue {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly display: string;
  /** Writes this machine's value; sent to every machine to make them all match it. */
  readonly patch: ServerSettingsPatch;
}

interface MachineSettingDifference {
  readonly id: SettingsSearchItemId;
  readonly anchor: string;
  readonly title: string;
  readonly page: SettingsPath;
  readonly values: ReadonlyArray<MachineSettingValue>;
}

/** A machine whose server predates a setting does not report it, so it is left out of that row. */
export function machineSettingDifferences(
  machines: ReadonlyArray<DifferenceMachine>,
): MachineSettingDifference[] {
  return COMPARED_SETTINGS.flatMap((setting) => {
    const values = machines.flatMap((machine) => {
      if (setting.resolve) return [{ machine, value: setting.resolve(machine.settings) }];
      const value = machine.settings[setting.key];
      return value === undefined ? [] : [{ machine, value }];
    });
    const first = values[0];
    if (values.length < 2 || values.every(({ value }) => Equal.equals(value, first?.value))) {
      return [];
    }
    const { id: anchor, title } = searchableSetting(setting.id);
    return [
      {
        id: setting.id,
        anchor,
        title,
        page: settingsSearchItemPage(setting.id),
        values: values.map(({ machine, value }) => ({
          environmentId: machine.environmentId,
          label: machine.label,
          display: setting.format ? setting.format(value) : formatSettingValue(setting.key, value),
          patch: setting.patch
            ? setting.patch(value)
            : ({ [setting.key]: value } as ServerSettingsPatch),
        })),
      },
    ];
  });
}
