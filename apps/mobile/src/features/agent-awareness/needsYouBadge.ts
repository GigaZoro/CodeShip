import { shouldNotifyThread } from "@t3tools/shared/threadNotifications";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells } from "../../state/threads";

/** Keeps the app icon badge at the number of threads that need the user, as the desktop dock does. */
export function installNeedsYouBadge(): () => void {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return () => undefined;
  let count = -1;
  return appAtomRegistry.subscribe(
    environmentThreadShells.needsYouThreadsAtom,
    (needsYou) => {
      const nextCount = needsYou.threads.filter((thread) =>
        shouldNotifyThread(true, thread.notificationLevel, "input"),
      ).length;
      if (nextCount === count) return;
      count = nextCount;
      // Without badge permission the OS ignores it; the list still shows the count.
      void Notifications.setBadgeCountAsync(count).catch((error: unknown) =>
        console.warn("Could not update the app icon badge", error),
      );
    },
    { immediate: true },
  );
}
