import { useAtomValue } from "@effect/atom-react";
import { usageClock } from "@t3tools/client-runtime/clock";
import {
  usageLimitAccountWorkspacesAtom,
  usageLimitClockAtom,
} from "@t3tools/client-runtime/state/usage-progress";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import type { Atom } from "effect/reactivity";
import { useState, useSyncExternalStore } from "react";

import { environmentPresentations } from "../state/presentation";

const minuteClock = usageClock();
const subscribeIdle = () => () => {};
const accountWorkspacesAtom = usageLimitAccountWorkspacesAtom(
  environmentPresentations.presentationsWithProvidersAtom,
);

export function useUsageLimitWorkspaces() {
  return useAtomValue(accountWorkspacesAtom);
}

export function useUsageNow(active: boolean): number {
  const [last, setLast] = useState(minuteClock.getSnapshot);
  const read = active ? minuteClock.getSnapshot : () => last;
  const now = useSyncExternalStore(active ? minuteClock.subscribe : subscribeIdle, read, read);
  if (now !== last) setLast(now);
  return now;
}

export function useUsageLimitNow(
  presentations: Atom.Atom<LimitPresentations> = environmentPresentations.presentationsWithProvidersAtom,
): number {
  const clock = useAtomValue(usageLimitClockAtom(presentations));
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}
