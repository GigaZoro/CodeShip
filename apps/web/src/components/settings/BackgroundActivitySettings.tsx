import { useScopedSettingsWriteAllowed } from "./useScopedSettings";
import { cn } from "../../lib/utils";
import { msg, t, type Message } from "~/i18n";
import { SettingsIcon } from "lucide-react";
import { useState } from "react";
import { type BackgroundActivityProfile } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  backgroundActivityOverrideSettings,
  backgroundActivitySharedPolicySettings,
  durationToSeconds,
  isBackgroundIntervalOverridden,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
  resolveBackgroundActivityProfileOption,
} from "./SettingsPanels.logic";
import { CommittedNumberField, IntervalSecondsField } from "./IntervalSecondsField";
import { ScopedSwitch } from "./ScopedSwitch";
import { PolicyTooltip, SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const BACKGROUND_ACTIVITY_PROFILE_LABELS: Record<BackgroundActivityProfile, Message> = {
  balanced: msg("Balanced"),
  performance: msg("Performance"),
  "battery-saver": msg("Battery saver"),
};

type BackgroundActivityProfileOption = BackgroundActivityProfile | "advanced";

const BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS: Record<BackgroundActivityProfileOption, Message> =
  {
    ...BACKGROUND_ACTIVITY_PROFILE_LABELS,
    advanced: msg("Advanced"),
  };

const BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS: Record<BackgroundActivityProfile, Message> = {
  balanced: msg("Pauses probes for idle clients, locked hosts, or low power mode."),
  performance: msg(
    "Allows scoped background probes while any subscribed client remains connected.",
  ),
  "battery-saver": msg("Also pauses background probes when the host or client is on battery."),
};

const BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES: ReadonlyArray<{
  readonly key:
    | "pauseWhenHostLocked"
    | "pauseWhenHostLowPower"
    | "pauseWhenClientLowPower"
    | "pauseWhenOnBattery";
  readonly label: Message;
}> = [
  { key: "pauseWhenHostLocked", label: msg("Pause when host is locked") },
  { key: "pauseWhenHostLowPower", label: msg("Pause on host low power") },
  { key: "pauseWhenClientLowPower", label: msg("Pause on client low power") },
  { key: "pauseWhenOnBattery", label: msg("Pause on battery") },
];

function resetBackgroundActivitySettings() {
  return {
    backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  };
}

function backgroundActivityProfileSettings(profile: BackgroundActivityProfile) {
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile,
      overrides: {},
    },
  };
}

function BackgroundActivityAdvancedDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const canWriteSettings = useScopedSettingsWriteAllowed();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeProfile = resolvedBackgroundActivity.profile;
  const automaticGitFetchIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.automaticGitFetchInterval,
  );
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  );
  const hostPowerMonitorActiveIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorActiveInterval,
  );
  const hostPowerMonitorIdleIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorIdleInterval,
  );

  return (
    <Dialog open={open && canWriteSettings} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("Background Activity")}</DialogTitle>
          <DialogDescription>
            {t("Tune the shared power policy and the background intervals that feed it.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset
            disabled={!canWriteSettings}
            className="min-w-0 overflow-hidden rounded-xl border bg-card text-card-foreground"
          >
            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">{t("Shared policy")}</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("Controls whether background work may run after a subscribed interval fires.")}
                </p>
              </div>
              <Select
                value={activeProfile}
                onValueChange={(value) => {
                  if (
                    value === "balanced" ||
                    value === "performance" ||
                    value === "battery-saver"
                  ) {
                    updateSettings({
                      backgroundActivity: backgroundActivitySharedPolicySettings(settings, value),
                    });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label={t("Shared background policy")}
                >
                  <SelectValue>{t(BACKGROUND_ACTIVITY_PROFILE_LABELS[activeProfile])}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="balanced">
                    {t(BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced)}
                  </SelectItem>
                  <SelectItem hideIndicator value="performance">
                    {t(BACKGROUND_ACTIVITY_PROFILE_LABELS.performance)}
                  </SelectItem>
                  <SelectItem hideIndicator value="battery-saver">
                    {t(BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"])}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>

            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">
                  {searchableSetting("git-fetch-interval").title}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("Refresh remote branch status in the background.")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <IntervalSecondsField
                  label={t("Git fetch interval")}
                  value={automaticGitFetchIntervalSeconds}
                  min={0}
                  step={5}
                  onCommit={(seconds, options) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        { automaticGitFetchInterval: Duration.seconds(seconds) },
                      ),
                      options,
                    )
                  }
                />
                <span className="text-xs text-muted-foreground">{t("seconds")}</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">{t("Provider health interval")}</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t(
                    "Refresh provider availability, versions, and auth state. Model catalog updates follow Provider update checks.",
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <IntervalSecondsField
                  label={t("provider health interval")}
                  value={providerHealthRefreshIntervalSeconds}
                  min={0}
                  step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
                  onCommit={(seconds, options) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        { providerHealthRefreshInterval: Duration.seconds(seconds) },
                      ),
                      options,
                    )
                  }
                />
                <span className="text-xs text-muted-foreground">{t("seconds")}</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">{t("Host power monitor")}</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("Poll host power state while clients are active.")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <IntervalSecondsField
                  label={t("active host power interval")}
                  value={hostPowerMonitorActiveIntervalSeconds}
                  min={5}
                  step={5}
                  onCommit={(seconds, options) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        { hostPowerMonitorActiveInterval: Duration.seconds(seconds) },
                      ),
                      options,
                    )
                  }
                />
                <span className="text-xs text-muted-foreground">{t("seconds")}</span>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">{t("Idle host monitor")}</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("Poll host power state when no foreground client is active.")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <IntervalSecondsField
                  label={t("idle host power interval")}
                  value={hostPowerMonitorIdleIntervalSeconds}
                  min={5}
                  step={30}
                  onCommit={(seconds, options) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        { hostPowerMonitorIdleInterval: Duration.seconds(seconds) },
                      ),
                      options,
                    )
                  }
                />
                <span className="text-xs text-muted-foreground">{t("seconds")}</span>
              </div>
            </div>

            <div className="grid gap-0 border-t sm:grid-cols-2">
              {BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES.map(({ key, label }) => (
                <label
                  key={key}
                  className="flex items-center justify-between gap-3 border-b px-4 py-3 last:border-b-0 sm:border-r sm:even:border-r-0"
                >
                  <span className="text-sm font-medium">{t(label)}</span>
                  <Switch
                    checked={resolvedBackgroundActivity[key]}
                    onCheckedChange={(checked) =>
                      updateSettings(
                        backgroundActivityOverrideSettings(
                          settings.backgroundActivity,
                          resolvedBackgroundActivity,
                          {
                            [key]: Boolean(checked),
                          },
                        ),
                      )
                    }
                    aria-label={t(label)}
                  />
                </label>
              ))}
            </div>
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={!canWriteSettings}
            onClick={() => updateSettings(resetBackgroundActivitySettings())}
          >
            {t("Reset all")}
          </Button>
          <Button onClick={() => onOpenChange(false)}>{t("Done")}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function BackgroundActivitySettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { scope, environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const isEnvironmentScope = scope.environmentIds.length === 1 && environmentId !== null;
  const [backgroundActivityDialogOpen, setBackgroundActivityDialogOpen] = useState(false);
  const mixedBackgroundActivity = useScopedSettingsMixed(["backgroundActivity"]);
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeBackgroundActivityProfile = resolvedBackgroundActivity.profile;
  const backgroundActivityProfileOption = resolveBackgroundActivityProfileOption(settings);
  const backgroundActivityDescription =
    backgroundActivityProfileOption === "advanced"
      ? t("Uses custom intervals. Shared policy: {policy}.", {
          policy: t(BACKGROUND_ACTIVITY_PROFILE_LABELS[activeBackgroundActivityProfile]),
        })
      : t(BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS[resolvedBackgroundActivity.profile]);
  const canResetBackgroundActivity = !Equal.equals(
    settings.backgroundActivity,
    DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  );

  return (
    <SettingsRow
      serverScoped
      settingKeys={["backgroundActivity"]}
      id={searchableSetting("background-activity").id}
      title={
        <span className="inline-flex items-center gap-1.5">
          {searchableSetting("background-activity").title}
          <PolicyTooltip>
            {t(
              "This shared policy gates background work such as Git refreshes and provider health probes after their individual intervals elapse.",
            )}
          </PolicyTooltip>
        </span>
      }
      description={backgroundActivityDescription}
      resetAction={
        canResetBackgroundActivity ? (
          <SettingResetButton
            label={t("background activity")}
            onClick={() => updateSettings(resetBackgroundActivitySettings())}
          />
        ) : null
      }
      control={
        <>
          <Select
            value={mixedBackgroundActivity ? null : backgroundActivityProfileOption}
            onValueChange={(value) => {
              if (value === "advanced") {
                if (isEnvironmentScope) setBackgroundActivityDialogOpen(true);
                return;
              }
              if (value === "balanced" || value === "performance" || value === "battery-saver") {
                updateSettings(backgroundActivityProfileSettings(value));
              }
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-40"
              aria-label={t("Background activity profile")}
            >
              <SelectValue>
                {(value: BackgroundActivityProfileOption | null) =>
                  value === null ? t("Mixed") : t(BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS[value])
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="balanced">
                {t(BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced)}
              </SelectItem>
              <SelectItem hideIndicator value="performance">
                {t(BACKGROUND_ACTIVITY_PROFILE_LABELS.performance)}
              </SelectItem>
              <SelectItem hideIndicator value="battery-saver">
                {t(BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"])}
              </SelectItem>
              <SelectItem hideIndicator value="advanced" disabled={!isEnvironmentScope}>
                {isEnvironmentScope
                  ? t(BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS.advanced)
                  : t("Advanced (one environment)")}
              </SelectItem>
            </SelectPopup>
          </Select>
          {backgroundActivityProfileOption === "advanced" && isEnvironmentScope ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="outline"
                    aria-label={t("Configure advanced background activity")}
                    onClick={() => setBackgroundActivityDialogOpen(true)}
                  >
                    <SettingsIcon className="size-4" />
                  </Button>
                }
              />
              <TooltipPopup side="top">{t("Configure background activity")}</TooltipPopup>
            </Tooltip>
          ) : null}
          <BackgroundActivityAdvancedDialog
            open={backgroundActivityDialogOpen && isEnvironmentScope}
            onOpenChange={setBackgroundActivityDialogOpen}
          />
        </>
      }
    />
  );
}

export function ProviderHealthIntervalRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const canWriteSettings = useScopedSettingsWriteAllowed();
  const resolved = resolveServerBackgroundActivitySettings(settings);
  const setInterval = (
    providerHealthRefreshInterval: Duration.Duration | undefined,
    options?: Parameters<typeof updateSettings>[1],
  ) =>
    updateSettings(
      backgroundActivityOverrideSettings(settings.backgroundActivity, resolved, {
        providerHealthRefreshInterval,
      }),
      options,
    );
  return (
    <SettingsRow
      serverScoped
      settingKeys={["backgroundActivity"]}
      {...searchableSetting("provider-health-check-interval")}
      description={t(
        "Refresh provider status, versions, and models in the background. Set to 0 to disable. The Background activity policy decides when probes may run.",
      )}
      resetAction={
        canWriteSettings &&
        isBackgroundIntervalOverridden(settings, "providerHealthRefreshInterval") ? (
          <SettingResetButton
            label={t("provider health check interval")}
            onClick={() => setInterval(undefined)}
          />
        ) : null
      }
      control={
        <div inert={!canWriteSettings} className="flex shrink-0 items-center gap-2">
          <IntervalSecondsField
            label={t("provider health check interval")}
            value={durationToSeconds(resolved.providerHealthRefreshInterval)}
            min={0}
            step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
            onCommit={(seconds, options) => setInterval(Duration.seconds(seconds), options)}
          />
          <span className="text-xs text-muted-foreground">{t("seconds")}</span>
        </div>
      }
    />
  );
}

export function GitFetchIntervalRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const canWriteSettings = useScopedSettingsWriteAllowed();
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const seconds = durationToSeconds(resolvedBackgroundActivity.automaticGitFetchInterval);
  const setInterval = (
    automaticGitFetchInterval: Duration.Duration | undefined,
    options?: Parameters<typeof updateSettings>[1],
  ) =>
    updateSettings(
      backgroundActivityOverrideSettings(settings.backgroundActivity, resolvedBackgroundActivity, {
        automaticGitFetchInterval,
      }),
      options,
    );
  return (
    <SettingsRow
      serverScoped
      settingKeys={["backgroundActivity"]}
      {...searchableSetting("git-fetch-interval")}
      description={t(
        "Refresh remote branch status in the background. Set to 0 to turn it off. The Background activity policy decides when fetches may run.",
      )}
      resetAction={
        isBackgroundIntervalOverridden(settings, "automaticGitFetchInterval") &&
        canWriteSettings ? (
          <SettingResetButton
            label={t("git fetch interval")}
            onClick={() => setInterval(undefined)}
          />
        ) : null
      }
      control={
        <div
          inert={!canWriteSettings}
          className={
            canWriteSettings
              ? "flex shrink-0 items-center gap-2"
              : "flex shrink-0 items-center gap-2 opacity-50"
          }
        >
          <IntervalSecondsField
            label={t("Git fetch interval")}
            value={seconds}
            min={0}
            step={5}
            onCommit={(next, options) => setInterval(Duration.seconds(next), options)}
          />
          <span className="text-xs text-muted-foreground">{t("seconds")}</span>
        </div>
      }
    />
  );
}

const clampRounded = (value: number, min: number, max: number, step: number) =>
  Math.min(max, Math.max(min, Math.round(value / step) * step));

export function AutomatedStartMemoryGuardRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["automatedStartMemoryGuard"]}
      {...searchableSetting("automated-start-memory-guard")}
      description={t(
        "Scheduled tasks, delegated tasks and the emulators agents open wait while this machine is short of memory. Chats you start always run.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["automatedStartMemoryGuard"]}
          checked={settings.automatedStartMemoryGuard.enabled}
          onCheckedChange={(checked) =>
            updateSettings({ automatedStartMemoryGuard: { enabled: Boolean(checked) } })
          }
          aria-label={t("Wait for memory before automated starts")}
        />
      }
    />
  );
}

export function AutomatedStartMemoryLimitsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const canWriteSettings = useScopedSettingsWriteAllowed();
  const guard = settings.automatedStartMemoryGuard;
  const defaults = DEFAULT_UNIFIED_SETTINGS.automatedStartMemoryGuard;
  const editable = canWriteSettings && guard.enabled;
  const setLimits = (
    limits: { readonly compressorShare?: number; readonly reserveGiB?: number },
    options?: Parameters<typeof updateSettings>[1],
  ) => updateSettings({ automatedStartMemoryGuard: limits }, options);
  return (
    <SettingsRow
      serverScoped
      settingKeys={["automatedStartMemoryGuard"]}
      {...searchableSetting("automated-start-memory-limits")}
      description={t(
        "On macOS, memory is short once compressed memory takes this share of it. On Linux and Windows, once less than the reserve is available.",
      )}
      resetAction={
        canWriteSettings &&
        (guard.compressorShare !== defaults.compressorShare ||
          guard.reserveGiB !== defaults.reserveGiB) ? (
          <SettingResetButton
            label={t("memory limits")}
            onClick={() =>
              setLimits({
                compressorShare: defaults.compressorShare,
                reserveGiB: defaults.reserveGiB,
              })
            }
          />
        ) : null
      }
      control={
        <div
          inert={!editable}
          className={cn(
            "grid shrink-0 grid-cols-[auto_auto] items-center gap-2",
            !editable && "opacity-50",
          )}
        >
          <CommittedNumberField
            label={t("compressed memory share")}
            inputLabel={t("Compressed memory share in percent")}
            value={Math.round(guard.compressorShare * 100)}
            min={5}
            max={100}
            step={5}
            normalize={(percent) => clampRounded(percent, 5, 100, 1)}
            onCommit={(percent, options) => setLimits({ compressorShare: percent / 100 }, options)}
          />
          <span className="text-xs text-muted-foreground">{t("% on macOS")}</span>
          <CommittedNumberField
            label={t("memory reserve")}
            inputLabel={t("Memory reserve in GiB")}
            value={guard.reserveGiB}
            min={0}
            max={1024}
            step={0.5}
            normalize={(gib) => clampRounded(gib, 0, 1024, 0.5)}
            onCommit={(reserveGiB, options) => setLimits({ reserveGiB }, options)}
          />
          <span className="text-xs text-muted-foreground">{t("GiB on Linux and Windows")}</span>
        </div>
      }
    />
  );
}
