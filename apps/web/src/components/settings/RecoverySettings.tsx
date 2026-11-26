import { useState } from "react";
import * as Schema from "effect/Schema";
import {
  AUTOMATIC_UPDATE_INTERVAL_HOURS,
  AutomaticUpdateIntervalHours,
  ProviderUpdatesChoice,
  MAX_PLAN_RESET_WAIT_HOURS,
  UsageLimitRecoveryChoice,
  providerUpdatesChoice,
  providerUpdatesPatch,
  usageLimitRecoveryChoice,
  usageLimitRecoveryPatch,
} from "@t3tools/contracts/settings";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { msg, t } from "~/i18n";

const isUsageLimitRecoveryChoice = Schema.is(UsageLimitRecoveryChoice);
const isProviderUpdatesChoice = Schema.is(ProviderUpdatesChoice);
const isAutomaticUpdateIntervalHours = Schema.is(AutomaticUpdateIntervalHours);

const recoveryLabels = {
  off: msg("Do nothing"),
  resume: msg("Resume when the limit resets"),
  "switch-and-resume": msg("Switch to another account, else resume when the limit resets"),
  custom: msg("Custom"),
};
const updateLabels = {
  off: msg("Off"),
  notify: msg("Notify me"),
  automatic: msg("Install automatically"),
  custom: msg("Custom: automatic updates without checks"),
};

export function UsageLimitRecoverySettings() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const keys = ["autoResumeLimitedThreads", "failoverLimitedThreads"] as const;
  const mixed = useScopedSettingsMixed(keys);
  const choice = usageLimitRecoveryChoice(settings);
  return (
    <>
      <SettingsRow
        {...searchableSetting("usage-limit-recovery")}
        serverScoped
        settingKeys={keys}
        description={t(
          "Choose how stopped threads recover. Switching uses another signed-in subscription account of the same provider, never API-key or Bedrock accounts. Some providers' terms forbid using extra accounts to get around limits. Custom keeps account switching without automatic resume until you choose an action.",
        )}
        control={
          <div className="w-full sm:w-72">
            <Select
              value={mixed ? null : choice}
              onValueChange={(value) => {
                if (isUsageLimitRecoveryChoice(value)) update(usageLimitRecoveryPatch(value));
              }}
            >
              <SelectTrigger size="sm" aria-label={t("When a thread hits a usage limit")}>
                <SelectValue>{mixed ? t("Mixed") : t(recoveryLabels[choice])}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {choice === "custom" ? (
                  <SelectItem value="custom" disabled>
                    {t(recoveryLabels.custom)}
                  </SelectItem>
                ) : null}
                {UsageLimitRecoveryChoice.literals.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(recoveryLabels[value])}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        }
      />
      <SettingsRow
        title={t("Hide limited threads until the limit resets")}
        serverScoped
        settingKeys={["snoozeLimitedThreads"]}
        control={
          <ScopedSwitch
            settingKeys={["snoozeLimitedThreads"]}
            checked={settings.snoozeLimitedThreads}
            onCheckedChange={(checked) => update({ snoozeLimitedThreads: checked })}
            aria-label={t("Hide limited threads until the limit resets")}
          />
        }
      />
    </>
  );
}

