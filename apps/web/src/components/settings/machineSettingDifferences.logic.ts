import {
  globalIdleCompaction,
  MACHINE_SHARED_SETTING_KEYS,
  type EnvironmentId,
  type MachineSharedSettingKey,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { idleCompactionModeLabel } from "@t3tools/shared/claudeCompaction";
import { providerUpdatesPatch } from "@t3tools/contracts/settings";
import { t } from "~/i18n";
import * as Equal from "effect/Equal";

import {
  searchableSetting,
  settingsSearchItemPage,
  type SettingsPath,
  type SettingsSearchItemId,
} from "./settingsSearch";
import { formatSettingValue } from "./settingValueFormat";

/** How a shared setting is compared and shown; its key set comes from `MACHINE_SHARED_SETTING_KEYS`. */
interface SettingPresentation {
  readonly id: SettingsSearchItemId;
  /** For settings each server version stores differently, compares what they resolve to. */
  readonly resolve?: (settings: ServerSettings) => unknown;
  readonly format?: (value: unknown) => string;
  readonly patch?: (value: unknown) => ServerSettingsPatch;
}

/**
 * Every shared key needs an entry here, so a key added to the shared list cannot go uncompared.
 * Non-presentations are never compared: `"grouped"` keys sit in another key's row, `"accounts"`
 * name a machine's own accounts, and `"devices"` is the profile devices apply.
 */
const SHARED_SETTING_PRESENTATION: Record<
  MachineSharedSettingKey,
  SettingPresentation | "grouped" | "accounts" | "devices"
> = {
  defaultModelSelection: { id: "default-model" },
  newThreadsUseLastModel: { id: "last-picked-model" },
  scheduledTaskModelSelection: { id: "scheduled-task-model" },
  fallbackModelSelection: { id: "fallback-model" },
  textGenerationModelSelection: { id: "text-generation-model" },
  threadTitleInstructions: { id: "thread-title-instructions" },
  sourceControlWriterModelSelection: { id: "source-control-writer-model" },
  reviewGuideModelSelection: { id: "review-guide-model" },
  finalReviewByDefault: { id: "final-review" },
  defaultRuntimeMode: { id: "default-permissions" },
  defaultThreadEnvMode: { id: "new-threads" },
  responseStreamingMode: { id: "response-streaming" },
  idleCompaction: {
    id: "compact-idle-threads",
    resolve: globalIdleCompaction,
    format: (mode) => idleCompactionModeLabel(mode as ReturnType<typeof globalIdleCompaction>),
    patch: (mode) => ({ idleCompaction: mode as ReturnType<typeof globalIdleCompaction> }),
  },
  snoozePresets: { id: "snooze-options" },
  snoozeLimitedThreads: {
    id: "usage-limit-recovery",
    resolve: (settings) =>
      settings.snoozeLimitedThreads === undefined ||
      settings.autoResumeLimitedThreads === undefined ||
      settings.failoverLimitedThreads === undefined
        ? undefined
        : {
            snoozeLimitedThreads: settings.snoozeLimitedThreads,
            autoResumeLimitedThreads: settings.autoResumeLimitedThreads,
            failoverLimitedThreads: settings.failoverLimitedThreads,
          },
    format: (value) => {
      const settings = value as Pick<
        ServerSettings,
        "snoozeLimitedThreads" | "autoResumeLimitedThreads" | "failoverLimitedThreads"
      >;
      return t("Snooze: {snooze}; resume: {resume}; switch accounts: {switching}.", {
        snooze: settings.snoozeLimitedThreads ? t("On") : t("Off"),
        resume: settings.autoResumeLimitedThreads ? t("On") : t("Off"),
        switching: settings.failoverLimitedThreads ? t("On") : t("Off"),
      });
    },
    patch: (value) => value as ServerSettingsPatch,
  },
  autoResumeLimitedThreads: "grouped",
  failoverLimitedThreads: "grouped",
  sidebarAutoSettleAfterDays: { id: "days-before-auto-settle" },
  sidebarAutoSettleOnMerge: { id: "auto-settle-merged-threads" },
  sidebarAutoSettleKeepPullRequests: { id: "keep-threads-with-pull-requests" },
  sidebarAutoSettleOpensPullRequests: { id: "auto-settle-opens-pull-requests" },
  scheduledTaskDefaultPlacement: { id: "scheduled-task-default-placement" },
  skillAvailability: { id: "skill-availability" },
  enableAgentBrowserAccess: { id: "agent-browser-access" },
  enableAgentDeviceAccess: { id: "agent-device-access" },
  agentTerminalAccess: { id: "agent-terminal-access" },
  worktreeSubmodules: { id: "worktree-submodules" },
  newWorktreesStartFromOrigin: { id: "start-from-origin" },
  defaultAutoPull: { id: "automatic-pull" },
  worktreeCleanup: { id: "storage-worktrees" },
  branchNamingMode: { id: "worktree-branch-naming" },
  sourceControlWritingStyle: { id: "source-control-writing-style" },
  removeAgentCreditsOnMerge: { id: "remove-agent-credits-on-merge" },
  pullRequestMergeMethod: { id: "pull-request-merge-method" },
  reviewGuidesEnabled: { id: "review-guides" },
  reviewGuideInstructions: { id: "review-guide-instructions" },
  importAgentConversations: { id: "import-agent-conversations" },
  ghqCloneLayout: { id: "ghq-clone-layout" },
  enableProviderUpdateChecks: {
    id: "provider-updates",
    resolve: (settings) =>
      settings.enableProviderUpdateChecks === undefined ||
      settings.autoUpdateProviders === undefined
        ? undefined
        : {
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            autoUpdateProviders: settings.autoUpdateProviders,
          },
    format: (value) => {
      const settings = value as ReturnType<typeof providerUpdatesPatch>;
      return t("Checks: {checks}; automatic install: {install}.", {
        checks: settings.enableProviderUpdateChecks ? t("On") : t("Off"),
        install: settings.autoUpdateProviders ? t("On") : t("Off"),
      });
    },
    patch: (value) => value as ReturnType<typeof providerUpdatesPatch>,
  },
  autoUpdateProviders: "grouped",
  installUpdatesAutomatically: { id: "install-updates-automatically" },
  continueThreadsAfterServerUpdate: { id: "continue-threads-after-server-update" },
  backgroundActivity: { id: "background-activity" },
  providerInstanceFailoverOrder: "accounts",
  autoUseResetCredits: "accounts",
  deviceSettingsProfile: "devices",
};

interface ComparedSetting extends SettingPresentation {
  readonly key: keyof ServerSettings;
}

/**
 * Settings that people keep the same on every machine. Paths, accounts, provider instances, devices,
 * and per-project overrides belong to one machine, so they are left out. The last three are not
 * shared either, and are listed so a one-off bulk edit can still make them match; saving them never
 * becomes a shared version.
 */
const COMPARED_SETTINGS: ReadonlyArray<ComparedSetting> = [
  ...MACHINE_SHARED_SETTING_KEYS.flatMap((key) => {
    const presentation = SHARED_SETTING_PRESENTATION[key];
    return typeof presentation === "string" ? [] : [{ key, ...presentation }];
  }),
  { id: "project-actions", key: "defaultProjectScripts" },
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
      const value = setting.resolve
        ? setting.resolve(machine.settings)
        : machine.settings[setting.key];
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
