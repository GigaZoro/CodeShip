import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  deriveProviderSubagentStatus,
  deriveThreadActivityRun,
} from "@t3tools/client-runtime/state/thread-execution";
import {
  isThreadWaitingOnWork,
  resolveThreadStatus,
  type ThreadStatusInput,
} from "@t3tools/client-runtime/state/thread-status";
import {
  childThreadInputsTitle,
  isCompleteTurnItemRow,
} from "@t3tools/client-runtime/state/threads";
import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import { usePrimarySettings } from "../../hooks/useSettings";
import { tickTextContent } from "~/lib/tickTextContent";
import { cn } from "../../lib/utils";
import { projectedWorkEntry } from "../../session-logic";
import { useChildThreadInputs, useQuietThreadProjection } from "../../state/entities";
import { formatRelativeTimeLabel, formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import { liveWorkEntryLabel } from "./MessagesTimeline.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  deriveThreadAgentStatus,
  waitingOnWorkLabel,
  type ThreadAgentStatusKind,
} from "./threadAgentStatus.logic";
import { msg, t } from "~/i18n";

const STATUS_PRESENTATION: Record<
  ThreadAgentStatusKind,
  { readonly label: ReturnType<typeof msg>; readonly dotClassName: string }
> = {
  working: { label: msg("Working"), dotClassName: "bg-info-foreground" },
  waiting: { label: msg("Waiting for you"), dotClassName: "bg-warning-foreground" },
  waitingOnWork: { label: msg("Waiting"), dotClassName: "bg-muted-foreground/60" },
  queued: { label: msg("Queued"), dotClassName: "bg-muted-foreground/60" },
  starting: { label: msg("Starting"), dotClassName: "bg-info-foreground" },
  stopped: { label: msg("Stopped"), dotClassName: "bg-muted-foreground/60" },
  reverted: { label: msg("Reverted"), dotClassName: "bg-muted-foreground/60" },
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

type AgentStatusShell = ThreadStatusInput &
  Pick<EnvironmentThreadShell, "latestRun" | "pendingBackgroundTasks">;

/** What the agent is doing, from the same work entries the timeline labels. */
export function ThreadAgentStatusPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The thread as the chat shows it, including a thread not yet in the shell index. */
  readonly shell: AgentStatusShell | null;
  readonly workspaceRoot: string | undefined;
  readonly modelLabel: string;
  readonly effortLabel: string | null;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const structure = useQuietThreadProjection(threadRef);
  const childInputs = useChildThreadInputs(threadRef);
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const { shell } = props;
  if (shell === null) return null;

  const threadStatus = resolveThreadStatus(shell);
  const status = deriveThreadAgentStatus({
    runtimeStatus: shell.runtime?.status ?? null,
    needsUser: threadStatus === "approval" || threadStatus === "input",
    waitingOnWork: isThreadWaitingOnWork(shell),
    lastErrorClass: shell.runtime?.lastErrorClass ?? null,
    usageLimitResetAt: shell.runtime?.usageLimitResetAt ?? null,
    activityStartedAt: shell.runtime?.activityStartedAt ?? null,
    latestRun: shell.latestRun,
    providerSubagent:
      structure === null ? null : deriveProviderSubagentStatus(structure.projection),
  });
  const { activeSince, finishedAt } = status;

  let activity: { readonly text: string; readonly command: boolean } | null = null;
  const waitedOn =
    status.kind === "waitingOnWork" ? waitingOnWorkLabel(shell.pendingBackgroundTasks) : null;
  if (waitedOn !== null) {
    activity = { text: waitedOn, command: false };
  } else if ((status.kind === "working" || status.kind === "waitingOnWork") && structure !== null) {
    const runId = deriveThreadActivityRun(structure.projection)?.runId ?? null;
    const row = structure.projection.visibleTurnItems.findLast(
      (candidate) =>
        candidate.item.runId === runId &&
        ACTIVITY_ITEM_TYPES.has(candidate.item.type) &&
        IN_PROGRESS_ITEM_STATUSES.has(candidate.item.status) &&
        isCompleteTurnItemRow(candidate),
    );
    if (row !== undefined && isCompleteTurnItemRow(row)) {
      const entry = projectedWorkEntry(row);
      const command = entry.command?.trim();
      activity =
        entry.itemType === "command_execution" && command
          ? { text: commandDisplayText(command), command: true }
          : { text: liveWorkEntryLabel(entry, props.workspaceRoot, true), command: false };
    }
  } else if (status.kind === "waiting") {
    activity = {
      text: shell.hasPendingApprovals
        ? t("Approval needed")
        : shell.hasPendingUserInput
          ? t("Input needed")
          : childInputs.length > 0
            ? childThreadInputsTitle(childInputs)
            : shell.pendingSubagentRequest === "approval"
              ? t("Subagent needs approval")
              : t("Subagent needs input"),
      command: false,
    };
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
            <span className="shrink-0 text-muted-foreground">
              <AgentElapsed
                agent={{ status: "running", startedAt: activeSince, completedAt: null }}
              />
            </span>
          )}
          {modelText === "" ? null : (
            <span className="ms-auto min-w-0 truncate ps-2 text-xs text-muted-foreground">
              {modelText}
            </span>
          )}
        </div>
        {activity === null ? null : activity.command ? (
          <Tooltip>
            {/* The row fits a few words of the command; the tooltip shows all of it. */}
            <TooltipTrigger
              render={
                <p tabIndex={0} className="truncate ps-4 font-mono text-xs text-muted-foreground" />
              }
            >
              {activity.text}
            </TooltipTrigger>
            <TooltipPopup side="left" variant="code">
              {/* A script's line breaks and quoted spacing are part of the command. */}
              <span className="whitespace-pre-wrap">{activity.text}</span>
            </TooltipPopup>
          </Tooltip>
        ) : (
          <p className="truncate ps-4 text-xs text-muted-foreground">{activity.text}</p>
        )}
        {activity !== null ? null : finishedAt !== null ? (
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