export function ProviderUpdatesSettings() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const keys = ["enableProviderUpdateChecks", "autoUpdateProviders"] as const;
  const mixed = useScopedSettingsMixed(keys);
  const choice = providerUpdatesChoice(settings);
  return (
    <SettingsRow
      {...searchableSetting("provider-updates")}
      serverScoped
      settingKeys={keys}
      description={t(
        "Check provider CLIs and model catalogs for updates. Install automatically checks at startup and hourly, and installs supported CLI updates.",
      )}
      control={
        <div className="w-full sm:w-72">
          <Select
            value={mixed ? null : choice}
            onValueChange={(value) => {
              if (isProviderUpdatesChoice(value)) update(providerUpdatesPatch(value));
            }}
          >
            <SelectTrigger size="sm" aria-label={t("Provider updates")}>
              <SelectValue>{mixed ? t("Mixed") : t(updateLabels[choice])}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {choice === "custom" ? (
                <SelectItem value="custom" disabled>
                  {t(updateLabels.custom)}
                </SelectItem>
              ) : null}
              {ProviderUpdatesChoice.literals.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(updateLabels[value])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}

export function InstallUpdatesAutomaticallySetting() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("install-updates-automatically")}
      serverScoped
      settingKeys={["installUpdatesAutomatically"]}
      description={t("Installs a new CodeShip release when no chat is working.")}
      control={
        <ScopedSwitch
          settingKeys={["installUpdatesAutomatically"]}
          checked={settings.installUpdatesAutomatically}
          onCheckedChange={(checked) => update({ installUpdatesAutomatically: Boolean(checked) })}
          aria-label={t("Install updates automatically when idle")}
        />
      }
    />
  );
}

const automaticUpdateIntervalLabel = (hours: number) =>
  hours === 0 ? t("No wait") : t("{hours} h", { hours });

export function AutomaticUpdateIntervalSetting() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const hours = settings.minHoursBetweenAutomaticUpdates;
  return (
    <SettingsRow
      {...searchableSetting("min-hours-between-automatic-updates")}
      serverScoped
      settingKeys={["minHoursBetweenAutomaticUpdates"]}
      description={t(
        "After a restart, automatic updates wait this long before installing the next release, so a busy machine restarts less often.",
      )}
      control={
        <div className="w-full sm:w-40">
          <Select
            value={String(hours)}
            onValueChange={(value) => {
              const next = Number(value);
              if (isAutomaticUpdateIntervalHours(next)) {
                update({ minHoursBetweenAutomaticUpdates: next });
              }
            }}
          >
            <SelectTrigger size="sm" aria-label={t("Time between automatic updates")}>
              <SelectValue>{automaticUpdateIntervalLabel(hours)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {AUTOMATIC_UPDATE_INTERVAL_HOURS.map((value) => (
                <SelectItem key={value} value={String(value)}>
                  {automaticUpdateIntervalLabel(value)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}

function WaitHoursInput({ value, onCommit }: { value: number; onCommit: (hours: number) => void }) {
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
      min={0}
      max={MAX_PLAN_RESET_WAIT_HOURS}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        const parsed = Number(event.target.value);
        if (
          event.target.value.trim() !== "" &&
          Number.isInteger(parsed) &&
          parsed >= 0 &&
          parsed <= MAX_PLAN_RESET_WAIT_HOURS
        ) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label={t("Hours to wait for a plan reset")}
    />
  );
}

export function UsageResetRedeemerSettings() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const { connectedEnvironments } = useSettingsScope();
  // Servers without the redeemer would drop these settings.
  const supported =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.usageResetRedeemer === true,
    );
  if (!supported) return null;
  return (
    <>
      <SettingsRow
        {...searchableSetting("redeem-usage-resets")}
        serverScoped
        settingKeys={["redeemUsageResets"]}
        description={t(
          "When a Claude or Codex account's limit is out, claim one of its banked resets, but only if the plan reset is further away than the wait below or the reset would otherwise expire unused.",
        )}
        control={
          <ScopedSwitch
            settingKeys={["redeemUsageResets"]}
            checked={settings.redeemUsageResets}
            onCheckedChange={(checked) => update({ redeemUsageResets: checked })}
            aria-label={t("Redeem usage resets automatically")}
          />
        }
      />
      {settings.redeemUsageResets ? (
        <SettingsRow
          title={t("Wait at most {hours} hours for a plan reset", {
            hours: settings.maxPlanResetWaitHours,
          })}
          serverScoped
          settingKeys={["maxPlanResetWaitHours"]}
          description={t(
            "A limit whose plan reset is this close is waited out and keeps its banked reset.",
          )}
          control={
            <WaitHoursInput
              value={settings.maxPlanResetWaitHours}
              onCommit={(hours) => update({ maxPlanResetWaitHours: hours })}
            />
          }
        />
      ) : null}
    </>
  );
}
