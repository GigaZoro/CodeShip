import type {
  OrchestrationV2RestartHoldTurn,
  OrchestrationV2RestartHoldWork,
} from "@t3tools/contracts";

import { t, tn } from "~/i18n";

/**
 * "Waiting for 3 tasks"; for an automatic install waiting only on chats, "Waiting for 2 chats to
 * finish"; without a count yet, the general wording.
 */
export function waitingOnWorkLabel(count: number, runningTurns = 0): string {
  if (count > 0) return tn(count, "Waiting for {count} task", "Waiting for {count} tasks");
  return runningTurns > 0
    ? tn(runningTurns, "Waiting for {count} chat to finish", "Waiting for {count} chats to finish")
    : t("Waiting for background work…");
}

/** Background work, apart from the tool calls running turns wait on, which a hold ends differently. */
export function splitRestartHoldWork(work: ReadonlyArray<OrchestrationV2RestartHoldWork>) {
  return {
    background: work.filter((entry) => entry.turnCall !== true),
    turnCalls: work.filter((entry) => entry.turnCall === true),
  };
}

/** One line per entry, for a tooltip. */
export function restartHoldWorkLines(work: ReadonlyArray<OrchestrationV2RestartHoldWork>): string {
  return work.map((entry) => `${entry.label} · ${entry.threadTitle}`).join("\n");
}

/** The waiting label, then one line per entry and per chat still answering. */
export function restartHoldTooltip(
  work: ReadonlyArray<OrchestrationV2RestartHoldWork>,
  runningTurns: ReadonlyArray<OrchestrationV2RestartHoldTurn> = [],
): string {
  return [
    waitingOnWorkLabel(work.length, runningTurns.length),
    restartHoldWorkLines(work),
    ...runningTurns.map((turn) => turn.threadTitle),
  ]
    .filter((line) => line !== "")
    .join("\n");
}
