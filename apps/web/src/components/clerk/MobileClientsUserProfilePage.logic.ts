import type { RelayClientDeviceRecord } from "@t3tools/contracts/relay";

import { getFormattingLocale, msg, t } from "~/i18n";
const NOTIFICATION_PREFERENCES = [
  ["notifyOnApproval", msg("approvals")],
  ["notifyOnInput", msg("input requests")],
  ["notifyOnCompletion", msg("completions")],
  ["notifyOnFailure", msg("failures")],
] as const satisfies ReadonlyArray<
  readonly [keyof RelayClientDeviceRecord["notifications"], string]
>;

export function mobileClientPlatformLabel(device: RelayClientDeviceRecord): string {
  const platform =
    device.platform === "android"
      ? "Android"
      : device.iosMajorVersion === null
        ? "iOS"
        : `iOS ${device.iosMajorVersion}`;
  return `${platform}${device.appVersion ? ` · T3.CodeShip ${device.appVersion}` : ""}`;
}

export function mobileClientNotificationDetail(device: RelayClientDeviceRecord): string {
  if (!device.notifications.enabled) {
    return t("Push notifications are disabled on this device.");
  }

  const enabledPreferences = NOTIFICATION_PREFERENCES.flatMap(([preference, label]) =>
    device.notifications[preference] ? [t(label)] : [],
  );
  return enabledPreferences.length > 0
    ? t("Alerts enabled for {alerts}.", { alerts: enabledPreferences.join(", ") })
    : t("Push notifications are enabled, but no alert types are selected.");
}

export function mobileClientUpdatedAtLabel(updatedAt: string): string {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime())
    ? t("Update time unavailable")
    : t("Updated {time}", {
        time: new Intl.DateTimeFormat(getFormattingLocale(), {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(date),
      });
}
