import {
  MAX_PLAN_RESET_WAIT_HOURS,
  UsageLimitRecoveryChoice,
  usageLimitRecoveryChoice,
  usageLimitRecoveryPatch,
} from "@t3tools/contracts/settings";
import { SettingsMenuRow } from "./components/SettingsMenuRow";
import { msg, t, tn, type Message } from "../../lib/i18n";
import { NumberField } from "../../components/ui/NumberField";
import { Button } from "../../components/ui/Button";
import {
  scheduledTaskPlacementOptions,
  scheduledTaskPlacementLabel,
} from "@t3tools/client-runtime/scheduled-task-pins";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Menu } from "../../components/ui/Menu";
import {
  type AgentFeedbackMode,
  AuthSettingsWriteScope,
  isManagedSettingPath,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { offersSidebarMachineGrouping } from "@t3tools/contracts/settings";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { useThreadListV2ShelfPreferences } from "../threads/use-thread-list-v2-shelf-preferences";
import { useEnvironmentsWithScope } from "../../state/session";
import { AutoSettleDaysField } from "./components/AutoSettleDaysField";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { ComponentProps } from "react";
import { View } from "react-native";
import { useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsScreen } from "./components/SettingsScreen";

import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironments } from "../../state/environments";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { planAutoSettleSettingsSync, type AutoSettleSettings } from "./autoSettleSettingsSync";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  managedSettingReason,
  planMobileSettingsWrites,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
} from "./settings-scoped-server";
import { useSettingsWriter } from "./useSettingsWriter";

const recoveryLabels = {
  off: msg("Do nothing"),
  resume: msg("Resume when the limit resets"),
  "switch-and-resume": msg("Switch to another account, else resume when the limit resets"),
  custom: msg("Custom"),
};

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays ?? 7;

/**
 * Usage-limit and auto-settle rows. The Threads page owns their writes, so they share its queue
 * with the page's other project overrides, and their project override reset.
 */
