import type { OrchestrationV2RunStatus, ThreadPullRequestLinkSource } from "@t3tools/contracts";
import { t, tn } from "@t3tools/shared/i18n";

import type { UnseenThreadWindow } from "./threadVisits.ts";

export interface UnseenThreadSummaryInput {
  readonly window: UnseenThreadWindow | null;
  /** Each timeline item's time and the run it belongs to; items outside the window are skipped. */
  readonly activity: Iterable<{ readonly time: number; readonly runId: string | null }>;
  readonly latestRun: {
    readonly status: OrchestrationV2RunStatus;
    readonly completedAt: string | null;
  } | null;
  readonly pullRequests: ReadonlyArray<{
    readonly number: number;
    readonly source: ThreadPullRequestLinkSource;
    readonly linkedAt: string;
  }>;
}

function inWindow(window: UnseenThreadWindow, time: number): boolean {
  return time > window.since && time <= window.through;
}

// Only an outcome that landed inside the window is news; a run still going says nothing.
function latestRunOutcome(
  window: UnseenThreadWindow,
  latestRun: UnseenThreadSummaryInput["latestRun"],
): string | null {
  if (latestRun?.completedAt == null || !inWindow(window, Date.parse(latestRun.completedAt))) {
    return null;
  }
  switch (latestRun.status) {
    case "completed":
      return t("finished");
    case "failed":
      return t("failed");
    case "interrupted":
    case "cancelled":
      return t("stopped");
    default:
      return null;
  }
}

function pullRequestNews(
  window: UnseenThreadWindow,
  pullRequests: UnseenThreadSummaryInput["pullRequests"],
): string | null {
  const linked = pullRequests.filter(
    (pr) => pr.source !== "stack-dismissed" && inWindow(window, Date.parse(pr.linkedAt)),
  );
  const opened = linked.every((pr) => pr.source === "created" || pr.source === "agent");
  const [only] = linked;
  if (only === undefined) return null;
  if (linked.length === 1) {
    return opened
      ? t("PR #{number} opened", { number: only.number })
      : t("PR #{number} linked", { number: only.number });
  }
  return opened
    ? tn(linked.length, "{count} PR opened", "{count} PRs opened")
    : tn(linked.length, "{count} PR linked", "{count} PRs linked");
}

/** "2 turns · finished · PR #88 opened": what changed while the reader was away. */
export function unseenThreadSummary(input: UnseenThreadSummaryInput): string | null {
  const { window } = input;
  if (window === null) return null;
  const runIds = new Set<string>();
  for (const item of input.activity) {
    if (item.runId !== null && inWindow(window, item.time)) runIds.add(item.runId);
  }
  const parts = [
    runIds.size > 0 ? tn(runIds.size, "{count} turn", "{count} turns") : null,
    latestRunOutcome(window, input.latestRun),
    pullRequestNews(window, input.pullRequests),
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}
