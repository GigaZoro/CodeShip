import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type CurrentSubagentInput = Pick<
  RuntimeSubagent,
  "status" | "startedAt" | "completedAt" | "updatedAt" | "progress" | "result" | "error" | "model"
> &
  Pick<OrchestrationV2Subagent, "origin" | "providerInstanceId" | "modelSelection">;

type CurrentSubagentChildThread = Pick<
  OrchestrationV2ThreadShell,
  | "status"
  | "activityRunStatus"
  | "activityRunStartedAt"
  | "latestRunRequestedAt"
  | "latestRunStartedAt"
  | "latestRunCompletedAt"
  | "latestRunModelSelection"
  | "activityRunModelSelection"
>;

/**
 * The subagent as its child thread runs now: once the delegated work has ended, a run started in
 * the child itself replaces the delegation's status, times and, for an app-owned child, the model
 * that run was started with.
 */
export function currentSubagent<Agent extends CurrentSubagentInput>(
  agent: Agent | undefined,
  childThread: CurrentSubagentChildThread | null | undefined,
): Agent | undefined {
  if (!agent || !childThread || isOrchestrationV2WorkActive(agent.status)) return agent;
  const liveStatus =
    childThread.activityRunStatus ?? (childThread.status === "queued" ? "queued" : null);
  const newerRun =
    childThread.latestRunRequestedAt &&
    DateTime.toEpochMillis(childThread.latestRunRequestedAt) >
      Date.parse(agent.completedAt ?? agent.startedAt ?? agent.updatedAt);
  if (!liveStatus && !newerRun) return agent;
  const status = liveStatus ?? childThread.status;
  const startedAt = liveStatus ? childThread.activityRunStartedAt : childThread.latestRunStartedAt;
  const completedAt = liveStatus ? null : childThread.latestRunCompletedAt;
  // The thread's own selection is what its next run uses, and can change before that run starts.
  const runSelection = liveStatus
    ? childThread.activityRunModelSelection
    : childThread.latestRunModelSelection;
  return {
    ...agent,
    // A provider-native child runs inside its parent, so only an app-owned child picks its own model.
    ...(agent.origin === "app_owned" && runSelection
      ? {
          model: runSelection.model,
          providerInstanceId: runSelection.instanceId,
          modelSelection: runSelection,
        }
      : {}),
    status:
      status === "preparing" || status === "starting" || status === "queued"
        ? "pending"
        : status === "rolled_back"
          ? "interrupted"
          : status,
    startedAt: startedAt ? DateTime.formatIso(startedAt) : null,
    completedAt: completedAt ? DateTime.formatIso(completedAt) : null,
    progress: null,
    result: null,
    error: null,
  };
}