export function AutoSettleSettingsRows(props: {
  readonly write: (patch: ServerSettingsPatch) => void;
  readonly pending: boolean;
}) {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const writableEnvironments = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const projectSelected = selectedProjectKey !== null;

  const projectMembers = projectSelected
    ? (selectedProject?.members.map((member) => member.project) ?? [])
    : null;
  const displayTargets = resolveMobileSettingsTargets(
    selectedTargets.filter(supportsSharedSettingsSync),
    projectMembers,
  );
  // The page saves to all its targets, so any read-only one blocks the save.
  const canWriteSettings =
    displayTargets.length > 0 &&
    resolveMobileSettingsTargets(selectedTargets, projectMembers).every((target) =>
      writableEnvironments.has(target.environment.environmentId),
    );
  const reference = displayTargets[0] ?? null;
  const referenceSettings = reference?.settings ?? null;

  if (reference === null || referenceSettings === null) {
    return null;
  }

  const writeToAll = (
    patch: Partial<AutoSettleSettings> & {
      autoResumeLimitedThreads?: boolean;
      snoozeLimitedThreads?: boolean;
      failoverLimitedThreads?: boolean;
      redeemUsageResets?: boolean;
      maxPlanResetWaitHours?: number;
      continueThreadsAfterServerUpdate?: boolean;
      retryThreadsAfterNetworkErrors?: boolean;
    },
  ) => props.write(patch);

  const { patch: autoSettlePatch, mismatches } = planAutoSettleSettingsSync(
    {
      environmentId: reference.environment.environmentId,
      projectId: reference.projectId,
      settings: referenceSettings,
    },
    displayTargets.map((target) => ({
      environmentId: target.environment.environmentId,
      projectId: target.projectId,
      label: target.environment.label,
      settings: target.settings,
    })),
  );

  const disabled = !canWriteSettings || props.pending;
  const disabledFor = (...keys: string[]) =>
    disabled || managedSettingReason(displayTargets, ...keys) !== undefined;
  const afterDays = referenceSettings.sidebarAutoSettleAfterDays;
  const recoveryChoice = usageLimitRecoveryChoice(referenceSettings);
  const recoveryMixed = (["autoResumeLimitedThreads", "failoverLimitedThreads"] as const).some(
    (key) => uniformMobileSetting(displayTargets, key) === null,
  );
  // Servers without the redeemer would drop its settings.
  const redeemerSupported = displayTargets.every(
    (target) =>
      target.environment.serverConfig.environment.capabilities.usageResetRedeemer === true,
  );

  return (
    <View className="gap-6">
      <SettingsSection title={t("Recovery")}>
        {!projectSelected ? (
          <>
            <SettingsMenuRow
              icon="clock"
              label={t("When a thread hits a usage limit")}
              description={t(
                "Switching uses another subscription account of the same provider. Some providers' terms forbid using extra accounts to get around limits. Custom keeps account switching without automatic resume until you choose an action.",
              )}
              value={recoveryMixed ? null : recoveryChoice}
              currentLabel={recoveryMixed ? t("Mixed") : t(recoveryLabels[recoveryChoice])}
              disabled={disabledFor("autoResumeLimitedThreads", "failoverLimitedThreads")}
              options={UsageLimitRecoveryChoice.literals.map((value) => ({
                value,
                label: t(recoveryLabels[value]),
              }))}
              onChange={(value) => writeToAll(usageLimitRecoveryPatch(value))}
            />
            <SettingsSwitchRow
              icon="clock"
              label={t("Hide limited threads until the limit resets")}
              value={uniformMobileSetting(displayTargets, "snoozeLimitedThreads")}
              disabled={disabledFor("snoozeLimitedThreads")}
              onValueChange={(value) => writeToAll({ snoozeLimitedThreads: value })}
            />
            {redeemerSupported ? (
              <SettingsSwitchRow
                icon="arrow.clockwise"
                label={t("Redeem usage resets automatically")}
                subtitle={
                  managedSettingReason(displayTargets, "redeemUsageResets") ??
                  t(
                    "When a Claude or Codex account's limit is out, claim one of its banked resets, but only if the plan reset is further away than the wait below or the reset would otherwise expire unused.",
                  )
                }
                value={uniformMobileSetting(displayTargets, "redeemUsageResets")}
                disabled={disabledFor("redeemUsageResets")}
                onValueChange={(value) => writeToAll({ redeemUsageResets: value })}
              />
            ) : null}
            {redeemerSupported && referenceSettings.redeemUsageResets ? (
              <View className="flex-row items-center gap-4 px-4 py-4 android:min-h-14 android:py-3">
                <View className="w-[22px] android:w-6" />
                <Text className="flex-1 text-foreground text-lg android:text-base">
                  {t("Hours to wait for a plan reset")}
                </Text>
                <NumberField
                  label={t("Hours to wait for a plan reset")}
                  min={0}
                  max={MAX_PLAN_RESET_WAIT_HOURS}
                  formatValue={(value) => tn(value, "{count} hour", "{count} hours")}
                  value={referenceSettings.maxPlanResetWaitHours}
                  disabled={disabledFor("maxPlanResetWaitHours")}
                  onValueChange={(value) => writeToAll({ maxPlanResetWaitHours: value })}
                />
              </View>
            ) : null}
            <SettingsSwitchRow
              icon="wifi"
              label={t("Retry after network errors")}
              subtitle={
                managedSettingReason(displayTargets, "retryThreadsAfterNetworkErrors") ??
                t("Resume threads stopped by a lost connection once it is back.")
              }
              value={uniformMobileSetting(displayTargets, "retryThreadsAfterNetworkErrors")}
              disabled={disabledFor("retryThreadsAfterNetworkErrors")}
              onValueChange={(value) => writeToAll({ retryThreadsAfterNetworkErrors: value })}
            />
          </>
        ) : null}
        <SettingsSwitchRow
          icon="arrow.uturn.forward"
          label={t("Continue after restart")}
          subtitle={
            managedSettingReason(displayTargets, "continueThreadsAfterServerUpdate") ??
            t("Resume interrupted threads after an update or restart.")
          }
          value={uniformMobileSetting(displayTargets, "continueThreadsAfterServerUpdate")}
          disabled={disabledFor("continueThreadsAfterServerUpdate")}
          onValueChange={(value) => writeToAll({ continueThreadsAfterServerUpdate: value })}
        />
      </SettingsSection>
      <SettingsSection title={t("Auto-settle")}>
        <SettingsSwitchRow
          icon="clock"
          label={t("Auto-settle completed scheduled threads")}
          subtitle={t(
            "Settle threads started by a scheduled task when they finish and have no pending work.",
          )}
          value={referenceSettings.sidebarAutoSettleScheduledThreads}
          disabled={disabledFor("sidebarAutoSettleScheduledThreads")}
          onValueChange={(value) => writeToAll({ sidebarAutoSettleScheduledThreads: value })}
        />
        <SettingsSwitchRow
          icon="arrow.triangle.branch"
          label={t("Auto-settle merged threads")}
          value={referenceSettings.sidebarAutoSettleOnMerge}
          disabled={disabledFor("sidebarAutoSettleOnMerge")}
          onValueChange={(value) => writeToAll({ sidebarAutoSettleOnMerge: value })}
        />
        <SettingsSwitchRow
          icon="clock"
          label={t("Auto-settle inactive threads")}
          value={afterDays !== null}
          disabled={disabledFor("sidebarAutoSettleAfterDays")}
          onValueChange={(value) =>
            writeToAll({ sidebarAutoSettleAfterDays: value ? AUTO_SETTLE_DEFAULT_DAYS : null })
          }
        />
        {afterDays !== null ? (
          <View className="flex-row items-center gap-4 px-4 py-4 android:min-h-14 android:py-3">
            <View className="w-[22px] android:w-6" />
            <Text className="flex-1 text-foreground text-lg android:text-base">
              {t("Inactive days")}
            </Text>
            <AutoSettleDaysField
              value={afterDays}
              disabled={disabledFor("sidebarAutoSettleAfterDays")}
              onValueChange={(value) => writeToAll({ sidebarAutoSettleAfterDays: value })}
            />
          </View>
        ) : null}
      </SettingsSection>
      {!props.pending && mismatches.length > 0 ? (
        <SettingsSection title={t("Across environments")}>
          <View className="gap-3 p-4">
            <Text className="text-base text-foreground">{t("Auto-settle defaults differ")}</Text>
            <Text className="text-sm text-foreground-muted">
              {mismatches.map((mismatch) => mismatch.label).join(", ")}
            </Text>
            <Button
              label={t("Apply auto-settle defaults")}
              tone="secondary"
              disabled={disabledFor(
                "sidebarAutoSettleScheduledThreads",
                "sidebarAutoSettleOnMerge",
                "sidebarAutoSettleAfterDays",
              )}
              onPress={() => writeToAll(autoSettlePatch)}
            />
          </View>
        </SettingsSection>
      ) : null}
    </View>
  );
}

