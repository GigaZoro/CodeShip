import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import { deriveThreadActivityRun } from "@t3tools/client-runtime/state/thread-execution";
import type { OrchestrationV2PlanStep } from "@t3tools/contracts";

export interface ThreadTaskList {
  readonly steps: ReadonlyArray<OrchestrationV2PlanStep>;
  readonly completed: number;
}

/**
 * The to-do list the agent keeps for the run it is on, as the server keeps it in full: the last
 * one not superseded. A queued follow-up does not hide it, and an earlier run's list would read
 * as current work, so none.
 */
export function resolveThreadTaskList(projection: ThreadStructure): ThreadTaskList | null {
  const runId = deriveThreadActivityRun(projection)?.runId ?? null;
  if (runId === null) return null;
  const plan = projection.plans.findLast(
    (candidate) =>
      candidate.kind === "todo_list" &&
      candidate.status !== "superseded" &&
      candidate.runId === runId,
  );
  if (plan?.kind !== "todo_list" || plan.steps.length === 0) return null;
  return {
    steps: plan.steps,
    completed: plan.steps.filter((step) => step.status === "completed").length,
  };
}
