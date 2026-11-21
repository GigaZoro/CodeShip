import { usageClock } from "@t3tools/client-runtime/clock";
import { limitResetTimes, type LimitAccount } from "@t3tools/shared/usageLimits";
import { useSyncExternalStore } from "react";

const minuteClock = usageClock();

export function useUsageNow(accounts?: readonly LimitAccount[]): number {
  const clock = accounts === undefined ? minuteClock : usageClock(limitResetTimes(accounts));
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}
