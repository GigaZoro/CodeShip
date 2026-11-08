import type { OrchestrationV2RestartHoldWork } from "@t3tools/contracts";

import { t, tn } from "~/i18n";

/** "Waiting for 3 tasks"; without a count yet, the general wording. */
export function waitingOnWorkLabel(count: number): string {
  return count > 0
    ? tn(count, "Waiting for {count} task", "Waiting for {count} tasks")
    : t("Waiting for background work…");
}

/** One line per entry, for a tooltip. */
export function restartHoldWorkLines(work: ReadonlyArray<OrchestrationV2RestartHoldWork>): string {
  return work.map((entry) => `${entry.label} · ${entry.threadTitle}`).join("\n");
}

/** The waiting label, then one line per entry. */
export function restartHoldTooltip(work: ReadonlyArray<OrchestrationV2RestartHoldWork>): string {
  return [waitingOnWorkLabel(work.length), restartHoldWorkLines(work)]
    .filter((line) => line !== "")
    .join("\n");
}