const PROJECT_GROUPING_OPTIONS = [
  { project: false, label: msg("None"), description: msg("List active threads together.") },
  { project: true, label: msg("By project"), description: msg("A folder for each project.") },
] as const;

export function ThreadGroupingSettingsSection() {
  const { loaded, grouping, setProjectGrouping, toggleMachineGrouping } =
    useThreadListV2ShelfPreferences();
  const machineGroupingOffered = offersSidebarMachineGrouping(
    useEnvironments().environments.length,
    grouping,
  );

  return (
    <View className="gap-3">
      <SettingsSection title={t("Group threads")}>
        {PROJECT_GROUPING_OPTIONS.map((option, index) => (
          <SettingsChoiceRow
            key={option.label}
            label={t(option.label)}
            description={t(option.description)}
            selected={grouping.project === option.project}
            separated={index > 0}
            disabled={!loaded}
            onPress={() => setProjectGrouping(option.project)}
          />
        ))}
      </SettingsSection>
      {machineGroupingOffered ? (
        <SettingsSection>
          <SettingsSwitchRow
            icon="desktopcomputer"
            label={t("Group by machine")}
            subtitle={t(
              "A folder for each machine. Grouped by project too, it holds its project folders.",
            )}
            value={grouping.machine}
            disabled={!loaded}
            onValueChange={toggleMachineGrouping}
          />
        </SettingsSection>
      ) : null}
      <Text className="px-2 text-sm text-foreground-muted">
        {t(
          "Working threads show in their folder and in the Working section. Pinned threads and the Snoozed and Settled sections stay shared across folders. While threads are grouped, active threads are ordered by their latest message.",
        )}
      </Text>
    </View>
  );
}

