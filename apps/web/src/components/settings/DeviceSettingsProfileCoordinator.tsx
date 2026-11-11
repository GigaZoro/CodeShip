import type { DeviceSettingsProfile } from "@t3tools/contracts";
import {
  type DeviceSettingsProfileLocal,
  type DeviceSettingsProfileSyncPlan,
  deviceSettingsProfileAvailability,
  makeDeviceSettingsProfilePublishes,
  planDeviceSettingsProfileSync,
  selectDeviceSettingsProfileLocal,
} from "@t3tools/client-runtime/state/device-settings-profile";
import { useEffect, useEffectEvent } from "react";

import { t } from "~/i18n";
import {
  updateClientSettings,
  useClientSettings,
  useClientSettingsHydrated,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { toastManager } from "../ui/toast";

// One per app: the switch and the coordinator must agree on which publishes still count.
const publishes = makeDeviceSettingsProfilePublishes();

/** Turns the profile switch on or off, each time from a fresh start. */
export function setFollowDeviceSettingsProfile(follow: boolean): Promise<void> {
  publishes.restart();
  return updateClientSettings({
    followDeviceSettingsProfile: follow,
    deviceSettingsProfileBase: null,
  });
}

function applyProfile(plan: Extract<DeviceSettingsProfileSyncPlan, { kind: "apply" }>) {
  const saved = updateClientSettings({ ...plan.values, deviceSettingsProfileBase: plan.base });
  if (plan.conflict) {
    toastManager.add({
      type: "info",
      title: t("Shared settings applied"),
      description: t(
        "Another device saved newer shared appearance and layout settings before the changes made here were saved, so its version replaced them.",
      ),
    });
  }
  // Every module reads the language once at startup; reloading unasked would drop work in progress.
  if (Object.hasOwn(plan.values, "language")) {
    const id = toastManager.add({
      type: "info",
      title: t("Language changed on your other devices"),
      description: t("Reload to use it on this device too."),
      actionProps: {
        children: t("Reload"),
        onClick: () => {
          toastManager.close(id);
          void saved.then(() => window.location.reload());
        },
      },
    });
  }
}

/**
 * Keeps this device's portable settings the same as the profile its primary server shares, for a
 * device that follows it: takes a changed profile, and sends the device's own changes, which the
 * server saves for all machines. The decision is `planDeviceSettingsProfileSync`.
 */
export function DeviceSettingsProfileCoordinator() {
  const hydrated = useClientSettingsHydrated();
  const local = useClientSettings(selectDeviceSettingsProfileLocal);
  const primary = usePrimaryEnvironment();
  const updatePrimarySettings = useUpdatePrimarySettings();
  const availability = deviceSettingsProfileAvailability(primary);
  const profile = availability.status === "ready" ? availability.source.profile : null;

  // The primary already held a newer profile than the one sent: it wins, as one pulled later would.
  const takeNewer = useEffectEvent((newer: DeviceSettingsProfile) => {
    const plan = planDeviceSettingsProfileSync({ local, source: { profile: newer } });
    if (plan.kind === "apply") applyProfile(plan);
  });

  const sync = useEffectEvent(
    (input: {
      readonly hydrated: boolean;
      readonly local: DeviceSettingsProfileLocal;
      readonly profile: DeviceSettingsProfile | null;
    }) => {
      const { hydrated, local, profile } = input;
      if (!hydrated || !publishes.canPlan(profile)) return;
      const plan = planDeviceSettingsProfileSync({
        local,
        source: profile === null ? null : { profile },
      });
      if (plan.kind === "apply") {
        applyProfile(plan);
      } else if (plan.kind === "publish" && profile !== null) {
        const publish = publishes.begin(profile);
        updatePrimarySettings(
          { deviceSettingsProfile: plan.profile },
          {
            seed: plan.seed,
            onSaved: () => {
              if (publishes.settle(publish, true)) {
                void updateClientSettings({ deviceSettingsProfileBase: plan.base });
              }
            },
            onSuperseded: (settings) => {
              if (publishes.settle(publish, false)) takeNewer(settings.deviceSettingsProfile);
            },
            // Not saved everywhere: it stays unsent, and the next change or reconnect sends it.
            onFailed: () => {
              publishes.settle(publish, false);
            },
          },
        );
      }
    },
  );

  // Synchronizes this device with a server's value, which no render derives.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies and sends settings across the network
  useEffect(() => {
    sync({ hydrated, local, profile });
  }, [hydrated, local, profile]);

  return null;
}
