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
import {
  getDocumentActivity,
  subscribeDocumentActivity,
  subscribeDocumentReturn,
} from "../lib/documentActivity";

const minuteClock = usageClock();
const subscribeIdle = () => () => {};
const readVisible = () => getDocumentActivity().visible;
const accountWorkspacesAtom = usageLimitAccountWorkspacesAtom(
  environmentPresentations.presentationsWithProvidersAtom,
);

export function useUsageLimitWorkspaces() {
  return useAtomValue(accountWorkspacesAtom);
}

export function useUsageDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeDocumentActivity, readVisible, () => true);
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
  includeMinutes = true,
): number {
  const clocks = useAtomValue(usageLimitClockAtom(presentations));
  const visible = useUsageDocumentVisible();
  const clock = includeMinutes && visible ? clocks.countdown : clocks.resets;
  const subscribe = (listener: () => void) => {
    const unsubscribe = clock.subscribe(listener);
    const unsubscribeResume = subscribeDocumentReturn(clock.refresh);
    return () => {
      unsubscribeResume();
      unsubscribe();
    };
  };
  return useSyncExternalStore(subscribe, clock.getSnapshot, clock.getSnapshot);
}
