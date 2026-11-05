import { useAtomValue } from "@effect/atom-react";
import { NotificationSettings } from "./NotificationSettings";
import { PRIVACY_POLICY_URL } from "../../legalLinks";
import { CheckIcon } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  type DesktopUpdateChannel,
  IDLE_COMPACTION_MODES,
  globalIdleCompaction,
  ProviderDriverKind,
  type ProviderInstanceId,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import { idleCompactionModeLabel } from "@t3tools/shared/claudeCompaction";
import { managedUpdatesDenial, managedUpdatesMessage } from "@t3tools/shared/managedPolicyMessages";
import {
  DEFAULT_UNIFIED_SETTINGS,
  type DiffLayout,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  type ResponseStreamingMode,
  type QuitConfirmationMode,
  offersSidebarMachineGrouping,
  resolveSidebarGrouping,
  SidebarProjectSortOrder,
} from "@t3tools/contracts/settings";
import { desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import { createModelSelection } from "@t3tools/shared/model";
import { resolvePastedPath } from "@t3tools/shared/path";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import { APP_VERSION, HOSTED_APP_CHANNEL, HOSTED_APP_CHANNEL_LABEL } from "../../branding";
import { AboutVersionTitle } from "./AboutVersionTitle";
import { CliCommandSettingsRow } from "./CliCommandSettingsRow";
import { MobileAppSettingsRow } from "./MobileAppSettingsRow";
import {
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDisabledReason,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  resolveDesktopUpdatePendingAction,
} from "../../components/desktopUpdate.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { isElectron } from "../../env";
import { buildHostedChannelSelectionUrl, type HostedAppChannel } from "../../hostedPairing";
import {
  readAppearanceModePreference,
  readThemeHalves,
  readThemePreference,
  useTheme,
} from "../../hooks/useTheme";
import {
  useScopedSettings,
  useClearScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { scopedIdleCompaction } from "./scopedSettings";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { ThreadTitleInstructionsSettings } from "./ThreadTitleInstructionsSettings";
import { SnoozePresetsRow } from "./SnoozePresetsSettings";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { managedTelemetryOffMessage, usePrimaryManagedPolicy } from "../../state/managedPolicy";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { isMacPlatform } from "../../lib/utils";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { AgentConversationsSettings } from "./AgentConversationsSettings";
import { scheduledTaskPlacementOptions } from "@t3tools/client-runtime/scheduled-task-pins";
import { ScopedSwitch } from "./ScopedSwitch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  changedRestorableSettingLabels,
  isProjectGroupingEnabled,
  projectGroupingModeFromToggle,
  readLastEnabledProjectGroupingMode,
  rememberEnabledProjectGroupingMode,
  projectScopedRestorePlan,
  restorableSettingsPatch,
} from "./SettingsPanels.logic";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { msg, t, tn, type Message } from "~/i18n";
import { searchableSetting } from "./settingsSearch";
import { LanguageSettingsRow } from "./LanguageSettingsRow";
import { BackgroundActivitySettingsRow } from "./BackgroundActivitySettings";
import { AdvancedSettings } from "./AdvancedSettings";
import { SnapShotSettings } from "./SnapShotSettings";
import { useOpenSetupWizard } from "../../onboarding/setupRerun";
import { BoringSidebarMultilineRow } from "./OptInFeatureRows";
import { StorageCleanupSections } from "./StorageSettings";
import { UpdateTrackSwitchDialog } from "./UpdateTrackSwitchDialog";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { environmentSessionStatesAtom } from "~/state/session";
import { canUpdateServer } from "../ServerUpdateAction";
import { useUpdateEverythingRun } from "../sidebar/updateEverythingRun";
import { awaitsTrackSwitch, channelSwitchLabel } from "../sidebar/updateEverything.logic";
import { isHostedByThisApp } from "../sidebar/useUpdateEverything";
import { SafeUpdateDialog, useThisAppRunningThreads } from "../sidebar/SafeUpdateDialog";
import { installLocalUpdate } from "../sidebar/SidebarUpdatePill";

const RESPONSE_STREAMING_MODE_LABELS: Record<ResponseStreamingMode, Message> = {
  turn: msg("Wait for the full response"),
  paragraph: msg("Show finished paragraphs"),
};

const RESPONSE_STREAMING_MODE_DESCRIPTIONS: Record<ResponseStreamingMode, Message> = {
  turn: msg("Text appears once the agent finishes its turn."),
  paragraph: msg("Each paragraph or code block appears as soon as it is complete."),
};

const SIDEBAR_PROJECT_SORT_ORDER_LABELS: Record<SidebarProjectSortOrder, Message> = {
  updated_at: msg("Last user message"),
  created_at: msg("Created at"),
  manual: msg("Manual"),
};
const isSidebarProjectSortOrder = Schema.is(SidebarProjectSortOrder);

const SIDEBAR_PROJECT_GROUPING_LABELS = { none: msg("None"), project: msg("By project") } as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: msg("System default"),
  "12-hour": msg("12-hour"),
  "24-hour": msg("24-hour"),
} as const;

const DIFF_LAYOUT_LABELS: Record<DiffLayout, Message> = {
  stacked: msg("Stacked"),
  split: msg("Split"),
};