export function WorkingSectionSettings() {
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const workingShelfEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.workingShelfEnabled !== false;

  return (
    <View className="gap-3">
      <SettingsSection title={t("Sidebar")}>
        <SettingsSwitchRow
          icon="bolt.circle"
          label={t("Working section")}
          value={workingShelfEnabled}
          onValueChange={(value) => {
            void savePreferences({ workingShelfEnabled: value });
          }}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        {t(
          "Fold working and monitoring threads into a Working section. They return to the top of the list when they need you. While this is on, active threads are ordered by time and cannot be moved.",
        )}
      </Text>
    </View>
  );
}

/** General has no environment filter, so this setting is always saved for all machines. */
export function ScheduledTaskPlacementSettings() {
  const { availableTargets } = useSettingsEnvironmentFilter();
  const { environments } = useEnvironments();
  const targets = resolveMobileSettingsTargets(
    availableTargets.filter(supportsSharedSettingsSync),
    null,
  );
  const writable = useEnvironmentsWithScope(availableTargets, AuthSettingsWriteScope);
  const [pending, setPending] = useState(false);
  const writeSettings = useSettingsWriter();
  const managed = managedSettingReason(targets, "scheduledTaskDefaultPlacement");
  const current = uniformMobileSetting(targets, "scheduledTaskDefaultPlacement");
  const disabled =
    pending ||
    targets.length === 0 ||
    managed !== undefined ||
    targets.some((target) => !writable.has(target.environment.environmentId));
  const label = current === null ? t("Mixed") : scheduledTaskPlacementLabel(current);
  const row = (
    <ListRowLayout
      icon="pin"
      label={t("Show new scheduled tasks in")}
      description={
        managed ??
        t("Where new scheduled tasks appear on every machine. Change a task's place from its menu.")
      }
      detail={label}
      disabled={disabled}
    />
  );

  return (
    <SettingsSection title={t("Scheduled tasks")}>
      {disabled ? (
        row
      ) : (
        <Menu
          accessible
          accessibilityRole="button"
          accessibilityLabel={t("Show new scheduled tasks in: {label}", { label })}
          title={t("Show new scheduled tasks in")}
          actions={scheduledTaskPlacementOptions().map((option) => ({
            id: option.value,
            title: option.label,
            state: option.value === current ? ("on" as const) : ("off" as const),
          }))}
          onPressAction={async ({ nativeEvent }) => {
            const placement = scheduledTaskPlacementOptions().find(
              (option) => option.value === nativeEvent.event,
            )?.value;
            if (placement === undefined) return;
            setPending(true);
            await writeSettings(
              targets,
              planMobileSettingsWrites({
                machines: environments,
                targets,
                allSelected: true,
                projectSelected: false,
                patch: { scheduledTaskDefaultPlacement: placement },
              }),
            ).finally(() => {
              setPending(false);
            });
          }}
        >
          {row}
        </Menu>
      )}
    </SettingsSection>
  );
}

export function NewThreadSettingsSection() {
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const useLastProject =
    AsyncResult.isSuccess(preferences) && preferences.value.useLastProjectForNewThreads !== false;

  return (
    <SettingsSection title={t("New threads")}>
      <SettingsSwitchRow
        icon="square.and.pencil"
        label={t("Use last project")}
        subtitle={t("Start new threads in the last project you used on this device.")}
        value={useLastProject}
        onValueChange={(value) => {
          void savePreferences({ useLastProjectForNewThreads: value });
        }}
      />
    </SettingsSection>
  );
}

type MachineBetaSetting = "linkedEnvironmentsEnabled" | "fastWorktreeCheckout";

const AGENT_FEEDBACK_CHOICES: ReadonlyArray<{
  readonly mode: AgentFeedbackMode;
  readonly label: Message;
  readonly description: Message;
}> = [
  { mode: "off", label: msg("Off"), description: msg("Agents send no feedback to the T3 team.") },
  {
    mode: "on-request",
    label: msg("When I ask"),
    description: msg("When you ask, you see a short report and send it if you approve."),
  },
  {
    mode: "auto",
    label: msg("Automatic"),
    description: msg("Agents also report T3 Code problems they hit on their own."),
  },
];

