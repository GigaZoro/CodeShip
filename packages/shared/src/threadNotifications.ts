import type { ThreadNotificationLevel } from "@t3tools/contracts/threadPreferences";

export function shouldNotifyThread(
  globalEnabled: boolean,
  level: ThreadNotificationLevel | undefined,
  kind: "completion" | "input" | "other",
): boolean {
  if (level === "muted") return false;
  return globalEnabled || (level === "following" && kind !== "other");
}
