import { useAuth } from "@clerk/react";
import { managedCapabilityDenial } from "@t3tools/shared/managedPolicyMessages";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { firstManagedDenial, usePrimaryManagedPolicy } from "~/state/managedPolicy";
import { t, tx } from "~/i18n";

/** Opt-in features that used to live in Labs, now shown on the page they belong to. */
export function GuestLinksSetting() {
  // Clerk is only mounted when this build has T3 Connect.
  return hasCloudPublicConfig() ? <GuestLinksRowWithSignIn /> : <GuestLinksRow />;
}

export function BoringSidebarMultilineRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("boring-sidebar-multiline")}
      description={t(
        "When the sidebar groups threads into folders, show them on two lines: the title, then the branch, pull request, and agent.",
      )}
      control={
        <Switch
          checked={settings.boringSidebarMultilineRows}
          onCheckedChange={(checked) =>
            updateSettings({ boringSidebarMultilineRows: Boolean(checked) })
          }
          aria-label={t("Two-line folder rows")}
        />
      }
    />
  );
}

/** Signed out of T3 Connect, the row offers to sign in instead of its switch. */
function GuestLinksRowWithSignIn() {
  const { isSignedIn } = useAuth();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  // `isSignedIn` is undefined until Clerk loads.
  if (isSignedIn !== false) return <GuestLinksRow />;
  return (
    <SettingsRow
      {...searchableSetting("guest-links")}
      description={t(
        "Let a guest watch a shared thread live and send messages you approve. Sign in to T3 Connect to use it.",
      )}
      control={
        <Button size="sm" variant="outline" onClick={openAuthPrompt}>
          {t("Sign in")}
        </Button>
      }
    />
  );
}

function GuestLinksRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const scope = useOptionalSettingsScope();
  const primaryPolicy = usePrimaryManagedPolicy();
  // Guests arrive through T3 Connect, so a policy that turns Connect off turns this off too.
  const connectDenial = firstManagedDenial(
    scope
      ? scope.connectedEnvironments.map((environment) => environment.serverConfig?.managedPolicy)
      : [primaryPolicy],
    (policy) => managedCapabilityDenial(policy, "connect"),
  );
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("guest-links")}
      settingKeys={["guestSharingEnabled"]}
      // Turning guest links off still works without T3 Connect.
      managed={settings.guestSharingEnabled ? undefined : connectDenial}
      description={t(
        "Let a guest watch a shared thread live and send messages you approve; turning it off ends every guest link.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["guestSharingEnabled"]}
          checked={settings.guestSharingEnabled}
          onCheckedChange={(checked) => updateSettings({ guestSharingEnabled: Boolean(checked) })}
          aria-label={t("Guest links")}
        />
      }
    />
  );
}

export function LinkedEnvironmentsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("linked-environments-beta")}
      settingKeys={["linkedEnvironmentsEnabled"]}
      description={t("Let agents here work on your other machines, and theirs here.")}
      control={
        <ScopedSwitch
          settingKeys={["linkedEnvironmentsEnabled"]}
          checked={settings.linkedEnvironmentsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ linkedEnvironmentsEnabled: Boolean(checked) })
          }
          aria-label={t("Linked environments")}
        />
      }
    />
  );
}

/** Shown only where every machine in scope can follow shared settings. */
export function FollowSharedSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { connectedEnvironments } = useSettingsScope();
  if (
    connectedEnvironments.length === 0 ||
    !connectedEnvironments.every(
      (environment) => environment.serverConfig?.environment.capabilities.sharedSettings === true,
    )
  ) {
    return null;
  }
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("follow-shared-settings")}
      settingKeys={["followSharedSettings"]}
      description={t(
        "Settings you save for all machines also reach this machine, even if it was off at the time.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["followSharedSettings"]}
          checked={settings.followSharedSettings}
          onCheckedChange={(checked) => updateSettings({ followSharedSettings: Boolean(checked) })}
          aria-label={t("Follow shared settings")}
        />
      }
    />
  );
}

export function SimlockHostsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("simlock-hosts")}
      settingKeys={["simlockDeviceHostsEnabled"]}
      description={tx(
        "Let the Device panel lease simulators and emulators from your own {simlock} pool, added under Device sources. An alpha that may change or break. T3.CodeShip never installs Simlock.",
        {
          simlock: (
            <a
              href="https://incubator.callstack.com/simlock/"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              {"Simlock"}
            </a>
          ),
        },
      )}
      control={
        <ScopedSwitch
          settingKeys={["simlockDeviceHostsEnabled"]}
          checked={settings.simlockDeviceHostsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ simlockDeviceHostsEnabled: Boolean(checked) })
          }
          aria-label={t("Simlock device hosts")}
        />
      }
    />
  );
}
