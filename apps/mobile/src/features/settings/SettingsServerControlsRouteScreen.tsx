import {
  ProviderUpdatesChoice,
  providerUpdatesChoice,
  providerUpdatesPatch,
} from "@t3tools/contracts/settings";
import { SettingsMenuRow } from "./components/SettingsMenuRow";
import { msg, t, type Message } from "../../lib/i18n";
import { useNavigation } from "@react-navigation/native";
import { SettingsRow } from "./components/SettingsRow";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
import {
  type AgentTerminalAccess,
  type ResponseStreamingMode,
  type ServerSettings,
  type ServerSettingsPatch,
  type ThreadEnvMode,
  type WorktreeSubmodules,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectScopedServerSettingKey,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  RUNTIME_MODE_CHOICES,
  withManagedRuntimeModeLimits,
} from "../threads/thread-settings-options";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { BranchNamingSettings } from "./components/BranchNamingSettings";
import { DefaultModelSettings } from "./components/DefaultModelSettings";
import { DatabaseStorageNotice } from "./components/DatabaseStorageNotice";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SourceControlSignInSection } from "./components/SourceControlSignInSection";
import { SettingsProjectOverridesSection } from "./components/SettingsProjectOverridesSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { useReportConversationImport } from "./useReportConversationImport";
import { useSettingsWriter } from "./useSettingsWriter";
import {
  managedSettingReason,
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
  type ScopedMobileSettingsTarget,
} from "./settings-scoped-server";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import {
  AutoSettleSettingsRows,
  LinkedEnvironmentsSettingsSection,
} from "./ThreadSettingsSections";
import { AppSettingsSection } from "./SettingsAboutSection";
import { FollowSharedSettingsSection } from "./FollowSharedSettingsSection";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";

type SettingsPage = "threads" | "source-control" | "maintenance";

const updateLabels = {
  off: msg("Off"),
  notify: msg("Notify me"),
  automatic: msg("Install automatically"),
  custom: msg("Custom: automatic updates without checks"),
};

const PAGE_TITLES: Record<SettingsPage, Message> = {
  threads: msg("Threads"),
  "source-control": msg("Source control & worktrees"),
  maintenance: msg("Maintenance & about"),
};

const PAGE_PROJECT_KEYS: Record<SettingsPage, readonly ProjectScopedServerSettingKey[]> = {
  threads: [
    "defaultModelSelection",
    "defaultThreadEnvMode",
    "defaultRuntimeMode",
    "responseStreamingMode",
    "enableAgentBrowserAccess",
    "agentTerminalAccess",
    "importAgentConversations",
    "sidebarAutoSettleOnMerge",
    "sidebarAutoSettleAfterDays",
  ],
  "source-control": [
    "defaultAutoPull",
    "removeAgentCreditsOnMerge",
    "newWorktreesStartFromOrigin",
    "worktreeSubmodules",
    "branchNamingMode",
    "branchNamePrefix",
    "branchNameInstructions",
  ],
  maintenance: ["continueThreadsAfterServerUpdate"],
};

const SUBMODULE_CHOICES: ReadonlyArray<{
  readonly mode: WorktreeSubmodules | null;
  readonly label: Message;
  readonly description: Message;
}> = [
  {
    mode: null,
    label: msg("Inherit"),
    description: msg("Use the repository's t3.json, or initialize recursively."),
  },
  {
    mode: "recursive",
    label: msg("Recursive"),
    description: msg("Initialize nested submodules too."),
  },
  {
    mode: "top-level",
    label: msg("Top level only"),
    description: msg("Skip submodules declared inside other submodules."),
  },
  {
    mode: "none",
    label: msg("Skip"),
    description: msg("Leave submodules empty for a setup script."),
  },
];

const WORKSPACE_CHOICES: ReadonlyArray<{
  readonly mode: ThreadEnvMode | null;
  readonly label: Message;
  readonly description: Message;
}> = [
  {
    mode: null,
    label: msg("Inherit"),
    description: msg("Use the repository's t3.json, or the current checkout."),
  },
  {
    mode: "local",
    label: msg("Current checkout"),
    description: msg("Start new threads in the existing workspace."),
  },
  {
    mode: "worktree",
    label: msg("New worktree"),
    description: msg("Give each new thread a separate checkout."),
  },
];