/** One choice list per connected machine that offers it, since each machine's own setting decides. */
function AgentFeedbackSection() {
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.agentFeedback === true,
  );
  const writable = useEnvironmentsWithScope(supported, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "agentFeedback beta update",
    reportFailure: true,
  });
  if (supported.length === 0) return null;
  return (
    <View className="gap-3">
      {supported.map((environment) => {
        const policy = environment.serverConfig?.managedPolicy;
        const managed = isManagedSettingPath(policy, "agentFeedback");
        const mode = environment.serverConfig?.settings.agentFeedback?.mode;
        return (
          <SettingsSection
            key={environment.environmentId}
            title={
              supported.length === 1
                ? t("Beta: Agent feedback")
                : t("Beta: Agent feedback · {label}", { label: environment.label })
            }
            {...(managed
              ? {
                  footer: t("Managed by {organization}.", {
                    organization: policy?.organization ?? "",
                  }),
                }
              : {})}
          >
            {AGENT_FEEDBACK_CHOICES.map((choice, index) => (
              <SettingsChoiceRow
                key={choice.mode}
                label={t(choice.label)}
                description={t(choice.description)}
                selected={mode === choice.mode}
                separated={index > 0}
                disabled={managed || !writable.has(environment.environmentId)}
                onPress={() =>
                  void updateSettings({
                    environmentId: environment.environmentId,
                    input: { patch: { agentFeedback: { mode: choice.mode } } },
                  })
                }
              />
            ))}
          </SettingsSection>
        );
      })}
      <Text className="px-2 text-sm text-foreground-muted">
        {t(
          "Reports go to the T3 team. A report you ask for is shown to you first in a card, with an outline of recent turns. Turn on Include the conversation there to add the messages of the turns the report is about.",
        )}
      </Text>
    </View>
  );
}

/** One switch per connected machine that offers the beta, since each machine's own setting decides. */
function MachineBetaSection({
  title,
  icon,
  capability,
  setting,
  description,
}: {
  readonly title: Message;
  readonly icon: ComponentProps<typeof SettingsSwitchRow>["icon"];
  readonly capability: "peerLinks" | "fastWorktreeCheckout";
  readonly setting: MachineBetaSetting;
  readonly description: Message;
}) {
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities[capability] === true,
  );
  const writable = useEnvironmentsWithScope(supported, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `${setting} beta update`,
    reportFailure: true,
  });
  if (supported.length === 0) return null;
  return (
    <View className="gap-3">
      <SettingsSection title={t("Beta: {title}", { title: t(title) })}>
        {supported.map((environment) => {
          const policy = environment.serverConfig?.managedPolicy;
          const managed = isManagedSettingPath(policy, setting);
          return (
            <SettingsSwitchRow
              key={environment.environmentId}
              icon={icon}
              label={environment.label}
              {...(managed
                ? {
                    subtitle: t("Managed by {organization}.", {
                      organization: policy?.organization ?? "",
                    }),
                  }
                : {})}
              value={environment.serverConfig?.settings[setting] === true}
              disabled={managed || !writable.has(environment.environmentId)}
              onValueChange={(value) =>
                void updateSettings({
                  environmentId: environment.environmentId,
                  input: {
                    patch:
                      setting === "linkedEnvironmentsEnabled"
                        ? { linkedEnvironmentsEnabled: value }
                        : { fastWorktreeCheckout: value },
                  },
                })
              }
            />
          );
        })}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">{t(description)}</Text>
    </View>
  );
}

export function SettingsLabsRouteScreen() {
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title={t("Labs")}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <LinkedEnvironmentsSettingsSection />
        <FastWorktreeCheckoutSettingsSection />
        <AgentFeedbackSection />
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function LinkedEnvironmentsSettingsSection() {
  return (
    <MachineBetaSection
      title={msg("Linked environments")}
      icon="link"
      capability="peerLinks"
      setting="linkedEnvironmentsEnabled"
      description={msg(
        "Let agents on a machine work on your other machines, and theirs on it. Turn it on for each machine. While off, nothing new starts over a link; running tasks finish.",
      )}
    />
  );
}

function FastWorktreeCheckoutSettingsSection() {
  return (
    <MachineBetaSection
      title={msg("Fast worktree checkout")}
      icon="bolt.circle"
      capability="fastWorktreeCheckout"
      setting="fastWorktreeCheckout"
      description={msg(
        "On a Mac, clone new worktrees from a checkout cached in the T3 home folder instead of writing every file. Uses Git’s normal checkout when it can’t. Turning it off deletes the cache.",
      )}
    />
  );
}
