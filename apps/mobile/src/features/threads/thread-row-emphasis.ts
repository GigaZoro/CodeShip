import {
  machineAvailability,
  machineShowsLastKnownState,
  type EnvironmentConnectionPhase,
  type MachineAvailability,
} from "@t3tools/client-runtime/connection";
import type { ThreadStatus } from "@t3tools/client-runtime/state/thread-status";

// Statuses that change while the machine runs; an unreachable machine can only report the last one.
const LIVE_STATUSES: ReadonlySet<ThreadStatus> = new Set([
  "working",
  "waiting",
  "approval",
  "input",
  "request",
]);

export function machineAvailabilityOf(
  phase: EnvironmentConnectionPhase | undefined,
): MachineAvailability | undefined {
  return phase === undefined ? undefined : machineAvailability(phase);
}

/** The machine's state when the row's status is only what was last seen, otherwise null. */
export function threadRowLastKnownMachine(
  status: ThreadStatus,
  machine: MachineAvailability | undefined,
): MachineAvailability | null {
  return machine !== undefined && machineShowsLastKnownState(machine) && LIVE_STATUSES.has(status)
    ? machine
    : null;
}

export function shouldRecedeThreadRow(input: {
  readonly status: ThreadStatus;
  readonly selected: boolean;
  readonly machineUnreachable?: boolean;
}): boolean {
  return (
    !input.selected &&
    (input.machineUnreachable === true || input.status === "working" || input.status === "waiting")
  );
}