const QUIT_CONFIRMATION_MODE_LABELS: Record<QuitConfirmationMode, Message> = {
  direct: msg("Direct"),
  hold: msg("Hold"),
  "double-click": msg("Double press"),
};

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
function AboutVersionSection() {
  const updateState = useDesktopUpdateState();
  const [switchChannel, setSwitchChannel] = useState<DesktopUpdateChannel | null>(null);
  const [isUpdateActionPending, setIsUpdateActionPending] = useState(false);
  const [isConfirmingSafeUpdate, setIsConfirmingSafeUpdate] = useState(false);
  const thisAppThreads = useThisAppRunningThreads(
    resolveDesktopUpdatePendingAction(updateState) === "install",
  );
  const { environments } = useEnvironments();
  const sessionStates = useAtomValue(
    environmentSessionStatesAtom(
      environmentIdsKey(environments.map(({ environmentId }) => environmentId)),
    ),
  );
  // A second run would replace the first run's progress and local download.
  const updateRun = useUpdateEverythingRun();

  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedUpdateChannel = updateState?.channel ?? "latest";
  // The desktop updates this machine, whose policy the primary environment reports.
  const primaryPolicy = usePrimaryManagedPolicy();
  const updatesDenial = hasDesktopBridge ? managedUpdatesDenial(primaryPolicy) : undefined;
  const nightlyDeniedBy =
    hasDesktopBridge && primaryPolicy?.limits?.updates?.allowNightly === false
      ? primaryPolicy.organization
      : undefined;
  const selectedHostedAppChannel = hasDesktopBridge ? null : HOSTED_APP_CHANNEL;
  // A switch that failed part way leaves this app or a server on the other track.
  // With its updater off, a switch cannot move this app, so it is not counted.
  const appOffTrack =
    updateState?.enabled !== false && desktopUpdateChannelOf(APP_VERSION) !== selectedUpdateChannel;
  const unswitchedMachines =
    (appOffTrack ? 1 : 0) +
    environments.filter(
      (environment, index) =>
        environment.connection.phase === "connected" &&
        canUpdateServer(sessionStates[index]!) &&
        awaitsTrackSwitch(
          {
            serverConfig: environment.serverConfig,
            hostedByThisApp: isHostedByThisApp(environment),
          },
          selectedUpdateChannel,
        ),
    ).length;

  const handleButtonClick = async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge.downloadUpdate().catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Could not download update"),
            description: error instanceof Error ? error.message : t("Download failed."),
          }),
        );
      });
      return;
    }

    if (action === "install") {
      if (isUpdateActionPending) return;
      if (thisAppThreads.count > 0) {
        setIsConfirmingSafeUpdate(true);
        return;
      }
      setIsUpdateActionPending(true);
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(
            updateState ?? { availableVersion: null, downloadedVersion: null },
          ),
        );
      } catch (error) {
        setIsUpdateActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Could not confirm update"),
            description: error instanceof Error ? error.message : t("Update confirmation failed."),
          }),
        );
        return;
      }
      if (!confirmed) {
        setIsUpdateActionPending(false);
        return;
      }
      void installLocalUpdate(bridge).finally(() => setIsUpdateActionPending(false));
    }
  };

  const confirmSafeUpdate = () => {
    const bridge = window.desktopBridge;
    setIsConfirmingSafeUpdate(false);
    if (!bridge) return;
    setIsUpdateActionPending(true);
    void installLocalUpdate(bridge).finally(() => setIsUpdateActionPending(false));
  };

  // Updates are checked automatically, so the button appears only for an update to act on.
  const pendingAction = resolveDesktopUpdatePendingAction(updateState);
  const isDownloading = updateState?.status === "downloading";
  const showUpdateButton = pendingAction !== "none" || isDownloading;
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  // The updater holds a found update until its background recheck finishes.
  const buttonDisabled =
    updateState?.status === "checking" || isDesktopUpdateButtonDisabled(updateState);
  const buttonLabel = isDownloading
    ? t("Downloading…")
    : pendingAction === "install"
      ? t("Install")
      : t("Download");
  const description = showUpdateButton
    ? t("Update available.")
    : (getDesktopUpdateDisabledReason(updateState, updatesDenial) ??
      t("Current version of the application."));

  return (
    <>
      <SettingsRow
        id={searchableSetting("app-version").id}
        title={<AboutVersionTitle />}
        description={description}
        managed={updatesDenial}
        control={
          showUpdateButton ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={buttonDisabled || isUpdateActionPending}
                    onClick={handleButtonClick}
                  >
                    {buttonLabel}
                  </Button>
                }
              />
              {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
            </Tooltip>
          ) : undefined
        }
      />
      {hasDesktopBridge ? (
        <SettingsRow
          {...searchableSetting("update-track")}
          description={
            nightlyDeniedBy !== undefined ? (
              selectedUpdateChannel === "nightly" ? (
                t(
                  "{policy} Nightly builds are not available; switch to Stable to keep getting updates.",
                  { policy: managedUpdatesMessage(nightlyDeniedBy) },
                )
              ) : (
                t("{policy} Nightly builds are not available.", {
                  policy: managedUpdatesMessage(nightlyDeniedBy),
                })
              )
            ) : unswitchedMachines > 0 ? (
              <>
                {tn(unswitchedMachines, "{count} machine still runs", "{count} machines still run")}{" "}
                {channelSwitchLabel(selectedUpdateChannel === "nightly" ? "latest" : "nightly")}.{" "}
                {/* The dialog moves what it can and says why it skips the rest. */}
                <Button
                  size="xs"
                  variant="link"
                  disabled={updateRun !== null}
                  onClick={() => setSwitchChannel(selectedUpdateChannel)}
                >
                  {t("Review")}
                </Button>
              </>
            ) : (
              t(
                "Switches this app and every connected machine whose database the target release supports.",
              )
            )
          }
          managed={updatesDenial}
          control={
            <Select
              value={selectedUpdateChannel}
              onValueChange={(value) => {
                if (value !== selectedUpdateChannel) {
                  setSwitchChannel(value as DesktopUpdateChannel);
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label={t("Update track")}
                disabled={switchChannel !== null || updateRun !== null}
              >
                <SelectValue>{channelSwitchLabel(selectedUpdateChannel)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  {t("Stable")}
                </SelectItem>
                <SelectItem
                  hideIndicator
                  value="nightly"
                  disabled={nightlyDeniedBy !== undefined && selectedUpdateChannel !== "nightly"}
                >
                  {t("Nightly")}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : selectedHostedAppChannel ? (
        <SettingsRow
          {...searchableSetting("update-track")}
          description={t("Switches the hosted app release channel.")}
          control={
            <Select
              value={selectedHostedAppChannel}
              onValueChange={(value) => {
                if (value === selectedHostedAppChannel) return;
                window.location.assign(
                  buildHostedChannelSelectionUrl({ channel: value as HostedAppChannel }),
                );
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={t("Update track")}>
                <SelectValue>{HOSTED_APP_CHANNEL_LABEL}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  {t("Latest")}
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  {t("Nightly")}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      {hasDesktopBridge ? <CliCommandSettingsRow /> : null}
      {switchChannel === null ? null : (
        <UpdateTrackSwitchDialog channel={switchChannel} onClose={() => setSwitchChannel(null)} />
      )}
      {hasDesktopBridge ? (
        <SafeUpdateDialog
          open={isConfirmingSafeUpdate}
          onOpenChange={setIsConfirmingSafeUpdate}
          version={updateState ? getDesktopUpdateDownloadedVersion(updateState) : null}
          environmentIds={thisAppThreads.key}
          onConfirm={confirmSafeUpdate}
        />
      ) : null}
    </>
  );
}

/** Restores one page's settings, or every page's when `page` is null. */
export function useSettingsRestore(page: string | null, onRestored?: () => void) {
  const {
    theme,
    setTheme,
    followSystem,
    setFollowSystem,
    setThemeHalf,
    clearThemeHalves,
    themeHalves,
  } = useTheme();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const clearScopedSettings = useClearScopedSettings();
  const scopeContext = useOptionalSettingsScope();
  const scope = scopeContext?.scope;
  const projectPlan =
    scopeContext && scope && (scope.kind === "project" || scope.kind === "checkout")
      ? projectScopedRestorePlan(
          settings,
          page,
          new Set(
            scope.members.flatMap((member) => {
              const overrides = scopeContext.environments.find(
                (environment) => environment.environmentId === member.environmentId,
              )?.serverConfig?.settings.projectSettingsOverrides?.[member.id];
              return overrides ? Object.keys(overrides) : [];
            }),
          ),
        )
      : null;
  const includesTheme = page === null || page === "/settings/appearance";

  const changedSettingLabels = [
    ...(includesTheme && theme !== "system" ? [t("Theme")] : []),
    ...(includesTheme && !followSystem ? [t("Follow system")] : []),
    ...(includesTheme && themeHalves !== null ? [t("Theme mix")] : []),
    ...(projectPlan ? projectPlan.labels : changedRestorableSettingLabels(settings, page)),
  ];

  const restoreDefaults = async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      [
        page === null
          ? t("Restore every setting to its default?")
          : t("Reset this page to defaults?"),
        t("This will reset: {settings}.", { settings: changedSettingLabels.join(", ") }),
      ].join("\n"),
      { variant: "destructive" },
    );
    if (!confirmed) return;

    if (includesTheme) {
      // Reset only dirty theme keys so storage failures cannot block other settings; re-read after
      // confirmation for safe rollback.
      let previousTheme = theme;
      try {
        previousTheme = readThemePreference();
      } catch {}
      const liveHalves = readThemeHalves();
      const needsThemeReset = previousTheme !== "system";
      const needsMixReset = liveHalves !== null;
      const needsFollowSystemReset = readAppearanceModePreference(previousTheme) !== "system";
      const notifyThemeRestoreFailure = () => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Couldn’t restore theme settings"),
            description: t("Try again."),
          }),
        );
      };
      // Restore the base preference before the mix because restoring the base clears the mix.
      const previousHalves = liveHalves;
      const rollbackThemeState = () => {
        if (needsThemeReset) setTheme(previousTheme);
        if (previousHalves?.light) setThemeHalf("light", previousHalves.light);
        if (previousHalves?.dark) setThemeHalf("dark", previousHalves.dark);
      };
      if (needsThemeReset && !setTheme("system")) {
        notifyThemeRestoreFailure();
        return;
      }
      if (needsMixReset && !clearThemeHalves()) {
        rollbackThemeState();
        notifyThemeRestoreFailure();
        return;
      }
      if (needsFollowSystemReset && !setFollowSystem(true)) {
        rollbackThemeState();
        notifyThemeRestoreFailure();
        return;
      }
    }
    if (projectPlan) {
      if (projectPlan.clearKeys.length > 0) clearScopedSettings(projectPlan.clearKeys);
      updateSettings(projectPlan.devicePatch);
    } else {
      updateSettings(restorableSettingsPatch(settings, page));
    }
    onRestored?.();
  };

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ?? 3;

function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [draftSource, setDraftSource] = useState(value);
  if (draftSource !== value) {
    setDraftSource(value);
    setDraft(String(value));
  }

  return (
    <Input
      size="sm"
      type="number"
      min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        const parsed = Number(event.target.value);
        if (
          Number.isInteger(parsed) &&
          parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
          parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
        ) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label={t("Days of inactivity before auto-settle")}
    />
  );
}

export function GeneralSettingsPanel() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const sidebarGrouping = resolveSidebarGrouping(settings);
  const machineCount = useEnvironments().environments.length;
  const lastEnabledProjectGroupingMode = useRef<SidebarProjectGroupingMode>(
    readLastEnabledProjectGroupingMode(),
  );

  return (
    <SettingsPageContainer>
      <SettingsSection id="notifications" title={t("Notifications")}>
        <NotificationSettings />
        <SettingsRow
          {...searchableSetting("in-app-notifications")}
          description={t(
            "Show a toast when another thread finishes, fails, or needs input or approval while this app has focus.",
          )}
          control={
            <Switch
              checked={settings.inAppNotificationsEnabled}
              onCheckedChange={(checked) => updateSettings({ inAppNotificationsEnabled: checked })}
              aria-label={t("In-app notifications")}
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="sidebar" title={t("Sidebar")}>
        <SettingsRow
          {...searchableSetting("scheduled-task-default-placement")}
          serverScoped
          settingKeys={["scheduledTaskDefaultPlacement"]}
          description={t("Where new scheduled tasks appear. Change a task's place from its menu.")}
          resetAction={
            settings.scheduledTaskDefaultPlacement !==
            DEFAULT_UNIFIED_SETTINGS.scheduledTaskDefaultPlacement ? (
              <SettingResetButton
                label={t("new scheduled task placement")}
                onClick={() =>
                  updateSettings({
                    scheduledTaskDefaultPlacement:
                      DEFAULT_UNIFIED_SETTINGS.scheduledTaskDefaultPlacement,
                  })
                }
              />
            ) : null
          }
          control={<ScheduledTaskPlacementSelect />}
        />
        <SettingsRow
          {...searchableSetting("sidebar-grouping")}
          description={t(
            "Put active threads in a folder for each project. Working threads show in their folder and in Working; Pinned, Snoozed, and Settled stay shared.",
          )}
          resetAction={
            sidebarGrouping.project ? (
              <SettingResetButton
                label={t("thread grouping")}
                onClick={() => updateSettings({ sidebarGroupByProject: false })}
              />
            ) : null
          }
          control={
            <Select
              value={sidebarGrouping.project ? "project" : "none"}
              onValueChange={(value) =>
                updateSettings({ sidebarGroupByProject: value === "project" })
              }
            >
              <SelectTrigger size="sm" className="w-full sm:w-44" aria-label={t("Group threads")}>
                <SelectValue>
                  {t(SIDEBAR_PROJECT_GROUPING_LABELS[sidebarGrouping.project ? "project" : "none"])}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {(["none", "project"] as const).map((value) => (
                  <SelectItem hideIndicator key={value} value={value}>
                    {t(SIDEBAR_PROJECT_GROUPING_LABELS[value])}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        {offersSidebarMachineGrouping(machineCount, sidebarGrouping) ? (
          <SettingsRow
            {...searchableSetting("sidebar-group-by-machine")}
            description={t(
              "Put active threads in a folder for each machine. Grouped by project too, each machine's folder holds its project folders.",
            )}
            control={
              <Switch
                checked={sidebarGrouping.machine}
                onCheckedChange={(checked) => updateSettings({ sidebarGroupByMachine: checked })}
                aria-label={t("Group threads by machine")}
              />
            }
          />
        ) : null}
        <SettingsRow
          {...searchableSetting("project-grouping")}
          description={
            sidebarGrouping.machine
              ? t(
                  "Show the same repository as one project in filters and the project picker, and let new threads switch between its machines. Machine folders still list it under each machine.",
                )
              : t(
                  "Show the same repository on different machines or paths as one project, in folders, filters, and the project picker.",
                )
          }
          resetAction={
            settings.sidebarProjectGroupingMode !==
            DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode ? (
              <SettingResetButton
                label={t("combining matching projects")}
                onClick={() =>
                  updateSettings({
                    sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={isProjectGroupingEnabled(settings.sidebarProjectGroupingMode)}
              onCheckedChange={(checked) => {
                if (!checked && settings.sidebarProjectGroupingMode !== "separate") {
                  lastEnabledProjectGroupingMode.current = settings.sidebarProjectGroupingMode;
                  rememberEnabledProjectGroupingMode(settings.sidebarProjectGroupingMode);
                }
                updateSettings({
                  sidebarProjectGroupingMode: projectGroupingModeFromToggle(
                    checked,
                    lastEnabledProjectGroupingMode.current,
                  ),
                });
              }}
              aria-label={t("Combine matching projects")}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("project-order")}
          description={t(
            "Order of project folders, the sidebar project picker, and the command palette.",
          )}
          resetAction={
            settings.sidebarProjectSortOrder !==
            DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder ? (
              <SettingResetButton
                label={t("project order")}
                onClick={() =>
                  updateSettings({
                    sidebarProjectSortOrder: DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.sidebarProjectSortOrder}
              onValueChange={(value) => {
                if (isSidebarProjectSortOrder(value)) {
                  updateSettings({ sidebarProjectSortOrder: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-44" aria-label={t("Project order")}>
                <SelectValue>
                  {t(SIDEBAR_PROJECT_SORT_ORDER_LABELS[settings.sidebarProjectSortOrder])}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {SidebarProjectSortOrder.literals.map((sortOrder) => (
                  <SelectItem hideIndicator key={sortOrder} value={sortOrder}>
                    {t(SIDEBAR_PROJECT_SORT_ORDER_LABELS[sortOrder])}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("working-shelf")}
          description={t(
            "Fold working and monitoring threads into a Working section. They return to the top of the inbox when they need you.",
          )}
          resetAction={
            settings.sidebarWorkingShelfEnabled !==
            DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled ? (
              <SettingResetButton
                label={t("working section")}
                onClick={() =>
                  updateSettings({
                    sidebarWorkingShelfEnabled: DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.sidebarWorkingShelfEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ sidebarWorkingShelfEnabled: Boolean(checked) })
              }
              aria-label={t("Working section")}
            />
          }
        />
        <BoringSidebarMultilineRow />
      </SettingsSection>

      <SettingsSection id="confirmations" title={t("Confirmations")}>
        <SettingsRow
          {...searchableSetting("unpin-confirmation")}
          description={t("Ask before unpinning a thread from the pinned section.")}
          resetAction={
            settings.confirmThreadUnpin !== DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin ? (
              <SettingResetButton
                label={t("unpin confirmation")}
                onClick={() =>
                  updateSettings({
                    confirmThreadUnpin: DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadUnpin}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadUnpin: Boolean(checked) })
              }
              aria-label={t("Confirm thread unpinning")}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("archive-confirmation")}
          description={t(
            "Require a second click on the inline archive action before a thread is archived.",
          )}
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label={t("archive confirmation")}
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label={t("Confirm thread archiving")}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("delete-confirmation")}
          description={t("Ask before deleting a thread and its chat history.")}
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label={t("delete confirmation")}
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label={t("Confirm thread deletion")}
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="display" title={t("Display")}>
        <LanguageSettingsRow />
        <SettingsRow
          {...searchableSetting("time-format")}
          description={t("System default follows your browser or OS clock preference.")}
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label={t("time format")}
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label={t("Timestamp format")}
              >
                <SelectValue>{t(TIMESTAMP_FORMAT_LABELS[settings.timestampFormat])}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {t(TIMESTAMP_FORMAT_LABELS.locale)}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {t(TIMESTAMP_FORMAT_LABELS["12-hour"])}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {t(TIMESTAMP_FORMAT_LABELS["24-hour"])}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function QuitShortcutRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  if (!isElectron) return null;
  return (
    <SettingsRow
      {...searchableSetting("quit-confirmation")}
      description={t("Hold mode also quits on two quick presses.")}
      resetAction={
        settings.confirmQuit !== DEFAULT_UNIFIED_SETTINGS.confirmQuit ? (
          <SettingResetButton
            label={t("quit shortcut behavior")}
            onClick={() => updateSettings({ confirmQuit: DEFAULT_UNIFIED_SETTINGS.confirmQuit })}
          />
        ) : null
      }
      control={
        <Select
          value={settings.confirmQuit}
          onValueChange={(value) => {
            if (value === "direct" || value === "hold" || value === "double-click") {
              updateSettings({ confirmQuit: value });
            }
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-40"
            aria-label={t("Quit shortcut behavior")}
          >
            <SelectValue>{t(QUIT_CONFIRMATION_MODE_LABELS[settings.confirmQuit])}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(QUIT_CONFIRMATION_MODE_LABELS).map(([value, label]) => (
              <SelectItem hideIndicator key={value} value={value}>
                {t(label)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

export function SendShortcutRow() {
  // oxlint-disable-next-line t3code/no-untranslated-text -- keyboard key names
  const modifierLabel = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";
  const sendShortcutOptions = [
    { value: "enter", label: t("Enter") },
    {
      value: "mod-enter-multiline",
      label: t("{modifier} + Enter for multiline prompts", { modifier: modifierLabel }),
    },
    { value: "mod-enter", label: t("{modifier} + Enter always", { modifier: modifierLabel }) },
  ] as const;
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("send-shortcut")}
      description={t("Choose when Enter sends a prompt or inserts a new line")}
      resetAction={
        settings.sendShortcut !== DEFAULT_UNIFIED_SETTINGS.sendShortcut ? (
          <SettingResetButton
            label={t("send shortcut")}
            onClick={() => updateSettings({ sendShortcut: DEFAULT_UNIFIED_SETTINGS.sendShortcut })}
          />
        ) : null
      }
      control={
        <Select
          value={settings.sendShortcut}
          onValueChange={(value) => {
            const option = sendShortcutOptions.find((option) => option.value === value);
            if (option) updateSettings({ sendShortcut: option.value });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-auto min-w-0 max-w-full"
            aria-label={t("Send shortcut")}
          >
            <SelectValue>
              {sendShortcutOptions.find((option) => option.value === settings.sendShortcut)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {sendShortcutOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <span className="flex items-center justify-between gap-4">
                  {option.label}
                  {settings.sendShortcut === option.value && <CheckIcon aria-hidden="true" />}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

export function ChatSettingsPanel() {
  // oxlint-disable-next-line t3code/no-untranslated-text -- keyboard key names
  const modifierLabel = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsPageContainer>
      <SettingsSection id="composer" title={t("Composer")}>
        <SettingsRow
          {...searchableSetting("composer-rich-text")}
          description={t("Show formatted Markdown as you type.")}
          resetAction={
            settings.composerRichTextEnabled !==
            DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled ? (
              <SettingResetButton
                label={t("rich text composer")}
                onClick={() =>
                  updateSettings({
                    composerRichTextEnabled: DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.composerRichTextEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ composerRichTextEnabled: Boolean(checked) })
              }
              aria-label={t("Rich text composer")}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("skill-availability")}
          serverScoped
          settingKeys={["skillAvailability"]}
          description={t(
            "Share skills from enabled providers on this environment. Skills requiring tools the selected model cannot use may not work.",
          )}
          resetAction={
            settings.skillAvailability !== DEFAULT_UNIFIED_SETTINGS.skillAvailability ? (
              <SettingResetButton
                label={t("skill availability")}
                onClick={() =>
                  updateSettings({ skillAvailability: DEFAULT_UNIFIED_SETTINGS.skillAvailability })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.skillAvailability}
              onValueChange={(value) => {
                if (value === "provider" || value === "shared") {
                  updateSettings({ skillAvailability: value });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-48"
                aria-label={t("Skill availability")}
              >
                <SelectValue>
                  {settings.skillAvailability === "shared"
                    ? t("Shared across models")
                    : t("By provider")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="provider">{t("By provider")}</SelectItem>
                <SelectItem value="shared">{t("Shared across models")}</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <AdvancedSettings targetIds={[searchableSetting("skills-in-slash-menu").id]}>
          <SettingsRow
            {...searchableSetting("skills-in-slash-menu")}
            description={t(
              "Also include skills in the / command menu. Skills always appear when you type $.",
            )}
            resetAction={
              settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu ? (
                <SettingResetButton
                  label={t("skills in slash menu")}
                  onClick={() =>
                    updateSettings({
                      showSkillsInSlashMenu: DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.showSkillsInSlashMenu}
                onCheckedChange={(checked) =>
                  updateSettings({ showSkillsInSlashMenu: Boolean(checked) })
                }
                aria-label={t("Show skills in slash menu")}
              />
            }
          />
        </AdvancedSettings>
      </SettingsSection>

      <SettingsSection id="follow-ups" title={t("Follow-ups")}>
        <SettingsRow
          {...searchableSetting("follow-up-behavior")}
          description={
            t("Queue follow-ups while the agent runs or steer the current run.") +
            " " +
            (settings.sendShortcut === "mod-enter-multiline"
              ? t(
                  "Press {modifier} + Enter for single-line prompts or {modifier} + Shift + Enter for multiline prompts to do the opposite for one message.",
                  { modifier: modifierLabel },
                )
              : settings.sendShortcut === "mod-enter"
                ? t("Press {modifier} + Shift + Enter to do the opposite for one message.", {
                    modifier: modifierLabel,
                  })
                : t("Press {modifier} + Enter to do the opposite for one message.", {
                    modifier: modifierLabel,
                  }))
          }
          resetAction={
            settings.followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior ? (
              <SettingResetButton
                label={t("follow-up behavior")}
                onClick={() =>
                  updateSettings({
                    followUpBehavior: DEFAULT_UNIFIED_SETTINGS.followUpBehavior,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.followUpBehavior}
              onValueChange={(value) => {
                if (value === "queue" || value === "steer") {
                  updateSettings({ followUpBehavior: value });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-auto min-w-0"
                aria-label={t("Follow-up behavior")}
              >
                <SelectValue>
                  {settings.followUpBehavior === "queue" ? t("Queue") : t("Steer")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="queue">{t("Queue")}</SelectItem>
                <SelectItem value="steer">{t("Steer")}</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <DiffsSettingsSections />

      {/* Window capture runs in the desktop app only. */}
      {isElectron ? <SnapShotSettings /> : null}
    </SettingsPageContainer>
  );
}

export function DiffColorsSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("diff-color-scheme")}
      description={t("Choose colors for additions and deletions, including change counts.")}
      resetAction={
        settings.diffColorScheme !== DEFAULT_UNIFIED_SETTINGS.diffColorScheme ? (
          <SettingResetButton
            label={t("diff colors")}
            onClick={() =>
              updateSettings({ diffColorScheme: DEFAULT_UNIFIED_SETTINGS.diffColorScheme })
            }
          />
        ) : null
      }
      control={
        <div className="w-full sm:w-40">
          <Select
            value={settings.diffColorScheme}
            onValueChange={(value) => {
              if (value === "red-green" || value === "blue-orange")
                updateSettings({ diffColorScheme: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full min-w-0" aria-label={t("Diff colors")}>
              <span
                aria-hidden="true"
                className={
                  settings.diffColorScheme === "blue-orange"
                    ? "flex shrink-0 flex-row-reverse gap-1"
                    : "flex shrink-0 gap-1"
                }
              >
                <span className="size-2 rounded-full bg-diff-deletion" />
                <span className="size-2 rounded-full bg-diff-addition" />
              </span>
              <SelectValue>
                {settings.diffColorScheme === "blue-orange" ? t("Blue & orange") : t("Red & green")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="red-green">{t("Red & green (default)")}</SelectItem>
              <SelectItem value="blue-orange">{t("Blue & orange")}</SelectItem>
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}

function DiffsSettingsSections() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <>
      <SettingsSection id="diffs" title={t("Diffs")}>
        <SettingsRow
          {...searchableSetting("diff-layout")}
          description={t(
            "Show diffs stacked or side by side. The toggle in the diff toolbar changes this too.",
          )}
          resetAction={
            settings.diffLayout !== DEFAULT_UNIFIED_SETTINGS.diffLayout ? (
              <SettingResetButton
                label={t("diff layout")}
                onClick={() => updateSettings({ diffLayout: DEFAULT_UNIFIED_SETTINGS.diffLayout })}
              />
            ) : null
          }
          control={
            <Select
              value={settings.diffLayout}
              onValueChange={(value) => {
                if (value === "stacked" || value === "split") {
                  updateSettings({ diffLayout: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={t("Diff layout")}>
                <SelectValue>{t(DIFF_LAYOUT_LABELS[settings.diffLayout])}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="stacked">
                  {t(DIFF_LAYOUT_LABELS.stacked)}
                </SelectItem>
                <SelectItem hideIndicator value="split">
                  {t(DIFF_LAYOUT_LABELS.split)}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("hide-whitespace-changes")}
          description={t("Set whether the diff panel ignores whitespace-only edits by default.")}
          resetAction={
            settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace ? (
              <SettingResetButton
                label={t("diff whitespace changes")}
                onClick={() =>
                  updateSettings({
                    diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffIgnoreWhitespace}
              onCheckedChange={(checked) =>
                updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
              }
              aria-label={t("Hide whitespace changes by default")}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("default-diff-file-state")}
          description={t(
            "Start with files expanded or collapsed when opening diffs or a pull request's Code tab.",
          )}
          resetAction={
            settings.diffFilesCollapsed !== DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed ? (
              <SettingResetButton
                label={t("default diff file state")}
                onClick={() =>
                  updateSettings({
                    diffFilesCollapsed: DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.diffFilesCollapsed ? "collapsed" : "expanded"}
              onValueChange={(value) => {
                if (value === "expanded" || value === "collapsed") {
                  updateSettings({ diffFilesCollapsed: value === "collapsed" });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label={t("Default diff file state")}
              >
                <SelectValue>
                  {settings.diffFilesCollapsed ? t("Collapsed") : t("Expanded")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="expanded">
                  {t("Expanded")}
                </SelectItem>
                <SelectItem hideIndicator value="collapsed">
                  {t("Collapsed")}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection id="pull-requests" title={t("Pull requests")}>
        <SettingsRow
          {...searchableSetting("proactive-panels")}
          description={t(
            "Open linked pull requests first. Otherwise, open Changes for edits to at least 3 files or 50 lines.",
          )}
          resetAction={
            settings.proactivePanelsEnabled !== DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled ? (
              <SettingResetButton
                label={t("proactive panels")}
                onClick={() =>
                  updateSettings({
                    proactivePanelsEnabled: DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.proactivePanelsEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ proactivePanelsEnabled: Boolean(checked) })
              }
              aria-label={t("Open pull requests and changes panels proactively")}
            />
          }
        />
      </SettingsSection>
    </>
  );
}

/** The Providers panel can render without a settings scope, as its tests do; this row needs one. */
function CompactIdleThreadsRow() {
  return useOptionalSettingsScope() === null ? null : <ScopedCompactIdleThreadsRow />;
}

function ScopedCompactIdleThreadsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { targets } = useSettingsScope();
  const idleCompaction = scopedIdleCompaction(targets.length > 0 ? targets : [{ settings }]);

  return (
    <SettingsRow
      serverScoped
      settingKeys={["idleCompaction", "compactIdleThreads"]}
      mixed={idleCompaction.mixed}
      {...searchableSetting("compact-idle-threads")}
      description={t(
        "When to compact an idle Claude thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Each Claude provider can override this.",
      )}
      resetAction={
        globalIdleCompaction(settings) !== globalIdleCompaction(DEFAULT_UNIFIED_SETTINGS) ? (
          <SettingResetButton
            label={t("compact idle threads")}
            onClick={() =>
              updateSettings({ idleCompaction: globalIdleCompaction(DEFAULT_UNIFIED_SETTINGS) })
            }
          />
        ) : null
      }
      control={
        <Select
          value={idleCompaction.mixed ? null : globalIdleCompaction(settings)}
          onValueChange={(value) => {
            const mode = IDLE_COMPACTION_MODES.find((candidate) => candidate.value === value);
            if (mode) updateSettings({ idleCompaction: mode.value });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-56"
            aria-label={t("Compact idle threads")}
          >
            <SelectValue>
              {(value: string | null) => {
                if (value === null) return t("Mixed");
                const mode = IDLE_COMPACTION_MODES.find((candidate) => candidate.value === value);
                return mode ? idleCompactionModeLabel(mode.value) : undefined;
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {IDLE_COMPACTION_MODES.map((mode) => (
              <SelectItem
                hideIndicator
                key={mode.value}
                value={mode.value}
                // A server from before modes has only the on/off switch, so it cannot store "Never".
                disabled={mode.value === "off" && !idleCompaction.neverAvailable}
              >
                {idleCompactionModeLabel(mode.value)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function ScheduledTaskPlacementSelect() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["scheduledTaskDefaultPlacement"]);
  return (
    <Select
      value={mixed ? null : settings.scheduledTaskDefaultPlacement}
      onValueChange={(value) => {
        const option = scheduledTaskPlacementOptions().find(
          (candidate) => candidate.value === value,
        );
        if (option) updateSettings({ scheduledTaskDefaultPlacement: option.value });
      }}
    >
      <SelectTrigger
        size="sm"
        className="w-full sm:w-44"
        aria-label={t("Show new scheduled tasks in")}
      >
        <SelectValue>
          {(value: string | null) =>
            value === null
              ? t("Mixed")
              : scheduledTaskPlacementOptions().find((option) => option.value === value)?.label
          }
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {scheduledTaskPlacementOptions().map((option) => (
          <SelectItem hideIndicator key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function ThreadsSettingsPanel() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { connectedEnvironments, scope } = useSettingsScope();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const hasServerTargets = connectedEnvironments.length > 0;
  const mixedResponseStreamingMode = useScopedSettingsMixed(["responseStreamingMode"]);
  const supportsAutoSettlementScope = connectedEnvironments.every(
    (target) => target.serverConfig?.environment.capabilities.threadAutoSettlementScope === true,
  );
  // Servers that check worktrees for unmerged work are the ones that read this setting.
  const supportsUnmergedWorkPullRequests = connectedEnvironments.every(
    (target) => target.serverConfig?.environment.capabilities.vcsUnmergedWork === true,
  );

  return (
    <SettingsPageContainer>
      <ProjectDefaultsSettings category="general" />
      {!isProjectScope ? (
        <SettingsSection id="snooze" title={t("Snooze")}>
          <SnoozePresetsRow />
        </SettingsSection>
      ) : null}

      <SettingsSection id="usage-limits" title={t("Usage limits")}>
        <SettingsRow
          serverScoped
          {...searchableSetting("auto-resume-limited-threads")}
          description={t(
            "Automatically resume threads when their usage limits reset. You can cancel auto-resume in each thread.",
          )}
          settingKeys={["autoResumeLimitedThreads"]}
          control={
            <ScopedSwitch
              settingKeys={["autoResumeLimitedThreads"]}
              checked={settings.autoResumeLimitedThreads}
              onCheckedChange={(checked) =>
                updateSettings({ autoResumeLimitedThreads: Boolean(checked) })
              }
              aria-label={t("Resume after usage limits")}
            />
          }
        />
        <SettingsRow
          serverScoped
          {...searchableSetting("snooze-limited-threads")}
          description={t(
            "Snooze threads until their usage limits reset. Enable auto-resume to continue the agent after the reset.",
          )}
          settingKeys={["snoozeLimitedThreads"]}
          control={
            <ScopedSwitch
              settingKeys={["snoozeLimitedThreads"]}
              checked={settings.snoozeLimitedThreads}
              onCheckedChange={(checked) =>
                updateSettings({ snoozeLimitedThreads: Boolean(checked) })
              }
              aria-label={t("Snooze until limits reset")}
            />
          }
        />
      </SettingsSection>

      {hasServerTargets ? (
        <SettingsSection id="auto-settle" title={t("Auto-settle")}>
          <SettingsRow
            serverScoped
            settingKeys={["sidebarAutoSettleOnMerge"]}
            {...searchableSetting("auto-settle-merged-threads")}
            description={t(
              "Settle a thread when its pull request merges. Closed pull requests still settle automatically.",
            )}
            resetAction={
              settings.sidebarAutoSettleOnMerge !==
              DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge ? (
                <SettingResetButton
                  label={t("auto-settle on merge")}
                  onClick={() =>
                    updateSettings({
                      sidebarAutoSettleOnMerge: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge,
                    })
                  }
                />
              ) : null
            }
            control={
              <ScopedSwitch
                settingKeys={["sidebarAutoSettleOnMerge"]}
                checked={settings.sidebarAutoSettleOnMerge}
                onCheckedChange={(checked) =>
                  updateSettings({ sidebarAutoSettleOnMerge: Boolean(checked) })
                }
                aria-label={t("Auto-settle merged threads")}
              />
            }
          />

          <SettingsRow
            serverScoped
            settingKeys={["sidebarAutoSettleAfterDays"]}
            {...searchableSetting("auto-settle-inactive-threads")}
            description={t("Sidebar threads with no activity for this long settle automatically.")}
            resetAction={
              settings.sidebarAutoSettleAfterDays !==
              DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ? (
                <SettingResetButton
                  label={t("auto-settle")}
                  onClick={() =>
                    updateSettings({
                      sidebarAutoSettleAfterDays:
                        DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
                    })
                  }
                />
              ) : null
            }
            control={
              <ScopedSwitch
                settingKeys={["sidebarAutoSettleAfterDays"]}
                checked={settings.sidebarAutoSettleAfterDays !== null}
                onCheckedChange={(checked) =>
                  updateSettings({
                    sidebarAutoSettleAfterDays: checked ? AUTO_SETTLE_DEFAULT_DAYS : null,
                  })
                }
                aria-label={t("Auto-settle inactive threads")}
              />
            }
          />
          {settings.sidebarAutoSettleAfterDays !== null ? (
            <SettingsRow
              serverScoped
              settingKeys={["sidebarAutoSettleAfterDays"]}
              title={searchableSetting("days-before-auto-settle").title}
              description={t("Any new activity un-settles a thread automatically.")}
              control={
                <AutoSettleDaysInput
                  value={settings.sidebarAutoSettleAfterDays}
                  onCommit={(days) => updateSettings({ sidebarAutoSettleAfterDays: days })}
                />
              }
            />
          ) : null}
          {settings.sidebarAutoSettleAfterDays !== null && supportsAutoSettlementScope ? (
            <SettingsRow
              serverScoped
              settingKeys={["sidebarAutoSettleKeepPullRequests"]}
              title={t("Keep threads with a PR")}
              description={t(
                "Inactivity does not settle threads with a pull request. Merge and close still do.",
              )}
              control={
                <ScopedSwitch
                  settingKeys={["sidebarAutoSettleKeepPullRequests"]}
                  checked={settings.sidebarAutoSettleKeepPullRequests}
                  onCheckedChange={(checked) =>
                    updateSettings({ sidebarAutoSettleKeepPullRequests: checked })
                  }
                  aria-label={t("Keep threads with a PR")}
                />
              }
            />
          ) : null}
          {(settings.sidebarAutoSettleAfterDays !== null || settings.sidebarAutoSettleOnMerge) &&
          supportsUnmergedWorkPullRequests ? (
            <SettingsRow
              serverScoped
              settingKeys={["sidebarAutoSettleOpensPullRequests"]}
              {...searchableSetting("auto-settle-opens-pull-requests")}
              description={t(
                "Before a thread whose worktree has unmerged changes settles on its own, commit them and open a pull request. Off keeps those threads active.",
              )}
              control={
                <ScopedSwitch
                  settingKeys={["sidebarAutoSettleOpensPullRequests"]}
                  checked={settings.sidebarAutoSettleOpensPullRequests}
                  onCheckedChange={(checked) =>
                    updateSettings({ sidebarAutoSettleOpensPullRequests: checked })
                  }
                  aria-label={t("Open a PR for unmerged work")}
                />
              }
            />
          ) : null}
        </SettingsSection>
      ) : null}

      <SettingsSection id="thread-behavior" title={t("Behavior")}>
        <CompactIdleThreadsRow />
        <SettingsRow
          serverScoped
          settingKeys={["responseStreamingMode"]}
          {...searchableSetting("response-streaming")}
          description={
            mixedResponseStreamingMode
              ? t("The selected targets use different streaming modes.")
              : t(RESPONSE_STREAMING_MODE_DESCRIPTIONS[settings.responseStreamingMode])
          }
          resetAction={
            settings.responseStreamingMode !== DEFAULT_UNIFIED_SETTINGS.responseStreamingMode ? (
              <SettingResetButton
                label={t("response streaming")}
                onClick={() =>
                  updateSettings({
                    responseStreamingMode: DEFAULT_UNIFIED_SETTINGS.responseStreamingMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={mixedResponseStreamingMode ? null : settings.responseStreamingMode}
              onValueChange={(value) => {
                if (value === "turn" || value === "paragraph") {
                  updateSettings({ responseStreamingMode: value });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-56"
                aria-label={t("Response streaming")}
              >
                <SelectValue>
                  {(value: ResponseStreamingMode | null) =>
                    value === null ? t("Mixed") : t(RESPONSE_STREAMING_MODE_LABELS[value])
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="turn">
                  {t(RESPONSE_STREAMING_MODE_LABELS.turn)}
                </SelectItem>
                <SelectItem hideIndicator value="paragraph">
                  {t(RESPONSE_STREAMING_MODE_LABELS.paragraph)}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("archive")}
          description={t("Threads you archived, with restore and delete.")}
          control={
            <Button render={<Link to="/archived" />} size="sm" variant="outline">
              {t("View archived")}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

/** Text generation model and thread title instructions, shown under Providers & models. */
export function TextGenerationSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environment, connectedEnvironments, target } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const textGenerationModelSelection = resolveAppModelSelectionState(
    settings,
    textGenerationProviders,
  );
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const textGenerationModelInstanceEntries = providerInstanceEntriesFor(
    textGenerationProviders,
    settings,
    target?.projectId ?? null,
  );
  const hasTextGenerationProvider = textGenerationModelInstanceEntries.some(
    (entry) => entry.enabled && entry.isAvailable,
  );
  const textGenInstanceEntry = textGenerationModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  );
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const textGenerationModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    textGenerationProviders,
    textGenInstanceId,
    textGenModel,
  );
  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const textGenerationModelDisabledReason = useScopedModelDisabledReason(
    settings,
    textGenerationModelInstanceEntries,
  );
  const mixedTextGenerationModel = useScopedSettingsMixed(["textGenerationModelSelection"]);

  return (
    <SettingsSection id="text-generation" title={t("Writing")}>
      <SettingsRow
        serverScoped
        settingKeys={["textGenerationModelSelection"]}
        {...searchableSetting("text-generation-model")}
        description={t(
          "Used for thread titles and other generated text on connected devices with this provider. Source control can override it.",
        )}
        resetAction={
          hasServerTargets && isTextGenerationModelDirty ? (
            <SettingResetButton
              label={t("text generation model")}
              onClick={() =>
                updateSettings({
                  textGenerationModelSelection:
                    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                })
              }
            />
          ) : null
        }
        control={
          !hasServerTargets ? (
            <span className="text-sm text-muted-foreground">
              {t("Connect an environment to choose its text generation model.")}
            </span>
          ) : !hasTextGenerationProvider ? (
            <span className="text-sm text-muted-foreground">
              {t("No text generation providers available.")}
            </span>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                environmentId={environmentId}
                activeInstanceId={textGenInstanceId}
                model={textGenModel}
                lockedProvider={null}
                instanceEntries={textGenerationModelInstanceEntries}
                modelOptionsByInstance={textGenerationModelOptionsByInstance}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                {...(mixedTextGenerationModel ? { triggerLabel: t("Mixed") } : {})}
                getModelDisabledReason={textGenerationModelDisabledReason}
                {...(environmentId
                  ? {
                      onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                        void navigate({
                          to: "/settings/providers",
                          search: { environmentId, instanceId },
                        });
                      },
                    }
                  : {})}
                onInstanceModelChange={(instanceId, model) => {
                  const reason = textGenerationModelDisabledReason(instanceId, model);
                  if (reason) {
                    toastManager.add({
                      type: "error",
                      title: t("Text generation model not saved"),
                      description: reason,
                    });
                    return;
                  }
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(instanceId, model),
                      },
                      textGenerationProviders,
                    ),
                  });
                }}
              />
              {textGenInstanceEntry ? (
                <TraitsPicker
                  provider={textGenProvider}
                  models={textGenInstanceEntry?.models ?? []}
                  model={textGenModel}
                  modelOptions={textGenModelOptions}
                  allowPromptInjectedEffort={false}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onModelOptionsChange={(nextOptions) => {
                    updateSettings({
                      textGenerationModelSelection: resolveAppModelSelectionState(
                        {
                          ...settings,
                          textGenerationModelSelection: createModelSelection(
                            textGenInstanceId,
                            textGenModel,
                            nextOptions,
                          ),
                        },
                        textGenerationProviders,
                      ),
                    });
                  }}
                />
              ) : null}
            </div>
          )
        }
      />
      <AdvancedSettings targetIds={[searchableSetting("thread-title-instructions").id]}>
        <ThreadTitleInstructionsSettings />
      </AdvancedSettings>
    </SettingsSection>
  );
}

/** Where Add Project starts and how clones are laid out, shown on the Projects page. */
export function NewProjectsSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedAddProjectBaseDirectory = useScopedSettingsMixed(["addProjectBaseDirectory"]);
  return (
    <>
      <SettingsSection id="new-projects" title={t("New projects")}>
        <SettingsRow
          serverScoped
          settingKeys={["addProjectBaseDirectory"]}
          {...searchableSetting("add-project-starts-in")}
          description={t('Leave empty to use "~/" when the Add Project browser opens.')}
          resetAction={
            settings.addProjectBaseDirectory !==
            DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
              <SettingResetButton
                label={t("add project base directory")}
                onClick={() =>
                  updateSettings({
                    addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                  })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              size="sm"
              className="w-full sm:w-72"
              value={mixedAddProjectBaseDirectory ? "" : settings.addProjectBaseDirectory}
              onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
              normalizeDraft={resolvePastedPath}
              placeholder={mixedAddProjectBaseDirectory ? t("Mixed") : "~/"}
              spellCheck={false}
              aria-label={t("Add project base directory")}
            />
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["ghqCloneLayout"]}
          {...searchableSetting("ghq-clone-layout")}
          description={t("Clones go to github.com/owner/repo under the folder above, like ghq.")}
          resetAction={
            settings.ghqCloneLayout !== DEFAULT_UNIFIED_SETTINGS.ghqCloneLayout ? (
              <SettingResetButton
                label={t("clone into host folders")}
                onClick={() =>
                  updateSettings({ ghqCloneLayout: DEFAULT_UNIFIED_SETTINGS.ghqCloneLayout })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["ghqCloneLayout"]}
              checked={settings.ghqCloneLayout}
              onCheckedChange={(checked) => updateSettings({ ghqCloneLayout: Boolean(checked) })}
              aria-label={t("Clone into host folders")}
            />
          }
        />
      </SettingsSection>
      <AgentConversationsSettings />
    </>
  );
}

function ResetAllSettingsRow() {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(null);
  return (
    <SettingsRow
      title={t("Reset all settings")}
      description={t(
        "Restore every setting on these pages to its default. Each page also has its own reset.",
      )}
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={changedSettingLabels.length === 0}
          onClick={() => void restoreDefaults()}
        >
          {t("Reset all")}
        </Button>
      }
    />
  );
}

export function MaintenanceSettingsPanel() {
  const openSetupWizard = useOpenSetupWizard();
  const primaryPolicy = usePrimaryManagedPolicy();
  const telemetryOff = managedTelemetryOffMessage(primaryPolicy);
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const isEnvironmentScope = scope.environmentIds.length === 1 && environmentId !== null;
  const hasServerTargets = connectedEnvironments.length > 0;
  // The App, Legal, and setup sections belong to this device, so only the server sections step aside.
  const serverUnavailableMessage =
    scope.kind === "unavailable"
      ? scope.message
      : !hasServerTargets
        ? scope.kind === "environment"
          ? t("Reconnect {environment} to change its settings.", { environment: scope.label })
          : t("Connect an environment to change its settings.")
        : null;

  return (
    <SettingsPageContainer>
      {serverUnavailableMessage !== null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {serverUnavailableMessage}
        </p>
      ) : (
        <>
          <SettingsSection id="updates" title={t("Updates")}>
            <SettingsRow
              serverScoped
              settingKeys={["enableProviderUpdateChecks"]}
              {...searchableSetting("provider-update-checks")}
              description={t(
                "Check installed provider CLIs for newer available versions and fetch model catalog updates. When off, new models may not appear.",
              )}
              resetAction={
                settings.enableProviderUpdateChecks !==
                DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks ? (
                  <SettingResetButton
                    label={t("provider update checks")}
                    onClick={() =>
                      updateSettings({
                        enableProviderUpdateChecks:
                          DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
                      })
                    }
                  />
                ) : null
              }
              control={
                <ScopedSwitch
                  settingKeys={["enableProviderUpdateChecks"]}
                  checked={settings.enableProviderUpdateChecks}
                  onCheckedChange={(checked) =>
                    updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
                  }
                  aria-label={t("Check provider versions")}
                />
              }
            />
            <SettingsRow
              serverScoped
              settingKeys={["autoUpdateProviders"]}
              {...searchableSetting("auto-update-providers")}
              description={t(
                "Update provider CLIs that are behind the latest version when the server starts. Needs provider update checks.",
              )}
              resetAction={
                settings.autoUpdateProviders !== DEFAULT_UNIFIED_SETTINGS.autoUpdateProviders ? (
                  <SettingResetButton
                    label={t("automatic provider updates")}
                    onClick={() =>
                      updateSettings({
                        autoUpdateProviders: DEFAULT_UNIFIED_SETTINGS.autoUpdateProviders,
                      })
                    }
                  />
                ) : null
              }
              control={
                <ScopedSwitch
                  settingKeys={["autoUpdateProviders"]}
                  checked={settings.autoUpdateProviders}
                  onCheckedChange={(checked) =>
                    updateSettings({ autoUpdateProviders: Boolean(checked) })
                  }
                  aria-label={t("Update providers automatically")}
                />
              }
            />
            <SettingsRow
              {...searchableSetting("continue-threads-after-server-update")}
              serverScoped
              settingKeys={["continueThreadsAfterServerUpdate"]}
              description={t(
                "Automatically resume interrupted threads after an update, crash, or machine restart on the selected environments.",
              )}
              status={
                !hasServerTargets
                  ? t("All selected connected environments must support restart continuation.")
                  : undefined
              }
              resetAction={
                hasServerTargets &&
                settings.continueThreadsAfterServerUpdate !==
                  DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate ? (
                  <SettingResetButton
                    label={t("continue threads after restarts")}
                    onClick={() =>
                      updateSettings({
                        continueThreadsAfterServerUpdate:
                          DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate,
                      })
                    }
                  />
                ) : null
              }
              control={
                <ScopedSwitch
                  settingKeys={["continueThreadsAfterServerUpdate"]}
                  checked={settings.continueThreadsAfterServerUpdate}
                  disabled={!hasServerTargets}
                  onCheckedChange={(checked) =>
                    updateSettings({ continueThreadsAfterServerUpdate: Boolean(checked) })
                  }
                  aria-label={t("Continue threads after restarts")}
                />
              }
            />
          </SettingsSection>

          <SettingsSection id="background" title={t("Background activity")}>
            <BackgroundActivitySettingsRow />
          </SettingsSection>

          <StorageCleanupSections />

          <SettingsSection id="diagnostics-section" title={t("Diagnostics")}>
            <SettingsRow
              {...searchableSetting("diagnostics")}
              description={
                isEnvironmentScope
                  ? t("Inspect processes, resource use, and logs on this environment.")
                  : t("Inspect processes, resource use, and logs on one environment at a time.")
              }
              control={
                <Button
                  render={
                    <Link
                      to="/settings/diagnostics"
                      search={{ machine: environmentId ?? undefined }}
                    />
                  }
                  size="sm"
                  variant="outline"
                >
                  {t("View diagnostics")}
                </Button>
              }
            />
          </SettingsSection>
        </>
      )}

      <SettingsSection id="setup" title={t("Setup")}>
        <SettingsRow
          {...searchableSetting("setup-wizard")}
          description={t("Connect machines, set up agents, and import projects again.")}
          control={
            <Button size="sm" variant="outline" onClick={() => openSetupWizard()}>
              {t("Run setup again")}
            </Button>
          }
        />
        <ResetAllSettingsRow />
      </SettingsSection>

      <SettingsSection id="about" title={t("App")}>
        {primaryPolicy ? (
          <SettingsRow
            title={t("Organization")}
            description={t(
              "This environment is managed by {organization}. Some settings and features follow its policy.",
              { organization: primaryPolicy.organization },
            )}
            control={
              primaryPolicy.supportUrl ? (
                <Button
                  render={
                    <a href={primaryPolicy.supportUrl} target="_blank" rel="noreferrer noopener" />
                  }
                  size="sm"
                  variant="outline"
                >
                  {t("Get help")}
                </Button>
              ) : null
            }
          />
        ) : null}
        {isElectron || HOSTED_APP_CHANNEL ? (
          <AboutVersionSection />
        ) : (
          <>
            <SettingsRow
              id={searchableSetting("app-version").id}
              title={<AboutVersionTitle />}
              description={t("Current version of the application.")}
            />
          </>
        )}
        <MobileAppSettingsRow />
      </SettingsSection>

      <SettingsSection id="legal" title={t("Legal")}>
        <SettingsRow
          {...searchableSetting("privacy-policy")}
          description={
            telemetryOff === undefined
              ? t(
                  "How we handle your data, including the anonymous usage data T3.CodeShip collects.",
                )
              : t("How we handle your data. {telemetryOff}", { telemetryOff })
          }
          control={
            <Button
              render={<a href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer noopener" />}
              size="sm"
              variant="outline"
            >
              {t("View policy")}
            </Button>
          }
        />
        <SettingsRow
          {...searchableSetting("open-source-licenses")}
          description={t(
            "Notices for dependencies, assets, and optional tools used by T3.CodeShip.",
          )}
          control={
            <Button
              render={<Link to="/settings/open-source-licenses" />}
              size="sm"
              variant="outline"
            >
              {t("View licenses")}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