const TERMINAL_ACCESS_CHOICES: ReadonlyArray<{
  readonly level: AgentTerminalAccess;
  readonly label: Message;
  readonly description: Message;
}> = [
  {
    level: "none",
    label: msg("No access"),
    description: msg("Agents can't see their threads' terminals."),
  },
  {
    level: "read",
    label: msg("Read output"),
    description: msg("Agents can read the output of their threads' terminals."),
  },
  {
    level: "read-write",
    label: msg("Read and run commands"),
    description: msg(
      "Agents can also type commands into their threads' terminals, in threads with Full access.",
    ),
  },
];

const STREAMING_CHOICES: ReadonlyArray<{
  readonly mode: ResponseStreamingMode;
  readonly label: Message;
  readonly description: Message;
}> = [
  {
    mode: "turn",
    label: msg("After the turn"),
    description: msg("Show the answer when the agent finishes."),
  },
  {
    mode: "paragraph",
    label: msg("Finished paragraphs"),
    description: msg("Show each paragraph or code block as it completes."),
  },
];

// Only servers with thread auto-settlement store these, so other targets get the rest of a patch.
const AUTO_SETTLE_SETTING_KEYS: ReadonlySet<string> = new Set([
  "sidebarAutoSettleOnMerge",
  "sidebarAutoSettleAfterDays",
  "autoResumeLimitedThreads",
  "snoozeLimitedThreads",
  "failoverLimitedThreads",
]);

function planServerSettingsWrites(
  targets: readonly ScopedMobileSettingsTarget[],
  projectSelected: boolean,
  patch: ServerSettingsPatch,
) {
  const capable = targets.filter((target) => supportsSharedSettingsSync(target.environment));
  const others = targets.filter((target) => !supportsSharedSettingsSync(target.environment));
  const othersPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => !AUTO_SETTLE_SETTING_KEYS.has(key)),
  ) as ServerSettingsPatch;
  return [
    ...planMobileScopedSettingsPatch(capable, projectSelected, patch),
    ...(Object.keys(othersPatch).length > 0
      ? planMobileScopedSettingsPatch(others, projectSelected, othersPatch)
      : []),
  ];
}

export function SettingsThreadsRouteScreen() {
  return <ServerSettingsDetail page="threads" />;
}

export function SettingsEnvironmentSourceControlRouteScreen() {
  return <ServerSettingsDetail page="source-control" />;
}

export function SettingsEnvironmentMaintenanceRouteScreen() {
  return <ServerSettingsDetail page="maintenance" />;
}

