import type { EnvironmentId, ThreadId } from "@t3tools/contracts/baseSchemas";
import {
  isListedThreadLineage,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts/orchestrationV2";
import type { Project } from "@t3tools/contracts/project";
import type { ThreadNotificationLevel } from "@t3tools/contracts/threadPreferences";
import * as DateTime from "effect/DateTime";

import { backgroundWorkHoldsCompletion } from "./orchestrationV2PendingBackgroundWork.ts";

export type AgentAwarenessPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export interface AgentAwarenessState {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly phase: AgentAwarenessPhase;
  readonly notificationLevel?: ThreadNotificationLevel;
  readonly headline: string;
  readonly detail?: string;
  readonly modelTitle: string;
  readonly updatedAt: string;
  /** When the current alertable occurrence began; shell edits such as a rename keep it. */
  readonly occurredAt?: string;
  readonly deepLink: string;
}

function buildAgentAwarenessDeepLink(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): string {
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

export interface ProjectThreadAwarenessV2Input {
  readonly environmentId: EnvironmentId;
  /** Epoch milliseconds, to tell whether a snooze is still running. */
  readonly nowMs: number;
  readonly project: Pick<Project, "title">;
  readonly thread: Pick<
    OrchestrationV2ThreadShell,
    | "activityRunStatus"
    | "id"
    | "lineage"
    | "latestRunCompletedAt"
    | "latestRunStopRequested"
    | "notificationLevel"
    | "modelSelection"
    | "pendingBackgroundTasks"
    | "pendingRuntimeRequest"
    | "settledOverride"
    | "snoozedUntil"
    | "status"
    | "title"
    | "updatedAt"
  >;
}

export function projectThreadAwarenessV2(
  input: ProjectThreadAwarenessV2Input,
): AgentAwarenessState | null {
  const { environmentId, project, thread } = input;
  if (!isListedThreadLineage(thread.lineage)) return null;
  const phase = resolveThreadAwarenessPhaseV2(thread);
  if (phase === null) {
    return null;
  }
  if (phase === "completed" && thread.latestRunStopRequested === true) return null;
  // A snoozed thread's completion stays quiet, as on web; a request or failure still wakes it.
  if (
    phase === "completed" &&
    thread.notificationLevel !== "following" &&
    thread.snoozedUntil != null &&
    DateTime.toEpochMillis(thread.snoozedUntil) > input.nowMs
  ) {
    return null;
  }
  // Resolve the phase first so live or waiting work stays visible after settlement.
  if (
    thread.settledOverride === "settled" &&
    (phase === "completed" || phase === "failed") &&
    !backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
  ) {
    return null;
  }
  const occurredAt = occurredAtForPhase(thread, phase);
  const detail =
    phase === "completed"
      ? "Review the completed task."
      : phase === "failed"
        ? "The agent run failed."
        : undefined;
  return {
    environmentId,
    threadId: thread.id,
    projectTitle: project.title,
    threadTitle: thread.title,
    phase,
    ...(thread.notificationLevel === undefined || thread.notificationLevel === "default"
      ? {}
      : { notificationLevel: thread.notificationLevel }),
    headline: headlineForPhase(phase),
    ...(detail === undefined ? {} : { detail }),
    modelTitle: thread.modelSelection.model,
    updatedAt: DateTime.formatIso(thread.updatedAt),
    ...(occurredAt === null ? {} : { occurredAt: DateTime.formatIso(occurredAt) }),
    deepLink: buildAgentAwarenessDeepLink({ environmentId, threadId: thread.id }),
  };
}

function occurredAtForPhase(
  thread: ProjectThreadAwarenessV2Input["thread"],
  phase: AgentAwarenessPhase,
): DateTime.Utc | null {
  switch (phase) {
    case "waiting_for_input":
    case "waiting_for_approval":
      return thread.pendingRuntimeRequest?.createdAt ?? null;
    case "completed":
    case "failed":
      return thread.latestRunCompletedAt ?? null;
    case "starting":
    case "running":
    case "stale":
      return null;
  }
}

function resolveThreadAwarenessPhaseV2(
  thread: ProjectThreadAwarenessV2Input["thread"],
): AgentAwarenessPhase | null {
  if (thread.pendingRuntimeRequest?.kind === "user_input") return "waiting_for_input";
  if (
    thread.pendingRuntimeRequest !== null &&
    thread.pendingRuntimeRequest.kind !== "auth_refresh"
  ) {
    return "waiting_for_approval";
  }
  switch (thread.activityRunStatus ?? thread.status) {
    case "preparing":
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "completed":
      return backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
        ? "running"
        : "completed";
    case "failed":
      return "failed";
    case "idle":
    case "queued":
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return null;
  }
}

function headlineForPhase(phase: AgentAwarenessPhase): string {
  switch (phase) {
    case "starting":
      return "Starting agent";
    case "running":
      return "Agent is working";
    case "waiting_for_approval":
      return "Approval needed";
    case "waiting_for_input":
      return "Waiting for input";
    case "completed":
      return "Agent finished";
    case "failed":
      return "Agent failed";
    case "stale":
      return "Update delayed";
  }
}
