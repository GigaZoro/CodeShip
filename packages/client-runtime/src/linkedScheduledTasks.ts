import type { EnvironmentId, LinkedScheduledTaskMachine } from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";

import { SCRATCH_PROJECT_TITLE } from "./state/projects.ts";

/** A linked task's project as this client names it: No project in its own language. */
export const linkedProjectName = (title: string | null): string | null =>
  title === SCRATCH_PROJECT_TITLE ? t("No project") : title;

export interface LinkedMachineTasks {
  readonly machine: LinkedScheduledTaskMachine;
  /** The connected machine whose stored list this is. */
  readonly via: EnvironmentId;
}

const isFresher = (candidate: LinkedScheduledTaskMachine, current: LinkedScheduledTaskMachine) => {
  // ISO timestamps from one formatter order as strings; a machine never reached sorts first.
  const candidateSeen = candidate.seenAt ?? "";
  const currentSeen = current.seenAt ?? "";
  return candidateSeen === currentSeen
    ? candidate.checkedAt > current.checkedAt
    : candidateSeen > currentSeen;
};

/**
 * Each linked machine once, from whichever connected machine heard from it last, sorted by
 * name. Leaves out machines the client reads live, whose own list is current.
 */
export function pickLinkedMachineTasks(input: {
  readonly lists: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly machines: ReadonlyArray<LinkedScheduledTaskMachine>;
  }>;
  readonly readsLive: (environmentId: EnvironmentId) => boolean;
}): ReadonlyArray<LinkedMachineTasks> {
  const picked = new Map<EnvironmentId, LinkedMachineTasks>();
  for (const list of input.lists) {
    for (const machine of list.machines) {
      if (input.readsLive(machine.environmentId)) continue;
      const current = picked.get(machine.environmentId);
      if (current === undefined || isFresher(machine, current.machine)) {
        picked.set(machine.environmentId, { machine, via: list.environmentId });
      }
    }
  }
  return [...picked.values()].sort((left, right) =>
    left.machine.label.localeCompare(right.machine.label),
  );
}
