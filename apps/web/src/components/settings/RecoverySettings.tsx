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
import { ScopedSwitch } from "./ScopedSwitch";
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

export function InstallUpdatesAutomaticallySetting() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("install-updates-automatically")}
      serverScoped
      settingKeys={["installUpdatesAutomatically"]}
      description={t(
        "Installs a new CodeShip release when no chat is working. Chats cut by the restart resume on their own.",
      )}
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
