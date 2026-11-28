import { useAtomValue } from "@effect/atom-react";
import { machineAvailability, type MachineAvailability } from "@t3tools/client-runtime/connection";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import {
  groupThreadIncidents,
  isProviderDown,
  providerInstanceKey,
  sameThreadIncidents,
  threadIncidentOf,
  type ThreadIncident,
  type ThreadIncidents,
} from "@t3tools/client-runtime/state/thread-incidents";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { environmentPresentations, environmentSummaries } from "./presentation";
import { environmentThreadShells } from "./threads";

export const machineByEnvironmentAtom = Atom.make((get) => {
  const next = new Map<EnvironmentId, MachineAvailability>();
  for (const environment of get(environmentSummaries.environmentsAtom)) {
    next.set(environment.environmentId, machineAvailability(environment.connectionState));
  }
  // Summaries change on every last-seen tick; only availability feeds the grouping.
  const previous = Option.getOrNull(get.self<ReadonlyMap<EnvironmentId, MachineAvailability>>());
  return previous !== null &&
    previous.size === next.size &&
    [...next].every(([id, availability]) => previous.get(id) === availability)
    ? previous
    : next;
}).pipe(Atom.withLabel("thread-incidents:machines"));

// Provider statuses are pushed every few minutes; only which ones are down feeds the grouping.
export const downProvidersAtom = Atom.make((get) => {
  const next = new Set<string>();
  for (const [environmentId, providers] of get(
    environmentPresentations.providersByEnvironmentAtom,
  )) {
    for (const provider of providers) {
      if (isProviderDown(provider))
        next.add(providerInstanceKey(environmentId, provider.instanceId));
    }
  }
  const previous = Option.getOrNull(get.self<ReadonlySet<string>>());
  return previous !== null &&
    previous.size === next.size &&
    [...next].every((key) => previous.has(key))
    ? previous
    : next;
}).pipe(Atom.withLabel("thread-incidents:down-providers"));

/** Threads that wait on one shared cause, grouped; see `groupThreadIncidents`. */
export const threadIncidentsAtom = Atom.make((get): ThreadIncidents => {
  const next = groupThreadIncidents(get(environmentThreadShells.listedThreadShellsAtom), {
    machineByEnvironment: get(machineByEnvironmentAtom),
    downProviders: get(downProvidersAtom),
  });
  const previous = Option.getOrNull(get.self<ThreadIncidents>());
  return previous !== null && sameThreadIncidents(previous, next) ? previous : next;
}).pipe(Atom.withLabel("thread-incidents"));

export function useThreadIncidents(): ThreadIncidents {
  return useAtomValue(threadIncidentsAtom);
}

export function useThreadIncident(ref: ScopedThreadRef | null): ThreadIncident | null {
  const incidents = useThreadIncidents();
  return ref === null ? null : threadIncidentOf(incidents, ref);
}

// One atom per row, so a cause changing elsewhere re-renders only the rows it names.
const threadMachineNamedByIncidentAtom = Atom.family((key: string) =>
  Atom.make(
    (get) => get(threadIncidentsAtom).byThreadKey.get(key)?.cause.kind === "machine-offline",
  ).pipe(Atom.withLabel("thread-incidents:machine-named")),
);

/** Whether an incident row already names this thread's offline machine. */
export function useThreadMachineNamedByIncident(ref: ScopedThreadRef): boolean {
  return useAtomValue(threadMachineNamedByIncidentAtom(threadKey(ref)));
}
