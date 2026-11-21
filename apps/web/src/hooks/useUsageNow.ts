import { useAtomValue } from "@effect/atom-react";
import { usageClock } from "@t3tools/client-runtime/clock";
import { usageLimitClockAtom } from "@t3tools/client-runtime/state/usage-progress";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import type { Atom } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { environmentPresentations } from "../state/presentation";

const minuteClock = usageClock();

export function useUsageNow(): number {
  return useSyncExternalStore(
    minuteClock.subscribe,
    minuteClock.getSnapshot,
    minuteClock.getSnapshot,
  );
}

export function useUsageLimitNow(
  presentations: Atom.Atom<LimitPresentations> = environmentPresentations.presentationsWithProvidersAtom,
): number {
  const clock = useAtomValue(usageLimitClockAtom(presentations));
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}
