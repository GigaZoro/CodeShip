import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  isOrchestrationV2TerminalRunStatus,
  type OrchestrationV2Run,
  type RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** How the work a prompt started ended; null when it ended normally. */
export type ThreadPromptOutcome = "running" | "stopped" | "failed";

export interface ThreadPromptTiming {
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly outcome: ThreadPromptOutcome | null;
}

// The server sends an answer to the agent's question as a message with this id. It carries on
// the prompt that led to the question, so it does not start a span of its own.
const ANSWER_MESSAGE_ID_PREFIX = "async-answer:";

const STEER_INTENTS: ReadonlySet<string> = new Set(["steer", "promoted_queued_to_steer"]);

function runOutcome(status: OrchestrationV2Run["status"]): ThreadPromptOutcome | null {
  if (!isOrchestrationV2TerminalRunStatus(status)) return "running";
  if (status === "failed") return "failed";
  if (status === "interrupted" || status === "cancelled") return "stopped";
  return null;
}

/**
 * Each prompt's working time, keyed by message id, from the run records. A run's own prompt starts
 * when the run started and a steer when it reached the run; each ends when the next steer of its run
 * arrives or the run ends. A prompt with no run record, a queued run or an undone run has none.
 */
export function deriveThreadPromptTimings(
  projection: Pick<ThreadStructure, "runs" | "turnItems">,
): ReadonlyMap<string, ThreadPromptTiming> {
  const runs = new Map(projection.runs.map((run) => [run.id, run]));
  const promptsByRun = new Map<
    RunId,
    Array<{ readonly messageId: string; readonly startMs: number }>
  >();
  for (const item of projection.turnItems) {
    if (
      item.type !== "user_message" ||
      item.runId === null ||
      item.messageId.startsWith(ANSWER_MESSAGE_ID_PREFIX)
    ) {
      continue;
    }
    const run = runs.get(item.runId);
    if (run === undefined || run.startedAt === null || run.status === "rolled_back") continue;
    const runStartMs = DateTime.toEpochMillis(run.startedAt);
    let startMs: number;
    if (item.messageId === run.userMessageId) {
      startMs = runStartMs;
    } else if (STEER_INTENTS.has(item.inputIntent)) {
      // A steer queued before the run began reaches it no earlier than its start.
      startMs = Math.max(runStartMs, DateTime.toEpochMillis(item.startedAt ?? item.updatedAt));
    } else {
      continue;
    }
    const prompts = promptsByRun.get(run.id) ?? [];
    prompts.push({ messageId: item.messageId, startMs });
    promptsByRun.set(run.id, prompts);
  }

  const timings = new Map<string, ThreadPromptTiming>();
  for (const [runId, prompts] of promptsByRun) {
    const run = runs.get(runId)!;
    prompts.sort((left, right) => left.startMs - right.startMs);
    prompts.forEach((prompt, index) => {
      const next = prompts[index + 1];
      const endMs =
        next?.startMs ??
        (run.completedAt === null ? null : DateTime.toEpochMillis(run.completedAt));
      const outcome = next === undefined ? runOutcome(run.status) : null;
      // A settled run must have an end at or after the start; without one its length is unknown.
      if (outcome !== "running" && (endMs === null || endMs < prompt.startMs)) return;
      timings.set(prompt.messageId, {
        startedAt: new Date(prompt.startMs).toISOString(),
        completedAt: outcome === "running" || endMs === null ? null : new Date(endMs).toISOString(),
        outcome,
      });
    });
  }
  return timings;
}
