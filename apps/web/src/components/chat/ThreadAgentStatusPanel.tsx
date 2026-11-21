import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadActivityRun } from "@t3tools/client-runtime/state/thread-execution";
import { isCompleteTurnItemRow } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import { usePrimarySettings } from "../../hooks/useSettings";
import { tickTextContent } from "~/lib/tickTextContent";
import { cn } from "../../lib/utils";
import { projectedWorkEntry } from "../../session-logic";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { formatRelativeTimeLabel, formatUpcomingTimestamp } from "../../timestampFormat";
import { liveWorkEntryLabel } from "./MessagesTimeline.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { deriveThreadAgentStatus, type ThreadAgentStatusKind } from "./threadAgentStatus.logic";
import { msg, t } from "~/i18n";

const STATUS_PRESENTATION: Record<
  ThreadAgentStatusKind,
  { readonly label: ReturnType<typeof msg>; readonly dotClassName: string }
> = {
  working: { label: msg("Working"), dotClassName: "bg-info-foreground" },
  waiting: { label: msg("Waiting for you"), dotClassName: "bg-warning-foreground" },
  queued: { label: msg("Queued"), dotClassName: "bg-muted-foreground/60" },
  starting: { label: msg("Starting"), dotClassName: "bg-info-foreground" },
  stopped: { label: msg("Stopped"), dotClassName: "bg-muted-foreground/60" },
  failed: { label: msg("Failed"), dotClassName: "bg-destructive-foreground" },
  usageLimit: { label: msg("Usage limit"), dotClassName: "bg-warning-foreground" },
  idle: { label: msg("Idle"), dotClassName: "bg-muted-foreground/60" },
};

const ACTIVITY_ITEM_TYPES: ReadonlySet<string> = new Set([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
]);

const IN_PROGRESS_ITEM_STATUSES: ReadonlySet<string> = new Set(["pending", "running", "waiting"]);

/** What the agent is doing, from the same work entries the timeline labels. */
export function ThreadAgentStatusPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | undefined;
  readonly modelLabel: string;
  readonly effortLabel: string | null;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const shell = useQuietThreadShell(threadRef);
  const structure = useQuietThreadProjection(threadRef);
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  if (shell === null) return null;

  const status = deriveThreadAgentStatus({
    runtimeStatus: shell.runtime?.status ?? null,
    needsUser: shell.hasPendingApprovals || shell.hasPendingUserInput,
    lastErrorClass: shell.runtime?.lastErrorClass ?? null,
    usageLimitResetAt: shell.runtime?.usageLimitResetAt ?? null,
    activityStartedAt: shell.runtime?.activityStartedAt ?? null,
    latestRun: shell.latestRun,
  });
  const { activeSince, finishedAt } = status;

  let activity: string | null = null;
  if (status.kind === "working" && structure !== null) {
    const runId = deriveThreadActivityRun(structure.projection)?.runId ?? null;
    const row = structure.projection.visibleTurnItems.findLast(
      (candidate) =>
        candidate.item.runId === runId &&
        ACTIVITY_ITEM_TYPES.has(candidate.item.type) &&
        IN_PROGRESS_ITEM_STATUSES.has(candidate.item.status) &&
        isCompleteTurnItemRow(candidate),
    );
    if (row !== undefined && isCompleteTurnItemRow(row)) {
      activity = liveWorkEntryLabel(projectedWorkEntry(row), props.workspaceRoot, true);
    }
  } else if (status.kind === "waiting") {
    activity = t("Approval or answer needed");
  }

  const label =
    status.kind === "usageLimit" && status.resetAt !== null
      ? t("Usage limit until {time}", {
          time: formatUpcomingTimestamp(status.resetAt, timestampFormat),
        })
      : t(STATUS_PRESENTATION[status.kind].label);
  const modelText =
    props.effortLabel === null ? props.modelLabel : `${props.modelLabel} ${props.effortLabel}`;
  const tookText = status.tookMs === null ? null : formatDuration(status.tookMs);

  return (
    <ThreadDetailsSection
      headingId="thread-details-status-heading"
      title={t("Agent status")}
      showHeading={false}
    >
      <div className="flex flex-col gap-0.5 px-2.5 py-1 text-sm">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              STATUS_PRESENTATION[status.kind].dotClassName,
            )}
          />
          <span className="min-w-0 truncate font-medium text-foreground">{label}</span>
          {activeSince === null ? null : (
            <span
              ref={tickTextContent((nowMs) => {
                const elapsed = nowMs - Date.parse(activeSince);
                return Number.isFinite(elapsed) ? formatDuration(Math.max(1_000, elapsed)) : "";
              }, true)}
              className="shrink-0 text-muted-foreground tabular-nums"
            />
          )}
          {modelText === "" ? null : (
            <span className="ms-auto min-w-0 truncate ps-2 text-xs text-muted-foreground">
              {modelText}
            </span>
          )}
        </div>
        {activity !== null ? (
          <p className="truncate ps-4 text-xs text-muted-foreground">{activity}</p>
        ) : finishedAt !== null ? (
          <p className="truncate ps-4 text-xs text-muted-foreground">
            {status.kind === "idle" ? t("Finished") : t("Ended")}{" "}
            <span
              ref={tickTextContent((nowMs) => formatRelativeTimeLabel(finishedAt, nowMs), true)}
            />
            {tookText === null ? null : ` · ${t("took {duration}", { duration: tookText })}`}
          </p>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}