function ServerSettingsDetail(props: { readonly page: SettingsPage }) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const writableEnvironments = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const projectSelected = selectedProjectKey !== null;
  const targets = resolveMobileSettingsTargets(
    selectedTargets,
    projectSelected ? (selectedProject?.members.map((member) => member.project) ?? []) : null,
  );
  const [pendingWrites, setPendingWrites] = useState(0);
  const writeInFlight = useRef(false);
  // Closing views can save after controls disable; queue those patches behind the pending write.
  const queuedPatch = useRef<{ key: string; patch: ServerSettingsPatch } | null>(null);
  const targetsKey = targets
    .map((target) => `${target.environment.environmentId}:${target.projectId}`)
    .join(",");
  const [pendingTargets, setPendingTargets] = useState<
    readonly ScopedMobileSettingsTarget[] | null
  >(null);
  const canWriteSettings =
    targets.length > 0 &&
    targets.every((target) => writableEnvironments.has(target.environment.environmentId));
  const displayTargets = pendingWrites > 0 && pendingTargets !== null ? pendingTargets : targets;
  const hasConnectedSelection = targets.length > 0;
  const reference = displayTargets[0] ?? null;
  const uniform = <K extends keyof ServerSettings>(key: K) =>
    uniformMobileSetting(displayTargets, key);
  // `uniform` folds a real null into "mixed"; nullable keys need the distinction.
  const isMixed = (key: keyof ServerSettings) =>
    reference === null ||
    displayTargets.some((entry) => entry.settings[key] !== reference.settings[key]);
  const writeSettings = useSettingsWriter();
  const reportImport = useReportConversationImport();
  const write = (patch: ServerSettingsPatch) => {
    if (writeInFlight.current) {
      const queued = queuedPatch.current;
      queuedPatch.current = {
        key: targetsKey,
        patch: queued?.key === targetsKey ? { ...queued.patch, ...patch } : patch,
      };
      return;
    }
    if (
      !hasConnectedSelection ||
      !targets.every((target) =>
        readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    const writes = planServerSettingsWrites(targets, projectSelected, patch);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(targets);
    setPendingWrites((count) => count + 1);
    void writeSettings(targets, writes)
      .then((saved) => {
        if (patch.importAgentConversations === true) void reportImport(saved);
      })
      .finally(() => {
        writeInFlight.current = false;
        setPendingTargets(null);
        setPendingWrites((count) => count - 1);
        const queued = queuedPatch.current;
        queuedPatch.current = null;
        // These targets may not show this write yet, so send it again with the
        // queued patch; project overrides are replaced whole.
        if (queued?.key === targetsKey) write({ ...patch, ...queued.patch });
      });
  };
  const clearProjectOverrides = () => {
    if (
      writeInFlight.current ||
      !targets.every((target) =>
        readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    const writes = planMobileScopedSettingsClear(targets, PAGE_PROJECT_KEYS[props.page]);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(targets);
    setPendingWrites((count) => count + 1);
    void writeSettings(targets, writes).finally(() => {
      writeInFlight.current = false;
      // Resending a draft over these pre-clear targets would undo the clear.
      queuedPatch.current = null;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };
  const disabled = !canWriteSettings || pendingWrites > 0 || !hasConnectedSelection;
  const managed = (...keys: string[]) => managedSettingReason(targets, ...keys);
  // A locked row keeps its explanation and says who manages it.
  const managedSubtitle = (key: string | string[], subtitle: string) => {
    const reason = managed(...(typeof key === "string" ? [key] : key));
    return reason === undefined ? subtitle : `${subtitle} ${reason}`;
  };
  const runtimeModeChoices = withManagedRuntimeModeLimits(
    RUNTIME_MODE_CHOICES,
    targets.map((target) => target.environment.serverConfig.managedPolicy),
  );
  const everyTargetSupports = (capability: "lastPickedModel" | "scheduledTaskDefaultModel") =>
    displayTargets.every(
      (target) => target.environment.serverConfig.environment.capabilities[capability] === true,
    );
  const disabledFor = (key: string) =>
    disabled ||
    managed(key) !== undefined ||
    (projectSelected &&
      !PROJECT_SCOPED_SERVER_SETTING_KEYS.includes(
        key as (typeof PROJECT_SCOPED_SERVER_SETTING_KEYS)[number],
      ));

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen
        title={t(PAGE_TITLES[props.page])}
        trailing={<AndroidSettingsEnvironmentFilter />}
      >
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {!hasConnectedSelection || reference === null ? (
            <Text className="px-2 text-base text-foreground-muted">
              {projectSelected
                ? t("Select a project with a checkout on a connected environment.")
                : t("Use the filter above to select a connected environment.")}
            </Text>
          ) : (
            <>
              <ManagedPolicyNotice targets={targets} />
              {projectSelected ? (
                <SettingsProjectOverridesSection
                  projectLabel={selectedProject?.label ?? t("Unavailable project")}
                  hasOverrides={targets.some((target) =>
                    PAGE_PROJECT_KEYS[props.page].some((key) => target.sources[key] === "project"),
                  )}
                  pending={pendingWrites > 0}
                  disabled={!canWriteSettings}
                  onClear={clearProjectOverrides}
                />
              ) : null}
              {props.page === "threads" ? (
                <>
                  <DefaultModelSettings
                    targets={displayTargets}
                    disabled={disabledFor("defaultModelSelection")}
                    {...(!projectSelected && everyTargetSupports("lastPickedModel")
                      ? {
                          lastPicked: {
                            value: uniform("newThreadsUseLastModel"),
                            disabled: disabledFor("newThreadsUseLastModel"),
                          },
                        }
                      : {})}
                    onChange={write}
                  />
                  {!projectSelected && everyTargetSupports("scheduledTaskDefaultModel") ? (
                    <DefaultModelSettings
                      targets={displayTargets}
                      setting="scheduledTaskModelSelection"
                      disabled={disabledFor("scheduledTaskModelSelection")}
                      onChange={write}
                    />
                  ) : null}
                  <SettingsSection
                    title={t("Default workspace")}
                    footer={managed("defaultThreadEnvMode")}
                    trailing={
                      pendingWrites === 0 && isMixed("defaultThreadEnvMode") ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {WORKSPACE_CHOICES.filter(
                      (choice) => choice.mode !== null || !projectSelected,
                    ).map((choice, index) => (
                      <SettingsChoiceRow
                        key={choice.mode ?? "inherit"}
                        label={t(choice.label)}
                        description={t(choice.description)}
                        selected={
                          !isMixed("defaultThreadEnvMode") &&
                          uniform("defaultThreadEnvMode") === choice.mode
                        }
                        separated={index > 0}
                        disabled={disabledFor("defaultThreadEnvMode")}
                        onPress={() => write({ defaultThreadEnvMode: choice.mode })}
                      />
                    ))}
                  </SettingsSection>
                  <SettingsSection
                    title={t("Default permissions")}
                    footer={managed("defaultRuntimeMode")}
                    trailing={
                      pendingWrites === 0 && uniform("defaultRuntimeMode") === null ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {runtimeModeChoices.map((choice, index) => (
                      <SettingsChoiceRow
                        key={choice.mode}
                        label={t(choice.label)}
                        description={choice.disabledReason ?? t(choice.description)}
                        selected={uniform("defaultRuntimeMode") === choice.mode}
                        separated={index > 0}
                        disabled={
                          disabledFor("defaultRuntimeMode") || choice.disabledReason !== undefined
                        }
                        onPress={() => write({ defaultRuntimeMode: choice.mode })}
                      />
                    ))}
                  </SettingsSection>
                  <SettingsSection
                    title={t("Response streaming")}
                    footer={managed("responseStreamingMode")}
                    trailing={
                      pendingWrites === 0 && uniform("responseStreamingMode") === null ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {STREAMING_CHOICES.map((choice, index) => (
                      <SettingsChoiceRow
                        key={choice.mode}
                        label={t(choice.label)}
                        description={t(choice.description)}
                        selected={uniform("responseStreamingMode") === choice.mode}
                        separated={index > 0}
                        disabled={disabledFor("responseStreamingMode")}
                        onPress={() => write({ responseStreamingMode: choice.mode })}
                      />
                    ))}
                  </SettingsSection>
                  <SettingsSection title={t("Preview browser")}>
                    <SettingsSwitchRow
                      icon="globe"
                      label={t("Agent browser access")}
                      subtitle={managedSubtitle(
                        "enableAgentBrowserAccess",
                        t("Allow agents to use the in-app preview browser."),
                      )}
                      value={uniform("enableAgentBrowserAccess")}
                      disabled={disabledFor("enableAgentBrowserAccess")}
                      onValueChange={(value) => write({ enableAgentBrowserAccess: value })}
                    />
                  </SettingsSection>
                  <SettingsSection
                    title={t("Agent terminal access")}
                    footer={managed("agentTerminalAccess")}
                    trailing={
                      pendingWrites === 0 && uniform("agentTerminalAccess") === null ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {TERMINAL_ACCESS_CHOICES.map((choice, index) => (
                      <SettingsChoiceRow
                        key={choice.level}
                        label={t(choice.label)}
                        description={t(choice.description)}
                        selected={uniform("agentTerminalAccess") === choice.level}
                        separated={index > 0}
                        disabled={disabledFor("agentTerminalAccess")}
                        onPress={() => write({ agentTerminalAccess: choice.level })}
                      />
                    ))}
                  </SettingsSection>
                  <SettingsSection
                    title={t("Claude Code and Codex")}
                    footer={
                      projectSelected
                        ? undefined
                        : t(
                            "Only folders added as projects are imported, plus Codex app chats without a project, which go to No project.",
                          )
                    }
                  >
                    <SettingsSwitchRow
                      icon="bubble.left.and.bubble.right"
                      label={t("Import conversations")}
                      subtitle={t(
                        "Bring past and new conversations into T3.CodeShip, including ones from while it was closed.",
                      )}
                      value={uniform("importAgentConversations")}
                      disabled={disabledFor("importAgentConversations")}
                      onValueChange={(value) => write({ importAgentConversations: value })}
                    />
                  </SettingsSection>
                  <AutoSettleSettingsRows write={write} pending={pendingWrites > 0} />
                </>
              ) : null}

              {props.page === "source-control" ? (
                <>
                  {projectSelected ? null : (
                    <SourceControlSignInSection
                      environments={selectedTargets}
                      canWrite={(environmentId) => writableEnvironments.has(environmentId)}
                    />
                  )}
                  <SettingsSection title={t("Pull requests")}>
                    <SettingsSwitchRow
                      icon={PullRequestGlyph.merged}
                      label={t("Remove agent credits when merging")}
                      subtitle={managedSubtitle(
                        "removeAgentCreditsOnMerge",
                        t(
                          "Remove recognized agent credits from merge and squash messages on hosts that support it, keeping human co-authors. Includes auto-merge. Excludes merge queues, stack merges, and existing commits.",
                        ),
                      )}
                      value={uniform("removeAgentCreditsOnMerge")}
                      disabled={disabledFor("removeAgentCreditsOnMerge")}
                      onValueChange={(value) => write({ removeAgentCreditsOnMerge: value })}
                    />
                  </SettingsSection>
                  <SettingsSection title={t("Default branch")}>
                    <SettingsSwitchRow
                      icon="arrow.down.circle"
                      label={t("Automatically pull")}
                      subtitle={managedSubtitle(
                        "defaultAutoPull",
                        t("Keep the default branch current when there are no local changes."),
                      )}
                      value={uniform("defaultAutoPull")}
                      disabled={disabledFor("defaultAutoPull")}
                      onValueChange={(value) => write({ defaultAutoPull: value })}
                    />
                  </SettingsSection>
                  <SettingsSection title={t("Clones")}>
                    <SettingsSwitchRow
                      icon="folder"
                      label={t("Clone into host folders")}
                      subtitle={t(
                        "Clones go to github.com/owner/repo under the Add project folder, like ghq.",
                      )}
                      value={uniform("ghqCloneLayout")}
                      disabled={disabledFor("ghqCloneLayout")}
                      onValueChange={(value) => write({ ghqCloneLayout: value })}
                    />
                  </SettingsSection>
                  <SettingsSection title={t("New worktrees")}>
                    <SettingsSwitchRow
                      icon="arrow.triangle.branch"
                      label={t("Start from remote")}
                      subtitle={managedSubtitle(
                        "newWorktreesStartFromOrigin",
                        t(
                          "Uses the latest commit of the base branch’s tracked remote branch, even if its name differs. Otherwise uses the same-named branch on origin. Uses your local branch if that remote branch is missing.",
                        ),
                      )}
                      value={uniform("newWorktreesStartFromOrigin")}
                      disabled={disabledFor("newWorktreesStartFromOrigin")}
                      onValueChange={(value) => write({ newWorktreesStartFromOrigin: value })}
                    />
                  </SettingsSection>
                  <SettingsSection
                    title={t("Worktree submodules")}
                    footer={managed("worktreeSubmodules")}
                    trailing={
                      pendingWrites === 0 && isMixed("worktreeSubmodules") ? (
                        <MixedValuesLabel projectSelected={projectSelected} />
                      ) : null
                    }
                  >
                    {SUBMODULE_CHOICES.filter(
                      (choice) => choice.mode !== null || !projectSelected,
                    ).map((choice, index) => (
                      <SettingsChoiceRow
                        key={choice.mode ?? "inherit"}
                        label={t(choice.label)}
                        description={t(choice.description)}
                        selected={
                          !isMixed("worktreeSubmodules") &&
                          uniform("worktreeSubmodules") === choice.mode
                        }
                        separated={index > 0}
                        disabled={disabledFor("worktreeSubmodules")}
                        onPress={() => write({ worktreeSubmodules: choice.mode })}
                      />
                    ))}
                  </SettingsSection>
                  <BranchNamingSettings
                    key={targetsKey}
                    mode={uniform("branchNamingMode")}
                    prefix={uniform("branchNamePrefix")}
                    instructions={uniform("branchNameInstructions")}
                    disabled={{
                      mode: disabledFor("branchNamingMode"),
                      prefix: disabledFor("branchNamePrefix"),
                      instructions: disabledFor("branchNameInstructions"),
                    }}
                    onChange={write}
                  />
                </>
              ) : null}

              {props.page === "maintenance" ? (
                <>
                  {!projectSelected ? (
                    <DatabaseStorageNotice
                      targets={selectedTargets.filter(
                        (target) =>
                          target.serverConfig.environment.capabilities.databaseStorage === true,
                      )}
                    />
                  ) : null}
                  {!projectSelected ? (
                    <SettingsSection title={t("Manage environments")}>
                      {selectedTargets.map((target) => (
                        <SettingsRow
                          key={target.environmentId}
                          icon="server.rack"
                          label={target.label}
                          value={t("Server and provider updates")}
                          onPress={() =>
                            navigation.navigate("SettingsEnvironmentDetail", {
                              environmentId: target.environmentId,
                            })
                          }
                        />
                      ))}
                    </SettingsSection>
                  ) : null}
                  <SettingsSection title={t("Updates")}>
                    <SettingsMenuRow
                      icon="arrow.clockwise"
                      label={t("Provider updates")}
                      description={managedSubtitle(
                        ["enableProviderUpdateChecks", "autoUpdateProviders"],
                        [
                          t(
                            "Check provider CLIs and model catalogs for updates. Install automatically also enables checks and updates provider CLIs when the server starts.",
                          ),
                          projectSelected
                            ? t("Environment-wide setting. Select All projects to change it.")
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" "),
                      )}
                      value={
                        uniform("enableProviderUpdateChecks") === null ||
                        uniform("autoUpdateProviders") === null
                          ? null
                          : providerUpdatesChoice(reference!.settings)
                      }
                      currentLabel={
                        uniform("enableProviderUpdateChecks") === null ||
                        uniform("autoUpdateProviders") === null
                          ? t("Mixed")
                          : t(updateLabels[providerUpdatesChoice(reference!.settings)])
                      }
                      disabled={
                        disabledFor("enableProviderUpdateChecks") ||
                        disabledFor("autoUpdateProviders")
                      }
                      options={ProviderUpdatesChoice.literals.map((value) => ({
                        value,
                        label: t(updateLabels[value]),
                      }))}
                      onChange={(value) => write(providerUpdatesPatch(value))}
                    />
                    <View className="border-t border-border-subtle">
                      <SettingsSwitchRow
                        icon="arrow.uturn.forward"
                        label={t("Continue after restart")}
                        subtitle={managedSubtitle(
                          "continueThreadsAfterServerUpdate",
                          t("Resume interrupted threads after an update or restart."),
                        )}
                        value={uniform("continueThreadsAfterServerUpdate")}
                        disabled={disabledFor("continueThreadsAfterServerUpdate")}
                        onValueChange={(value) =>
                          write({ continueThreadsAfterServerUpdate: value })
                        }
                      />
                    </View>
                    <View className="border-t border-border-subtle">
                      <SettingsSwitchRow
                        icon="wifi"
                        label={t("Retry after network errors")}
                        subtitle={managedSubtitle(
                          "retryThreadsAfterNetworkErrors",
                          t("Resume threads stopped by a lost connection once it is back."),
                        )}
                        value={uniform("retryThreadsAfterNetworkErrors")}
                        disabled={disabledFor("retryThreadsAfterNetworkErrors")}
                        onValueChange={(value) => write({ retryThreadsAfterNetworkErrors: value })}
                      />
                    </View>
                  </SettingsSection>
                </>
              ) : null}
            </>
          )}
          {props.page === "maintenance" ? (
            <>
              <LinkedEnvironmentsSettingsSection />
              <FollowSharedSettingsSection />
              <AppSettingsSection />
            </>
          ) : null}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function MixedValuesLabel(props: { readonly projectSelected: boolean }) {
  return (
    <Text
      accessibilityLabel={
        props.projectSelected
          ? t("Selected project checkouts use different values")
          : t("Selected environments use different values")
      }
      className="px-2 text-sm text-foreground-muted android:px-4"
    >
      {t("Mixed")}
    </Text>
  );
}

/** Locked settings are refused when saved; say so before the user tries. */
function ManagedPolicyNotice(props: { readonly targets: readonly ScopedMobileSettingsTarget[] }) {
  const organizations = [
    ...new Set(
      props.targets.flatMap((target) => {
        const policy = target.environment.serverConfig.managedPolicy;
        return policy !== undefined && policy.lockedSettings.length > 0
          ? [policy.organization]
          : [];
      }),
    ),
  ];
  if (organizations.length === 0) return null;
  return (
    <Text className="px-2 text-sm text-foreground-muted android:px-4">
      {t("Some settings are managed by {organizations} and cannot be changed here.", {
        organizations: organizations.join(", "),
      })}
    </Text>
  );
}
