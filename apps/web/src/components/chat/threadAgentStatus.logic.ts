import type { OrchestrationV2RunStatus } from "@t3tools/contracts";

export type ThreadAgentStatusKind =
  | "working"
  | "waiting"
  | "queued"
  | "starting"
  | "stopped"
  | "failed"
  | "usageLimit"
  | "idle";

export interface ThreadAgentStatusInput {
  readonly runtimeStatus: OrchestrationV2RunStatus | "idle" | null;
  readonly needsUser: boolean;
  readonly lastErrorClass: string | null;
  readonly usageLimitResetAt: string | null;
  readonly activityStartedAt: string | null;
  readonly latestRun: {
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
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

export function deriveThreadAgentStatus(input: ThreadAgentStatusInput): ThreadAgentStatus {
  const { runtimeStatus } = input;
  const pending = (kind: ThreadAgentStatusKind): ThreadAgentStatus => ({
    kind,
    activeSince: null,
    resetAt: null,
    finishedAt: null,
    tookMs: null,
  });
  const active = (kind: ThreadAgentStatusKind): ThreadAgentStatus => ({
    ...pending(kind),
    activeSince: input.activityStartedAt ?? input.latestRun?.startedAt ?? null,
  });
  const ended = (kind: ThreadAgentStatusKind): ThreadAgentStatus => {
    const completedAt = input.latestRun?.completedAt ?? null;
    const startedMs = Date.parse(input.latestRun?.startedAt ?? "");
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

  switch (runtimeStatus) {
    case "queued":
      return pending("queued");
    case "preparing":
    case "starting":
      return active("starting");
    case "running":
    case "waiting":
      return active(input.needsUser ? "waiting" : "working");
    case "failed":
      return ended(input.lastErrorClass === "usage_limit" ? "usageLimit" : "failed");
    case "interrupted":
    case "cancelled":
      return ended("stopped");
    default:
      return ended("idle");
  }
}
