import {
  presentPendingBackgroundWork,
  type ProviderSubagentStatus,
} from "@t3tools/client-runtime/state/thread-execution";
import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import { backgroundTaskHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

export type ThreadAgentStatusKind =
  | "working"
  | "waiting"
  | "waitingOnWork"
  | "queued"
  | "starting"
  | "stopped"
  | "reverted"
  | "failed"
  | "usageLimit"
  | "idle";

export interface ThreadAgentStatusInput {
  readonly runtimeStatus: OrchestrationV2RunStatus | "idle" | null;
  /** An approval or answer the thread, or a subagent of it, waits on. */
  readonly needsUser: boolean;
  /** Another thread or background work the agent waits on, which the thread list shows as Waiting. */
  readonly waitingOnWork: boolean;
  readonly lastErrorClass: string | null;
  readonly usageLimitResetAt: string | null;
  readonly activityStartedAt: string | null;
  readonly latestRun: {
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
  /** A provider-native subagent's own turn; such a thread never gets app runs. */
  readonly providerSubagent: ProviderSubagentStatus | null;
}

export interface ThreadAgentStatus {
  readonly kind: ThreadAgentStatusKind;
  /** Set while the run is active; the clock the card ticks. */
  readonly activeSince: string | null;
  readonly resetAt: string | null;
  /** Set when the run has ended and its bounds are known. */
  readonly finishedAt: string | null;
  readonly tookMs: number | null;
}

const ACTIVE_STATUSES: ReadonlySet<ThreadAgentStatusInput["runtimeStatus"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/** A native subagent's turn read as the run it stands in for. */
function providerSubagentRun(status: ProviderSubagentStatus) {
  return {
    runtimeStatus:
      status.status === "pending"
        ? ("running" as const)
        : status.status === "idle"
          ? ("completed" as const)
          : status.status,
    activityStartedAt: status.startedAt,
    latestRun: { startedAt: status.startedAt, completedAt: status.completedAt },
  };
}

export function deriveThreadAgentStatus(input: ThreadAgentStatusInput): ThreadAgentStatus {
  const { runtimeStatus, activityStartedAt, latestRun } =
    input.providerSubagent === null ? input : providerSubagentRun(input.providerSubagent);
  const pending = (kind: ThreadAgentStatusKind): ThreadAgentStatus => ({
    kind,
    activeSince: null,
    resetAt: null,
    finishedAt: null,
    tookMs: null,
  });
  const active = (kind: ThreadAgentStatusKind): ThreadAgentStatus => ({
    ...pending(kind),
    activeSince: activityStartedAt ?? latestRun?.startedAt ?? null,
  });
  const ended = (kind: ThreadAgentStatusKind): ThreadAgentStatus => {
    const completedAt = latestRun?.completedAt ?? null;
    const startedMs = Date.parse(latestRun?.startedAt ?? "");
    const completedMs = Date.parse(completedAt ?? "");
    return {
      ...pending(kind),
      resetAt: kind === "usageLimit" ? input.usageLimitResetAt : null,
      finishedAt: Number.isFinite(completedMs) ? completedAt : null,
      tookMs:
        Number.isFinite(startedMs) && Number.isFinite(completedMs) && completedMs >= startedMs
          ? completedMs - startedMs
          : null,
    };
  };

  // A request outranks the run's own state: a subagent's approval holds its parent even while the
  // parent's run is idle.
  if (input.needsUser) {
    return ACTIVE_STATUSES.has(runtimeStatus) ? active("waiting") : pending("waiting");
  }
  // Work the agent waits on holds the run open, or parks it at idle until that work ends.
  if (input.waitingOnWork) {
    return ACTIVE_STATUSES.has(runtimeStatus) ? active("waitingOnWork") : pending("waitingOnWork");
  }
  switch (runtimeStatus) {
    case "queued":
      return pending("queued");
    case "preparing":
    case "starting":
      return active("starting");
    case "running":
    case "waiting":
      return active("working");
    case "failed":
      return ended(input.lastErrorClass === "usage_limit" ? "usageLimit" : "failed");
    case "interrupted":
    case "cancelled":
      return ended("stopped");
    // The run's completion time is when it was undone, so neither its end nor its length is known.
    case "rolled_back":
      return pending("reverted");
    default:
      return ended("idle");
  }
}

/**
 * What a Waiting status waits on: one task by its name, since the status already says Waiting, or a
 * count of them. Work the run left running, such as a dev server, is not waited on.
 */
export function waitingOnWorkLabel(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
): string | null {
  const presentation = presentPendingBackgroundWork(
    tasks.filter((task) => backgroundTaskHoldsCompletion(task)),
  );
  if (presentation === null) return null;
  const [only] = presentation.items;
  return presentation.items.length === 1 && only !== undefined ? only.label : presentation.title;
}
