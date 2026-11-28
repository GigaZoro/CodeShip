import { isOrchestrationV2WorkActive, type OrchestrationV2Subagent } from "@t3tools/contracts";

export function deriveSubagentElapsedMs(
  agent: {
    readonly status: OrchestrationV2Subagent["status"];
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  },
  nowMs: number,
): number | null {
  if (agent.startedAt === null) return null;
  const end = isOrchestrationV2WorkActive(agent.status)
    ? nowMs
    : agent.completedAt === null
      ? null
      : Date.parse(agent.completedAt);
  if (end === null) return null;
  const start = Date.parse(agent.startedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

export { formatDuration } from "./orchestrationTimingCopy.ts";

/**
 * How long a thread's work has gone without an event, once that reaches `limitMs`; otherwise null.
 * Every event moves a thread's `updatedAt`, streamed output and tool progress included, so it is
 * when the work last showed progress. The scheduler stops runs quiet past their providers' limits,
 * and clients mark working threads Stalled past the limit the user set.
 */
export function quietPastLimit(input: {
  readonly lastEventAt: number;
  readonly now: number;
  readonly limitMs: number;
}): number | null {
  const quietMs = input.now - input.lastEventAt;
  return quietMs >= input.limitMs ? quietMs : null;
}
