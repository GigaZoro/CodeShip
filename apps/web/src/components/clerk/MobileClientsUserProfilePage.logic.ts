import { getFormattingLocale, msg, t } from "~/i18n";
import type { RelayClientDeviceRecord } from "@t3tools/contracts/relay";

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

export function mobileClientNotificationDetail(
  device: RelayClientDeviceRecord,
  resolve: typeof t = t,
): string {
  if (!device.notifications.enabled) {
    return resolve(msg("Push notifications are disabled on this device."));
  }

  const enabledPreferences = NOTIFICATION_PREFERENCES.flatMap(([preference, label]) =>
    device.notifications[preference] ? [resolve(label)] : [],
  );
  return enabledPreferences.length > 0
    ? resolve(msg("Alerts enabled for {alerts}."), { alerts: enabledPreferences.join(", ") })
    : resolve(msg("Push notifications are enabled, but no alert types are selected."));
}

export function mobileClientUpdatedAtLabel(updatedAt: string, resolve: typeof t = t): string {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime())
    ? resolve(msg("Update time unavailable"))
    : resolve(msg("Updated {date}"), {
        date: date.toLocaleString(getFormattingLocale(), {
          dateStyle: "medium",
          timeStyle: "short",
        }),
      });
}
