import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";
import { secondTick, toServerClock } from "@t3tools/client-runtime/clock";
import type { EnvironmentId } from "@t3tools/contracts";
import { useIsFocused } from "@react-navigation/native";
import { useCallback, useSyncExternalStore } from "react";
import { usePaneRole } from "../../components/ui/Pane";
import { useAppActive } from "../../lib/appState";

const subscribeNever = () => () => undefined;

/**
 * The label shares the visibility gate of `useVisibleSecondClock`. `startedAt` is a server
 * timestamp, so pass its environment to measure it on that server's clock.
 */
export function useVisibleWorkingDurationLabel(
  startedAt: string | null,
  environmentId?: EnvironmentId,
): string | null {
  const startedAtMs = Date.parse(startedAt ?? "");
  const focused = useIsFocused();
  // The sidebar's route stays unfocused under the page beside it.
  const inSidebar = usePaneRole() === "sidebar";
  const appActive = useAppActive();
  const ticking = Number.isFinite(startedAtMs) && (focused || inSidebar) && appActive;
  const getSnapshot = useCallback(() => {
    if (!Number.isFinite(startedAtMs)) return null;
    const nowMs = secondTick.getSnapshot();
    const serverNowMs = environmentId === undefined ? nowMs : toServerClock(environmentId, nowMs);
    return ` ${formatWorkingDurationLabel(serverNowMs - startedAtMs)}`;
  }, [environmentId, startedAtMs]);
  return useSyncExternalStore(
    ticking ? secondTick.subscribe : subscribeNever,
    getSnapshot,
    getSnapshot,
  );
}
