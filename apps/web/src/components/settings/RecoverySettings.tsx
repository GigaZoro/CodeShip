import * as Schema from "effect/Schema";
import {
  ProviderUpdatesChoice,
  UsageLimitRecoveryChoice,
  providerUpdatesChoice,
  providerUpdatesPatch,
  usageLimitRecoveryChoice,
  usageLimitRecoveryPatch,
} from "@t3tools/contracts/settings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { msg, t } from "~/i18n";

const isUsageLimitRecoveryChoice = Schema.is(UsageLimitRecoveryChoice);
const isProviderUpdatesChoice = Schema.is(ProviderUpdatesChoice);

const recoveryLabels = {
  off: msg("Do nothing"),
  snooze: msg("Snooze until the limit resets"),
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
  const keys = [
    "snoozeLimitedThreads",
    "autoResumeLimitedThreads",
    "failoverLimitedThreads",
  ] as const;
  const mixed = useScopedSettingsMixed(keys);
  const choice = usageLimitRecoveryChoice(settings);
  return (
    <SettingsRow
      {...searchableSetting("usage-limit-recovery")}
      serverScoped
      settingKeys={keys}
      description={t(
        "Choose how stopped threads recover. Switching uses another signed-in subscription account of the same provider, never API-key or Bedrock accounts. Some providers' terms forbid using extra accounts to get around limits. Custom keeps your existing snooze, resume, and account-switching preferences until you choose an option.",
      )}
      status={
        choice === "custom"
          ? t("Snooze: {snooze}; resume: {resume}; switch accounts: {switching}.", {
              snooze: settings.snoozeLimitedThreads ? t("On") : t("Off"),
              resume: settings.autoResumeLimitedThreads ? t("On") : t("Off"),
              switching: settings.failoverLimitedThreads ? t("On") : t("Off"),
            })
          : undefined
      }
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
        "Check provider CLIs and model catalogs for updates. Install automatically also enables checks and updates provider CLIs when the server starts.",
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
