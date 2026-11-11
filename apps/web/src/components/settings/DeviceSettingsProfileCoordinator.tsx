import type { ClientSettings, DeviceSettingsProfile } from "@t3tools/contracts";
import {
  deviceSettingsProfileAvailability,
  planDeviceSettingsProfileSync,
} from "@t3tools/client-runtime/state/device-settings-profile";
import * as Equal from "effect/Equal";
import { useEffect, useEffectEvent, useRef } from "react";

import { t } from "~/i18n";
import {
  updateClientSettings,
  useClientSettings,
  useClientSettingsHydrated,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { toastManager } from "../ui/toast";

/**
 * Keeps this device's portable settings the same as the profile its primary server shares, for a
 * device that follows it: takes a changed profile, and sends the device's own changes, which the
 * server saves for all machines. The decision is `planDeviceSettingsProfileSync`.
 */
export function DeviceSettingsProfileCoordinator() {
  const hydrated = useClientSettingsHydrated();
  const local = useClientSettings();
  const primary = usePrimaryEnvironment();
  const updatePrimarySettings = useUpdatePrimarySettings();
  const availability = deviceSettingsProfileAvailability(primary);
  const profile = availability.status === "ready" ? availability.source.profile : null;
  // Set while a send is in flight, and to the profile it replaced once saved: the server reports
  // that profile until the saved one reaches it, and taking it would undo the change just sent.
  const sending = useRef<{ inFlight: boolean; replaced: DeviceSettingsProfile | null }>({
    inFlight: false,
    replaced: null,
  });

  const sync = useEffectEvent(
    (input: {
      readonly hydrated: boolean;
      readonly local: ClientSettings;
      readonly profile: DeviceSettingsProfile | null;
    }) => {
      const { hydrated, local, profile } = input;
      const state = sending.current;
      if (!hydrated || state.inFlight) return;
      if (profile !== null && state.replaced !== null && Equal.equals(profile, state.replaced)) {
        return;
      }
      state.replaced = null;
      const plan = planDeviceSettingsProfileSync({
        local,
        source: profile === null ? null : { profile },
      });
      if (plan.kind === "apply") {
        void updateClientSettings({ ...plan.values, deviceSettingsProfileBase: plan.base });
        if (plan.conflict) {
          toastManager.add({
            type: "info",
            title: t("Shared settings applied"),
            description: t(
              "Another device changed the shared appearance and layout while this one was offline, so its version replaced the changes made here.",
            ),
          });
        }
      } else if (plan.kind === "publish" && profile !== null) {
        state.inFlight = true;
        updatePrimarySettings(
          { deviceSettingsProfile: plan.profile },
          {
            onSaved: () => {
              state.inFlight = false;
              state.replaced = profile;
              void updateClientSettings({ deviceSettingsProfileBase: plan.base });
            },
            onFailed: () => {
              state.inFlight = false;
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
