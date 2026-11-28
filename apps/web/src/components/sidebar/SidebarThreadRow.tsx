import { IssueGlyph, issueStatePresentation } from "../issue/issuePresentation";
import { ThreadDetailsIssueRows } from "../chat/ThreadDetailsIssueRows";
import { useThreadIntentPrefetch } from "./useThreadIntentPrefetch";
import { t, msg, tn } from "~/i18n";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadHoverCardTrigger } from "../ThreadHoverCard";
import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { asLaunchingThread } from "@t3tools/client-runtime/state/thread-inbox";
import { threadPreferenceLabels } from "@t3tools/client-runtime/thread-preferences";
import type { ThreadColor } from "@t3tools/contracts";
import { ThreadHoverCard } from "../ThreadHoverCard";
import { resolveThreadRowStatus, ThreadRowStatusContent } from "./threadRowStatus";
import { ThreadTerminalStatusButton } from "../ThreadStatusIndicators";
import {
  ThreadScheduledTaskIndicator,
  useThreadScheduledTasks,
} from "./ThreadScheduledTaskIndicator";
import { ScheduledTaskScheduleLine } from "../settings/ScheduledTasksSettings";
import { discardComposerDraft } from "../../lib/discardComposerDraft";
import { formatWorktreePathForDisplay } from "../../worktreeCleanup";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { useDeadlinePassed } from "~/hooks/useDeadline";
import { useThreadStall } from "~/hooks/useThreadStall";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import { useDraggable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  canSnooze,
  hasQueuedTurnStart,
  QUEUED_TURN_START_GRACE_MS,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  resolveSettledThreadTimestamp,
  resolveThreadActivityTimestamp,
} from "@t3tools/client-runtime/state/thread-sort";
import { type EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import {
  formatWorkingDurationLabel,
  resolveThreadProviderStack,
} from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { toServerClock } from "@t3tools/client-runtime/clock";
import {
  AuthOrchestrationOperateScope,
  type ContextMenuSource,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ScheduledTask,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  BellIcon,
  BellOffIcon,
  ArrowRightLeftIcon,
  CalendarClockIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  FolderGit2Icon,
  GitBranchIcon,
  PinIcon,
  PinOffIcon,
  SquarePenIcon,
  TagIcon,
  TerminalIcon,
  Undo2Icon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";
import {
  memo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { useUiStateStore } from "../../uiStateStore";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useNowSecond } from "../../hooks/useNowSecond";
import { vcsEnvironment, vcsBranchRevalidation } from "../../state/vcs";
import { useSidebarLinkedIssueState } from "../../state/issues";
import { useEnvironmentQuery } from "../../state/query";
import {
  readEnvironmentScope,
  useEnvironmentScope,
  useEnvironmentScopeDenied,
} from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useEnvironmentConnectionSummary, usePrimaryEnvironmentId } from "../../state/environments";
import {
  machineAvailability,
  machineAvailabilityLabel,
  machineShowsLastKnownState,
} from "@t3tools/client-runtime/connection";
import { formatRelativeElapsed, formatRelativeTime } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { MachineBadge, MachineLastSeen } from "../MachineBadge";
import {
  animateSidebarLayoutChanges,
  hasUnseenCompletion,
  hasUnseenWake,
  resolveSidebarRowAccessibility,
  type SidebarDropVerb,
  resolveSidebarRowStatus,
  resolveThreadLastVisitedAt,
  shouldRecedeSidebarThread,
  resolveWorkingStartedAt,
  useRetainedValue,
  withoutRemovedCheckout,
  useSidebarRowSubscriptionLease,
  setFileDragActive,
} from "../Sidebar.logic";
import { resolveLocalCheckoutBranchMismatch } from "../BranchToolbar.logic";
import {
  LINKED_ITEMS_PREVIEW_LIMIT,
  LinkedItemsOverflow,
  ThreadLinkBadge,
  ThreadPullRequestBadgeControl,
  ThreadPullRequestsMiniList,
  prStatusIndicator,
  resolveThreadPullRequestBadge,
  terminalStatusFromRunningIds,
  type PrStatusIndicator,
  type TerminalStatusIndicator,
  useLinkedThreadPullRequest,
  ThreadSearchPullRequestNumber,
} from "../ThreadStatusIndicators";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import {
  resolveSidebarRowMarkers,
  statusCoversRowMarker,
  type RowMarkerKind,
} from "./SidebarThreadRow.logic";
import { pickSnoozePreset, resolveSnoozePresets, type SnoozePreset } from "../Sidebar.snooze";
import { useThreadShell } from "../../state/entities";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { ThreadSearchMatchExcerpt } from "../ThreadSearchMatch";
import { makeWorkspaceFileDropHandlers } from "../chat/workspaceFileDrop";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { useThreadRunningTerminalIds } from "../../state/terminalSessions";
import { InlineButton } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Menu, MenuItem, MenuItemDetail, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ActivityShimmerOverlay } from "../chat/TimelineRowParts";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { useThreadHasUnsentDraft } from "../../composerDraftStore";
import { useThreadOutboxStore } from "../../threadOutboxStore";

// The fields thread rows show. Provider status pushes refresh `checkedAt`,
// status and auth on every provider; leaving those out keeps each
// environment's map, and every memoized row, stable across them.
export type SidebarProviderEntry = Pick<
  ProviderInstanceEntry,
  | "instanceId"
  | "driverKind"
  | "enabled"
  | "displayName"
  | "accentColor"
  | "acpRegistryAgentId"
  | "acpRegistryIconUrl"
  | "models"
>;
function compactSidebarTimeLabel(timestamp: string, nowMs: number, resolve: typeof t) {
  const parts = formatRelativeTime(timestamp, nowMs, resolve);
  if (parts === null) return "";
  return parts.suffix === null ? resolve(msg("now")) : parts.value;
}

function PendingSyncLabel() {
  return (
    <SharedTooltipTrigger
      render={<span />}
      label={<>{t("Waiting to sync with its environment")}</>}
    >
      {t("Pending")}
    </SharedTooltipTrigger>
  );
}

// Subscribes to the minute tick itself, so only the label re-renders each
// minute. The minute is passed as the clock so it is the formatter's input.
function RelativeTimeLabel(props: { timestamp: string | null }) {
  const nowMinute = useNowMinute();

  return props.timestamp === null
    ? null
    : compactSidebarTimeLabel(props.timestamp, Date.parse(`${nowMinute}:00.000Z`), t);
}

/** How long a Needs you thread has waited on the user, on the shared minute tick. */
export function WaitingSinceLabel(props: { since: number }) {
  const nowMinute = useNowMinute();
  return formatRelativeElapsed(Math.max(0, Date.parse(`${nowMinute}:00.000Z`) - props.since)).value;
}

export function JumpHintBadge(props: { label: string }) {
  return (
    <Kbd aria-hidden data-jump-hint>
      {props.label}
    </Kbd>
  );
}

export const JUMP_HINT_SLOT_CLASS_NAME =
  "[&>:not([data-jump-hint])]:invisible [&>:not([data-jump-hint])]:absolute";

/** How long a stalled thread has gone without an event; the label says what the time means. */
function QuietSinceLabel(props: { since: number }) {
  const nowMinute = useNowMinute();
  const elapsed = formatRelativeElapsed(
    Math.max(0, Date.parse(`${nowMinute}:00.000Z`) - props.since),
  ).value;
  return (
    <>
      <span aria-hidden>{elapsed}</span>
      <span className="sr-only">{t("no events for {elapsed}", { elapsed })}</span>
    </>
  );
}

export function WorkingDuration(props: { environmentId: EnvironmentId; startedAt: string | null }) {
  const startedMs = props.startedAt !== null ? Date.parse(props.startedAt) : Number.NaN;
  if (Number.isNaN(startedMs)) return null;
  return <WorkingDurationLabel environmentId={props.environmentId} startedMs={startedMs} />;
}

// Self-ticking so only this span re-renders each second, not the whole row;
// the shared tick lands every working row's update in the same frame.
function WorkingDurationLabel(props: { environmentId: EnvironmentId; startedMs: number }) {
  const nowMs = useNowSecond();

  return (
    <span className="tabular-nums">
      {formatWorkingDurationLabel(toServerClock(props.environmentId, nowMs) - props.startedMs, t)}
    </span>
  );
}

function terminalProcessLabel(count: number): string {
  return tn(count, "{count} terminal process running", "{count} terminal processes running");
}

function SidebarProviderStack(props: {
  thread: SidebarThreadSummary;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
}) {
  const stack = resolveThreadProviderStack(props.thread);
  const currentInstanceId = stack[stack.length - 1]!;
  const currentEntry = props.providerEntryByInstanceId.get(currentInstanceId) ?? null;
  if (currentEntry === null) return null;
  const showInstanceBadge = shouldShowInstanceBadge(
    currentEntry,
    props.providerEntryByInstanceId.values(),
  );
  const current = (
    <ProviderInstanceIcon
      driverKind={currentEntry.driverKind}
      displayName={currentEntry.displayName}
      accentColor={currentEntry.accentColor}
      acpRegistryAgentId={currentEntry.acpRegistryAgentId}
      acpRegistryIconUrl={currentEntry.acpRegistryIconUrl}
      showBadge={showInstanceBadge}
      size="compact"
      iconClassName="opacity-60"
    />
  );
  if (stack.length === 1) {
    return <span className="inline-flex shrink-0 items-center">{current}</span>;
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {stack.slice(0, -1).map((instanceId) => {
        const entry = props.providerEntryByInstanceId.get(instanceId);
        if (entry === undefined) return null;
        return (
          <ProviderInstanceIcon
            key={instanceId}
            driverKind={entry.driverKind}
            displayName={entry.displayName}
            acpRegistryAgentId={entry.acpRegistryAgentId}
            acpRegistryIconUrl={entry.acpRegistryIconUrl}
            iconClassName="size-3 opacity-35 grayscale"
          />
        );
      })}
      <span className="relative z-10 inline-flex items-center">{current}</span>
    </span>
  );
}

function SidebarThreadTooltip({
  thread,
  project,
  projectDisplayName,
  environmentLabel,
  environmentMachine,
  providerEntry,
  providerEntryByInstanceId,
  showInstanceBadge,
  modelInstanceId,
  modelLabel,
  branchMismatch,
  terminalStatus,
  terminalProcessCount,
  unreachableMachine = null,
  overflowMarkers,
  topStatusLabel = null,
  prStatus = null,
  prNumber = null,
  scheduledTasks = EMPTY_SCHEDULED_TASKS,
  preferenceLabels,
}: {
  thread: SidebarThreadSummary;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntry: SidebarProviderEntry | null;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  showInstanceBadge: boolean;
  modelInstanceId: string;
  modelLabel: string;
  branchMismatch: {
    threadBranch: string;
    currentBranch: string;
  } | null;
  terminalStatus: TerminalStatusIndicator | null;
  terminalProcessCount: number;
  unreachableMachine?: {
    readonly label: string;
    readonly state: string;
    readonly lastSeenAt: number | null;
  } | null;
  overflowMarkers: ReadonlyArray<RowMarkerKind>;
  topStatusLabel?: string | null;
  prStatus?: PrStatusIndicator | null;
  prNumber?: number | null;
  scheduledTasks?: ReadonlyArray<ScheduledTask>;
  preferenceLabels: ReturnType<typeof threadPreferenceLabels>;
}) {
  const driverKind = providerEntry?.driverKind ?? null;
  const worktreePath = thread.worktreePath?.trim();
  const previousProviderNames = thread.providerInstanceHistory
    .filter((instanceId) => instanceId !== modelInstanceId)
    .map((instanceId) => providerEntryByInstanceId.get(instanceId)?.displayName ?? instanceId);
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);

  const renderProjectRow = (hoverMarker?: RowMarkerKind) =>
    projectDisplayName ? (
      <div
        key={hoverMarker}
        data-hover-marker={hoverMarker}
        className="flex min-w-0 items-center gap-2"
      >
        {project ? <ProjectFavicon project={project} className="size-3 shrink-0" /> : null}
        <div className="min-w-0 truncate text-foreground/75">{projectDisplayName}</div>
      </div>
    ) : null;

  const renderMachineRow = (hoverMarker?: RowMarkerKind) =>
    environmentLabel ? (
      <div
        key={hoverMarker}
        data-hover-marker={hoverMarker}
        className="flex min-w-0 items-center gap-2"
      >
        <EnvironmentMachineIcon
          kind={environmentMachine}
          className="size-3 shrink-0 stroke-muted-foreground"
        />
        <div className="min-w-0 truncate text-foreground/75">{environmentLabel}</div>
      </div>
    ) : null;

  const renderMachineOfflineRow = (hoverMarker?: RowMarkerKind) =>
    unreachableMachine ? (
      <div
        key={hoverMarker}
        data-hover-marker={hoverMarker}
        className="flex min-w-0 items-start gap-2 text-muted-foreground"
      >
        <WifiOffIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
        <div className="min-w-0 flex-1 wrap-break-word">
          {unreachableMachine.state}
          {unreachableMachine.lastSeenAt !== null ? (
            <>
              {" · "}
              <MachineLastSeen lastSeenAt={unreachableMachine.lastSeenAt} />
            </>
          ) : null}
          {". "}
          {t("The status is the last one seen. Actions wait until {name} reconnects.", {
            name: unreachableMachine.label,
          })}
        </div>
      </div>
    ) : null;

  const renderProviderRow = (hoverMarker?: RowMarkerKind) =>
    driverKind ? (
      <div
        key={hoverMarker}
        data-hover-marker={hoverMarker}
        className="flex min-w-0 items-center gap-2"
      >
        <ProviderInstanceIcon
          driverKind={driverKind}
          displayName={
            providerEntry?.displayName ?? thread.runtime?.providerName ?? modelInstanceId
          }
          accentColor={providerEntry?.accentColor}
          acpRegistryAgentId={providerEntry?.acpRegistryAgentId}
          acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl}
          showBadge={showInstanceBadge && providerEntry?.accentColor !== undefined}
          badgeContent="none"
          badgeClassName="h-2 min-w-2 px-0"
          iconClassName="size-3 shrink-0 opacity-60"
        />
        <div className="min-w-0 truncate text-foreground/75">
          {showInstanceBadge && providerEntry
            ? t("{model} · {provider}", {
                model: modelLabel,
                provider: providerEntry.displayName,
              })
            : modelLabel}
        </div>
      </div>
    ) : null;

  const renderScheduledRow = (hoverMarker?: RowMarkerKind) =>
    scheduledTasks.length > 0 ? (
      <div
        key={hoverMarker}
        data-hover-marker={hoverMarker}
        className="flex min-w-0 items-start gap-2"
      >
        <CalendarClockIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-1">
          {scheduledTasks.map((task) => (
            <div key={task.id} className="min-w-0">
              <div className="truncate font-medium text-foreground/85">{task.title}</div>
              <div className="text-muted-foreground">
                <ScheduledTaskScheduleLine task={task} />
              </div>
            </div>
          ))}
        </div>
      </div>
    ) : null;

  const renderErrorRow = (hoverMarker?: RowMarkerKind) =>
    thread.runtime?.lastError || hoverMarker === "failed" ? (
      <div
        key={hoverMarker}
        data-hover-marker={hoverMarker}
        className={cn(
          "flex min-w-0 items-start gap-2",
          thread.runtime?.lastErrorClass === "usage_limit"
            ? "text-warning-foreground"
            : "text-error-foreground",
        )}
      >
        <CircleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
        <div className="line-clamp-3 min-w-0 flex-1 wrap-break-word">
          {thread.runtime?.lastErrorClass === "usage_limit"
            ? t("Usage limit reached")
            : (thread.runtime?.lastError ?? t("Failed"))}
        </div>
      </div>
    ) : null;

  const renderOverflowMarker = (kind: RowMarkerKind): ReactNode => {
    switch (kind) {
      case "needsYou":
        return (
          <div
            key={kind}
            data-hover-marker={kind}
            className="flex min-w-0 items-center gap-2 text-warning-foreground"
          >
            <CircleAlertIcon aria-hidden className="size-3 shrink-0 stroke-current" />
            <div className="min-w-0 truncate">{topStatusLabel ?? t("Needs you")}</div>
          </div>
        );
      case "failed":
        return renderErrorRow(kind);
      case "pr": {
        const PrIcon = prStatus?.Icon ?? PullRequestGlyph.pullRequest;
        const label =
          prStatus?.tooltip ?? (prNumber !== null ? t("PR #{number}", { number: prNumber }) : null);
        if (label === null) return null;
        return (
          <div key={kind} data-hover-marker={kind} className="flex min-w-0 items-start gap-2">
            <PrIcon
              aria-hidden
              className={cn(
                "mt-0.5 size-3 shrink-0",
                prStatus?.colorClass ?? "text-muted-foreground",
              )}
            />
            <div className="min-w-0 flex-1 wrap-break-word text-foreground/75">{label}</div>
          </div>
        );
      }
      case "machineOffline":
        return renderMachineOfflineRow(kind);
      case "draft":
        return (
          <div key={kind} data-hover-marker={kind} className="flex min-w-0 items-center gap-2">
            <SquarePenIcon aria-hidden className={draftPenClassName} />
            <div className="min-w-0 truncate text-foreground/75">{t("Unsent draft")}</div>
          </div>
        );
      case "queued":
        return (
          <div key={kind} data-hover-marker={kind} className="flex min-w-0 items-center gap-2">
            <ClockIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            <div className="min-w-0 truncate text-foreground/75">
              {t("Messages queued to send")}
            </div>
          </div>
        );
      case "terminal":
        return terminalStatus ? (
          <div key={kind} data-hover-marker={kind} className="flex min-w-0 items-center gap-2">
            <TerminalIcon
              aria-hidden
              className={cn("size-3 shrink-0", terminalStatus.colorClass)}
            />
            <div className="min-w-0 truncate text-foreground/75">
              {terminalProcessLabel(terminalProcessCount)}
            </div>
          </div>
        ) : null;
      case "scheduled":
        return renderScheduledRow(kind);
      case "pinned":
        return (
          <div key={kind} data-hover-marker={kind} className="flex min-w-0 items-center gap-2">
            <PinIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            <div className="min-w-0 truncate text-foreground/75">{t("Pinned")}</div>
          </div>
        );
      case "machine":
        return renderMachineRow(kind);
      case "project":
        return renderProjectRow(kind);
      case "tags":
        return thread.source.tags?.length ? (
          <div key={kind} data-hover-marker={kind} className="flex min-w-0 items-start gap-2">
            <TagIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 wrap-break-word text-foreground/75">
              {thread.source.tags.join(", ")}
            </div>
          </div>
        ) : null;
      case "color":
        return thread.color != null && preferenceLabels.color ? (
          <div key={kind} data-hover-marker={kind} className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className={cn("size-2 shrink-0 rounded-full", threadColorDotClass[thread.color])}
            />
            <div className="min-w-0 truncate text-foreground/75">{preferenceLabels.color}</div>
          </div>
        ) : null;
      case "notifications":
        return preferenceLabels.notifications ? (
          <div key={kind} data-hover-marker={kind} className="flex min-w-0 items-center gap-2">
            {thread.notificationLevel === "muted" ? (
              <BellOffIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            ) : (
              <BellIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 truncate text-foreground/75">
              {preferenceLabels.notifications}
            </div>
          </div>
        ) : null;
      case "provider":
        return renderProviderRow(kind);
    }
  };

  const hasPrInOverflow = overflowMarkers.includes("pr");
  return (
    <>
      <ThreadHoverCard
        title={thread.title}
        footer={
          supportsMultiplePullRequests &&
          thread.pullRequests.length > 0 &&
          (!hasPrInOverflow || thread.pullRequests.length > 1) ? (
            <div className="border-t border-border/60 pt-2 pl-0.5 text-xs text-muted-foreground">
              <ThreadPullRequestsMiniList pullRequests={thread.pullRequests} />
            </div>
          ) : null
        }
      >
        {overflowMarkers.map(renderOverflowMarker)}
        {!overflowMarkers.includes("project") ? renderProjectRow() : null}
        {!overflowMarkers.includes("machine") ? renderMachineRow() : null}
        {!overflowMarkers.includes("machineOffline") ? renderMachineOfflineRow() : null}
        {thread.branch ? (
          <div className="flex min-w-0 items-center gap-2">
            <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <MiddleTruncate value={thread.branch} className="flex" />
          </div>
        ) : null}
        {worktreePath ? (
          <div className="flex min-w-0 items-center gap-2">
            <FolderGit2Icon className="size-3 shrink-0 stroke-muted-foreground" />
            <MiddleTruncate value={formatWorktreePathForDisplay(worktreePath)} className="flex" />
          </div>
        ) : null}
        {branchMismatch ? (
          <div className="flex min-w-0 items-start gap-2 text-warning">
            <CircleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
            <div className="min-w-0 flex-1 wrap-break-word">
              {t("You're currently checked out on another branch.")}
            </div>
          </div>
        ) : null}
        {!overflowMarkers.includes("provider") ? renderProviderRow() : null}
        {previousProviderNames.length > 0 ? (
          <div className="flex min-w-0 items-center gap-2">
            <ArrowRightLeftIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <div className="min-w-0 truncate text-foreground/75">
              {t("Handed off from {providers}", { providers: previousProviderNames.join(", ") })}
            </div>
          </div>
        ) : null}
        {!overflowMarkers.includes("scheduled") ? renderScheduledRow() : null}
        {!overflowMarkers.includes("failed") && thread.runtime?.lastError ? renderErrorRow() : null}
      </ThreadHoverCard>
    </>
  );
}

const EMPTY_SCHEDULED_TASKS: ReadonlyArray<ScheduledTask> = [];

function SnoozeMenuButton(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  timestampFormat: TimestampFormat;
  environmentId: EnvironmentId;
}) {
  const { open, onOpenChange, onSnooze, timestampFormat, environmentId } = props;

  const presets = open
    ? // oxlint-disable-next-line react/purity -- Presets are resolved only while the menu is open, so each opening reads a fresh time.
      resolveSnoozePresets(new Date(), timestampFormat, environmentId, t)
    : [];
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <SharedTooltipTrigger
        render={
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label={t("Snooze thread")}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                className="inline-flex h-full cursor-pointer items-center gap-0.5 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
              />
            }
          />
        }
        label={<>{t("Snooze thread")}</>}
      >
        <ClockIcon className="size-3" />
      </SharedTooltipTrigger>
      <MenuPopup side="bottom" align="end">
        {presets.map((preset) => (
          <MenuItem
            key={preset.id}
            onClick={(event) => {
              event.stopPropagation();
              const picked = pickSnoozePreset(presets, preset.id, timestampFormat, environmentId);
              if (picked) onSnooze(picked);
            }}
          >
            {preset.label}
            <MenuItemDetail>{preset.whenLabel}</MenuItemDetail>
          </MenuItem>
        ))}
        {presets.length > 0 ? <MenuSeparator /> : null}
        <MenuItem
          onClick={async (event) => {
            event.stopPropagation();
            const choice = await requestCustomSnooze();
            if (choice) onSnooze(choice);
          }}
        >
          {t("Custom…")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

type SortableThreadRowBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

export const draftSurfaceClassName = "bg-warning/4 hover:bg-warning/8";
export const draftPenClassName = "size-3 shrink-0 text-warning-foreground";

// useSortable memoizes on its `disabled` object, so a fresh one per render
// re-renders every row and marker on each sidebar update.
export const SIDEBAR_SORTABLE_DRAG_DISABLED = { draggable: true } as const;
const SIDEBAR_SORTABLE_DRAG_ENABLED = { draggable: false } as const;

type ListThreadRowProps = Omit<SidebarThreadRowProps, "sortable" | "copy">;

// Takes the row's props rather than a render function: a closure from the
// sidebar body is new on every sidebar render, which rebuilt the bag and
// re-rendered every memoized row with it.
/** A null `sortableId` makes a row that does not drag: a copy, or a Needs you row. */
export function SortableThreadRow(
  props: ListThreadRowProps & {
    sortableId: string | null;
    copy: boolean;
    sortableDisabled: boolean;
    contextDrag: boolean;
  },
) {
  const { sortableId, copy, sortableDisabled, contextDrag, ...rowProps } = props;
  return sortableId === null ? (
    <StaticThreadRow {...rowProps} copy={copy} />
  ) : (
    <DraggableThreadRow
      {...rowProps}
      sortableId={sortableId}
      sortableDisabled={sortableDisabled}
      contextDrag={contextDrag}
    />
  );
}

function StaticThreadRow(props: ListThreadRowProps & { copy: boolean }) {
  const thread =
    useThreadShell(scopeThreadRef(props.thread.environmentId, props.thread.id)) ?? props.thread;
  return <SidebarThreadRow key={props.variant} {...props} thread={thread} />;
}

function DraggableThreadRow(
  props: ListThreadRowProps & {
    sortableId: string;
    sortableDisabled: boolean;
    contextDrag: boolean;
  },
) {
  const { sortableId, sortableDisabled, contextDrag, ...rowProps } = props;
  const canOperateThread = useEnvironmentScope(
    rowProps.thread.environmentId,
    AuthOrchestrationOperateScope,
  );
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
    disabled:
      sortableDisabled || !canOperateThread
        ? SIDEBAR_SORTABLE_DRAG_DISABLED
        : SIDEBAR_SORTABLE_DRAG_ENABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  // dnd-kit memoizes each field but not the bag, so the memoized row would
  // rerender on every shell update without this.
  const bag = {
    listeners,
    setNodeRef,
    transform: contextDrag ? null : transform,
    transition: contextDrag && isDragging ? "transform 150ms ease-out" : transition,
    isDragging: isDragging && !contextDrag,
  };
  // The sidebar arranges rows from quiet shells, which hold still while a
  // thread streams; reading the live shell here re-renders only this row.
  const liveThread = useThreadShell(
    scopeThreadRef(rowProps.thread.environmentId, rowProps.thread.id),
  );
  // A runtime on the arranged copy but not the run-less live shell is the list's launch overlay.
  const thread =
    liveThread === null
      ? rowProps.thread
      : rowProps.thread.runtime !== null
        ? asLaunchingThread(liveThread)
        : liveThread;
  // Keyed by variant so a card/slim switch remounts the row.
  return (
    <SidebarThreadRow
      key={rowProps.variant}
      {...rowProps}
      copy={false}
      thread={thread}
      sortable={bag}
    />
  );
}
export type SidebarSweepAction = "settle" | "unsettle" | "unsnooze";
const dropVerbBadge = (verb: SidebarDropVerb): ReactNode => {
  switch (verb) {
    case "pin":
      return (
        <>
          <PinIcon aria-hidden className="size-3" />
          {t("Pin")}
        </>
      );
    case "unpin":
      return (
        <>
          <PinOffIcon aria-hidden className="size-3" />
          {t("Unpin")}
        </>
      );
    case "settle":
      return (
        <>
          <CircleCheckIcon aria-hidden className="size-3" />
          {t("Settle")}
        </>
      );
    case "unsettle":
      return (
        <>
          <Undo2Icon aria-hidden className="size-3" />
          {t("Un-settle")}
        </>
      );
    case "wake":
      return (
        <>
          <AlarmClockOffIcon aria-hidden className="size-3" />
          {t("Wake")}
        </>
      );
  }
};

type SidebarThreadRowProps = {
  thread: SidebarThreadSummary;
  // "folder" is a one-line row inside a sidebar folder;
  // "folder-multiline" adds the card's branch and PR line under it.
  // "line" is a folder row outside any folder, unindented and with its project icon.
  variant: "card" | "slim" | "folder" | "folder-multiline" | "line";
  // The folders a row sits in name its machine or project, so the row leaves those out.
  inMachineFolder: boolean;
  inProjectFolder: boolean;
  // A second row for a thread listed elsewhere too; rename and focus stay on the row they began on.
  copy: boolean;
  navigationParent?: string | undefined;
  variantAction: SidebarSweepAction;
  settlementSupported: boolean;
  snoozeSupported: boolean;
  pinningSupported: boolean;
  isPinned: boolean;
  sortable?: SortableThreadRowBag | undefined;
  dropVerb: SidebarDropVerb | null;
  dragOverPinned: boolean;
  sweepAction: SidebarSweepAction | null;
  snoozeWakeLabelText: string | null;
  wokeAt: string | null;
  /** Set on Needs you rows: when the thread started waiting on the user, in epoch ms. */
  waitingSince?: number | null | undefined;
  currentEnvironmentId?: EnvironmentId | null | undefined;
  scratchMachineLabel?: string | null | undefined;
  isActive: boolean;
  // Set on the active row only; scrolls it into view when a reveal is owed.
  revealRef?: ((row: HTMLElement, threadKey: string) => (() => void) | undefined) | undefined;
  // Unlike isActive, never true for the ancestor standing in for an open
  // subagent: drafts and PR clicks care about which composer is on screen.
  isRouteThread: boolean;
  // Read at click time; a prop would re-render every row on entering or leaving a thread route.
  readOpensPullRequestsInRightPanel: () => boolean;
  jumpLabel: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  timestampFormat: TimestampFormat;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string, copy: boolean) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string) => void;
  onCancelRename: () => void;
  isRenaming: boolean;
  renamingTitle: string;
  onContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    copy: boolean,
    source: ContextMenuSource,
  ) => void;
  onSettle: (threadRef: ScopedThreadRef) => void;
  onActionSweepStart: (
    threadRef: ScopedThreadRef,
    action: SidebarSweepAction,
    event: PointerEvent,
  ) => void;
  onUnsettle: (threadRef: ScopedThreadRef) => void;
  onSnooze: (threadRef: ScopedThreadRef, preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  onUnsnooze: (threadRef: ScopedThreadRef) => void;
  onPin: (threadRef: ScopedThreadRef) => void;
  onUnpin: (threadRef: ScopedThreadRef) => void;
  onAcknowledgeWoke: (threadRef: ScopedThreadRef, visitedAt: string) => void;
  onFileDropThreads?: ((threadRef: ScopedThreadRef, files: File[]) => void) | undefined;
};

// Mounted only while renaming, so each rename starts uncommitted.
function ThreadRenameInput(props: {
  title: string;
  onTitleChange: (title: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  // Enter and Escape blur the input as it unmounts; that blur must not commit again.
  const settledRef = useRef(false);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      settledRef.current = true;
      props.onCommit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      settledRef.current = true;
      props.onCancel();
    }
  };
  return (
    <input
      autoFocus
      value={props.title}
      dir="auto"
      aria-label={t("Thread title")}
      onChange={(event) => props.onTitleChange(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (!settledRef.current) props.onCommit();
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="-mx-1 min-w-0 flex-1 rounded-sm bg-card px-1 text-sm font-medium text-card-foreground outline-none ring-1 ring-inset ring-input focus:ring-foreground"
    />
  );
}

const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const {
    copy,
    isRenaming,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onAcknowledgeWoke,
    onFileDropThreads,
    onRenameTitleChange,
    onSettle,
    onActionSweepStart,
    onSnooze,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    onUnsettle,
    onUnsnooze,
    onPin,
    onUnpin,
    readOpensPullRequestsInRightPanel,
    renamingTitle,
    thread,
    variant,
    variantAction,
  } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const rowId = copy ? `copy:${threadKey}` : threadKey;
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const canTriageThread = !useEnvironmentScopeDenied(
    thread.environmentId,
    AuthOrchestrationOperateScope,
  );
  const pendingSync = useAtomValue(
    threadEnvironment.pendingSyncAtom(thread.environmentId),
    (threads) => threads.has(thread.id),
  );
  const { leaseLiveStatus, rowRef: leaseRowRef } = useSidebarRowSubscriptionLease(props.isActive);
  const { revealRef } = props;
  const rowRef = (row: HTMLElement | null) => {
    const stopReveal = row === null ? undefined : revealRef?.(row, threadKey);
    const releaseLease = leaseRowRef(row);
    if (!stopReveal) return releaseLease;
    return () => {
      stopReveal();
      releaseLease?.();
    };
  };
  const isRegeneratingTitle = thread.titleRegeneration != null;
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const openPrLink = useOpenPrLink();
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds, t);
  const terminalProcessCount = runningTerminalIds.length;
  const hasUnsentDraft = useThreadHasUnsentDraft(threadRef) && !props.isRouteThread;
  const hasQueuedMessages = useThreadOutboxStore((state) =>
    state.messages.some(
      (message) => message.environmentId === thread.environmentId && message.threadId === thread.id,
    ),
  );
  const handleDiscardDraftClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    discardComposerDraft(threadRef);
  };

  const gitCwd = thread.worktreePath ?? props.project?.workspaceRoot ?? null;
  const linkedPullRequestStatus = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    leaseLiveStatus,
    thread.pullRequests,
    thread.branchPullRequest,
  );
  const branchTarget =
    leaseLiveStatus && (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? { environmentId: thread.environmentId, cwd: gitCwd }
      : null;
  const gitStatus = useEnvironmentQuery(
    branchTarget === null
      ? null
      : vcsEnvironment.branch({
          environmentId: branchTarget.environmentId,
          input: { cwd: branchTarget.cwd },
        }),
  );
  useAtomMount(vcsBranchRevalidation(branchTarget));
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const checkoutThread = withoutRemovedCheckout(thread, visibleGitStatus, props.project);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemote = thread.environmentId !== (props.currentEnvironmentId ?? primaryEnvironmentId);
  const showsScratchMachine = !checkoutThread.branch && props.scratchMachineLabel != null;
  const pr = linkedPullRequestStatus?.pr ?? null;
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const currentLinkedPr = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(thread.pullRequests)
    : null;

  const status = resolveSidebarRowStatus({ ...thread, lastVisitedAt });
  const isUnread =
    status !== "failed" &&
    status !== "limited" &&
    hasUnseenCompletion({ ...thread, lastVisitedAt });
  const isWoke = hasUnseenWake({
    wokeAt: props.wokeAt,
    lastVisitedAt,
    settled: thread.settledOverride === "settled",
  });
  const machineConnection = useEnvironmentConnectionSummary(thread.environmentId);
  const machine = machineConnection
    ? machineAvailability(machineConnection.connectionState)
    : "live";
  const machineUnreachable = machineShowsLastKnownState(machine);
  const shouldRecede =
    (machineUnreachable && !props.isActive && !isSelected) ||
    shouldRecedeSidebarThread({
      status,
      isUnread,
      isWoke,
      isActive: props.isActive,
      isSelected,
    });
  const stall = useThreadStall(thread);
  const topStatus = resolveThreadRowStatus({
    status,
    settingUp: thread.runtime?.status === "preparing",
    goalActive: thread.goal?.status === "active",
    isWoke,
    isUnread,
    stalled: stall !== null,
    machine,
  });
  // A frozen status has no live clock: the time it shows would only keep counting from memory.
  const statusIsLive = topStatus?.lastKnown === undefined;
  const isWokeStatus = topStatus?.icon === "woke";

  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: visibleGitStatus?.refName ?? null,
  });
  const prStatus = prStatusIndicator(pr, linkedPullRequestStatus?.sourceControlProvider, t);

  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelName(selectedModel, providerEntry?.driverKind)
    : thread.modelSelection.model;

  const scheduledTasks = useThreadScheduledTasks(thread.environmentId, thread.id);
  const prBadgeShape = supportsMultiplePullRequests
    ? resolveThreadPullRequestBadge(thread.pullRequests)
    : null;
  const hasPr = prBadgeShape?.kind === "stack" || pr !== null || currentLinkedPr !== null;
  const sortable = props.sortable;
  const showPin =
    props.isPinned && (!sortable?.isDragging || (props.dragOverPinned && props.dropVerb === null));
  const machineBadgeLabel =
    machineConnection?.environmentLabel ??
    props.environmentLabel ??
    props.scratchMachineLabel ??
    "";
  const hasMachineBadge = (isRemote || showsScratchMachine) && machineBadgeLabel.length > 0;
  const providerStack = resolveThreadProviderStack(thread);
  const hasProvider =
    props.providerEntryByInstanceId.get(providerStack[providerStack.length - 1]!) !== undefined;
  const hasProject =
    variant === "card"
      ? props.project !== null || props.projectDisplayName !== null
      : props.project !== null;
  const preferenceLabels = threadPreferenceLabels(thread);
  const pickedMarkers = resolveSidebarRowMarkers(
    {
      status,
      hasPr,
      machineUnreachable,
      hasUnsentDraft,
      hasQueuedMessages,
      hasRunningTerminal: runningTerminalIds.length > 0,
      hasScheduledTask: scheduledTasks.length > 0,
      // One-line pinned rows sit under the Pinned header, so the pin shows only as Unpin on hover.
      showPin: showPin && variant !== "line",
      hasMachineBadge,
      hasProject,
      hasTags: Boolean(thread.source.tags?.length),
      hasColor: thread.color != null,
      hasNotificationPreference:
        thread.notificationLevel === "muted" || thread.notificationLevel === "following",
      hasProvider,
    },
    {
      machine: props.inMachineFolder,
      project: props.inProjectFolder,
    },
  );
  const multiline = variant === "folder-multiline";
  const indented = variant === "folder" || multiline;
  // Folder-style rows have no status line, so the status takes the time slot.
  const inFolder = indented || variant === "line";
  const showsStatusSlot =
    variant === "card" ||
    (inFolder && !(variantAction === "unsnooze" && props.snoozeWakeLabelText !== null));
  const statusCoversPrimary = statusCoversRowMarker(
    pickedMarkers.primary,
    topStatus,
    showsStatusSlot,
  );
  const renderedMarkerKind = statusCoversPrimary ? null : pickedMarkers.primary;

  const detailsTooltip = (
    <SidebarThreadTooltip
      thread={checkoutThread}
      project={props.project}
      projectDisplayName={props.projectDisplayName}
      environmentLabel={props.environmentLabel}
      environmentMachine={props.environmentMachine}
      providerEntry={providerEntry}
      providerEntryByInstanceId={props.providerEntryByInstanceId}
      showInstanceBadge={showInstanceBadge}
      modelInstanceId={modelInstanceId}
      modelLabel={modelLabel}
      branchMismatch={branchMismatch}
      terminalStatus={terminalStatus}
      terminalProcessCount={terminalProcessCount}
      unreachableMachine={
        machineUnreachable && machineConnection
          ? {
              label: machineConnection.environmentLabel,
              state: machineAvailabilityLabel(machine),
              lastSeenAt: machineConnection.lastSeenAt,
            }
          : null
      }
      overflowMarkers={pickedMarkers.overflow}
      topStatusLabel={topStatus?.lastKnown?.label ?? topStatus?.label ?? null}
      prStatus={prStatus}
      prNumber={pr?.number ?? currentLinkedPr?.number ?? null}
      scheduledTasks={scheduledTasks}
      preferenceLabels={preferenceLabels}
    />
  );

  const intentPrefetch = useThreadIntentPrefetch(threadRef);
  const handleClick = (event: ReactMouseEvent) => {
    onThreadClick(event, threadRef);
  };
  const handleAcknowledgeWokeClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (props.wokeAt === null) return;
    onAcknowledgeWoke(threadRef, props.wokeAt);
  };
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    onContextMenu(
      threadRef,
      { x: event.clientX, y: event.clientY },
      copy,
      contextMenuSourceOf(event),
    );
  };
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (
      event.key === "F2" &&
      !isRenaming &&
      readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
    ) {
      event.preventDefault();
      onStartRename(threadRef, thread.title, copy);
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onThreadActivate(threadRef);
  };
  const handleDoubleClick = (event: ReactMouseEvent) => {
    if (
      !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope) ||
      isRenaming ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    if ((event.target as HTMLElement).closest("button, a, input")) return;
    event.preventDefault();
    onStartRename(threadRef, thread.title, copy);
  };
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = onFileDropThreads
    ? makeWorkspaceFileDropHandlers({
        setDragActive: (active) => setFileDragActive(setIsFileDragOver, active),
        addFiles: (files) => {
          onFileDropThreads(threadRef, files);
        },
        addFolders: () => {},
      })
    : null;
  const handleSettleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onSettle(threadRef);
  };
  const handleActionPointerDown = (event: ReactPointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.stopPropagation();
    // Sweeps follow the list order, where a copy has no place of its own.
    if (!copy) onActionSweepStart(threadRef, variantAction, event.nativeEvent);
  };
  const handleUnsettleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnsettle(threadRef);
  };
  const handleUnsnoozeClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnsnooze(threadRef);
  };
  const handlePinClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onPin(threadRef);
  };
  const handleUnpinClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnpin(threadRef);
  };
  const handleSnoozePreset = (preset: Pick<SnoozePreset, "snoozedUntil">) => {
    onSnooze(threadRef, preset);
  };
  const [snoozeMenuOpenRaw, setSnoozeMenuOpen] = useState(false);
  // The React Compiler caches render results on their inputs, so a clock read
  // here would stay frozen until `thread` changes and a queued-turn gate would
  // never reopen. The gate's clock is state, reset with the thread.
  const [snoozeGateClock, setSnoozeGateClock] = useState(() => ({
    thread,
    now: new Date().toISOString(),
  }));
  if (snoozeGateClock.thread !== thread) {
    // oxlint-disable-next-line react/purity -- Reseeds the snooze gate clock only in the render-phase adjustment that runs when the thread changes.
    setSnoozeGateClock({ thread, now: new Date().toISOString() });
  }
  const snoozeGateNow = snoozeGateClock.now;
  const snoozeGateExpiryMs = hasQueuedTurnStart(thread, { now: snoozeGateNow })
    ? Date.parse(thread.latestUserMessageAt ?? "") + QUEUED_TURN_START_GRACE_MS
    : Number.NaN;
  // A gate still closed past its expiry is held by runtime status, not time,
  // so no clock tick can open it.
  const snoozeGateOpensAt =
    Number.isFinite(snoozeGateExpiryMs) && snoozeGateExpiryMs > Date.parse(snoozeGateNow)
      ? snoozeGateExpiryMs + 50
      : null;
  const snoozeGateOpened = useDeadlinePassed(snoozeGateOpensAt);
  if (snoozeGateOpened && snoozeGateOpensAt !== null) {
    setSnoozeGateClock({ thread, now: new Date(snoozeGateOpensAt).toISOString() });
  }
  const showSnoozeButton =
    canOperateThread &&
    props.snoozeSupported &&
    !machineUnreachable &&
    canSnooze(thread, { now: snoozeGateNow });
  const settlementSupported = canTriageThread && props.settlementSupported && !machineUnreachable;
  // Closing here, not just masking, keeps the menu from reopening when the button returns.
  if (snoozeMenuOpenRaw && !showSnoozeButton) setSnoozeMenuOpen(false);
  const snoozeMenuOpen = snoozeMenuOpenRaw && showSnoozeButton;
  const jumpHintLabel = snoozeMenuOpen ? null : props.jumpLabel;
  const handlePrClick = (event: ReactMouseEvent<HTMLElement>, targetUrl?: string) => {
    const url = targetUrl ?? pr?.url ?? currentLinkedPr?.url;
    if (!url) return;
    const showInRightPanel = targetUrl !== undefined || readOpensPullRequestsInRightPanel();
    const openedInRightPanel = openPrLink(event, url, showInRightPanel ? threadRef : undefined);
    if (openedInRightPanel && showInRightPanel && !props.isRouteThread) {
      onThreadActivate(threadRef);
    }
  };

  const rowSurfaceClassName = cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    variantAction === "unsettle" &&
      !props.isActive &&
      "[&:not(:hover):not(:focus-within)_*:not(.live-activity-focus_*)]:text-secondary-label",
    props.isActive
      ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
      : isSelected || props.sweepAction !== null
        ? "bg-sidebar-row-selected text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
        : hasUnsentDraft
          ? cn(draftSurfaceClassName, "text-sidebar-foreground")
          : shouldRecede
            ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
    shouldRecede &&
      status === "working" &&
      "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
    isFileDragOver && "ring-1 ring-inset ring-primary/70",
    isFileDragOver && !props.isActive && !isSelected && "bg-sidebar-row-hover",
    props.sortable?.isDragging &&
      "bg-sidebar bg-linear-to-b from-sidebar-row-active to-sidebar-row-active text-sidebar-foreground opacity-100 shadow-lg",
  );
  const sortableRootProps = sortable
    ? {
        ref: sortable.setNodeRef,
        style: {
          transform: CSS.Translate.toString(sortable.transform),
          transition: sortable.transition,
          // A zero-height boundary also makes dnd-kit scale the source to
          // zero. Only projected peers use scaleY as a visibility sentinel.
          visibility:
            !sortable.isDragging && sortable.transform?.scaleY === 0
              ? ("hidden" as const)
              : undefined,
        },
        ...sortable.listeners,
      }
    : {};
  const destinationVerb = sortable?.isDragging
    ? props.dropVerb
    : props.sweepAction === "unsnooze"
      ? "wake"
      : props.sweepAction;
  const dragDestination =
    destinationVerb !== null ? (
      <span
        role="status"
        className="pointer-events-none ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-2xs font-medium text-primary"
      >
        {dropVerbBadge(destinationVerb)}
      </span>
    ) : null;

  const accessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel: pendingSync
      ? t("Pending")
      : (topStatus?.lastKnown?.label ?? topStatus?.label ?? null),
    projectDisplayName: props.projectDisplayName,
    isActive: props.isActive,
  });

  const title = isRenaming ? (
    <ThreadRenameInput
      title={renamingTitle}
      onTitleChange={onRenameTitleChange}
      onCommit={() => onCommitRename(threadRef, renamingTitle)}
      onCancel={onCancelRename}
    />
  ) : (
    <span
      ref={isRegeneratingTitle ? observeVisibleAnimation : undefined}
      className={cn(
        "min-w-0 flex-1 text-start text-sm transition-opacity motion-reduce:transition-none",
        shouldRecede ? "font-normal" : "font-medium",
        isRegeneratingTitle
          ? "relative truncate text-muted-foreground"
          : variant !== "slim"
            ? cn(
                "truncate",
                shouldRecede
                  ? "text-foreground/75 group-hover/sidebar-row:text-foreground group-focus-visible/sidebar-row:text-foreground"
                  : status === "failed" && !isUnread && !isWoke
                    ? "text-foreground/95"
                    : "text-foreground",
              )
            : cn(
                "truncate group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground",
                shouldRecede
                  ? "text-secondary-label"
                  : props.isActive || isWoke || status === "input" || status === "request"
                    ? "text-foreground"
                    : isUnread
                      ? "text-muted-foreground"
                      : "text-secondary-label/70",
              ),
      )}
      dir={textDirection(thread.title)}
    >
      {thread.title}
      {isRegeneratingTitle ? (
        <ActivityShimmerOverlay className="truncate">{thread.title}</ActivityShimmerOverlay>
      ) : null}
    </span>
  );
  const tags = thread.source.tags;
  const tagChips = tags?.length ? (
    <span className="flex min-w-0 items-center gap-1">
      {tags.slice(0, 2).map((tag) => (
        <span
          key={tag}
          className="min-w-0 truncate rounded bg-muted px-1 text-2xs text-muted-foreground"
        >
          {tag}
        </span>
      ))}
      {tags.length > 2 ? (
        <span className="shrink-0 text-2xs text-muted-foreground">
          {t("+{count}", { count: tags.length - 2 })}
        </span>
      ) : null}
    </span>
  ) : null;

  const openLinkedItems = () => {
    useRightPanelStore.getState().open(threadRef, "pull-requests");
    if (!props.isRouteThread) onThreadActivate(threadRef);
  };
  const prBadge = hasPr ? (
    <ThreadPullRequestBadgeControl
      render={<InlineButton />}
      badge={prBadgeShape}
      pullRequests={thread.pullRequests}
      number={pr?.number ?? currentLinkedPr?.number}
      url={pr?.url ?? currentLinkedPr?.url}
      status={prStatus}
      onOpenList={openLinkedItems}
      onOpenPullRequest={handlePrClick}
      side="right"
    />
  ) : null;
  const firstIssue = thread.issues?.[0];
  const issueCount = thread.issues?.length ?? 0;
  const issueState = useSidebarLinkedIssueState(
    thread.environmentId,
    leaseLiveStatus ? thread.issues : undefined,
  );
  const issueStatus = issueState === null ? null : issueStatePresentation(issueState);
  const issueLabel =
    issueCount === 1 && firstIssue
      ? issueStatus
        ? t("Issue {key}: {title}, {state}", {
            key: firstIssue.displayKey,
            title: firstIssue.title,
            state: issueStatus.label,
          })
        : t("Issue {key}: {title}", { key: firstIssue.displayKey, title: firstIssue.title })
      : tn(issueCount, "{count} linked issue", "{count} linked issues");
  const issueBadge = firstIssue ? (
    <ThreadLinkBadge
      control={
        <InlineButton
          aria-label={issueLabel}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            openLinkedItems();
          }}
        />
      }
      Icon={issueStatus?.Icon ?? IssueGlyph.issue}
      toneClassName={issueStatus?.toneClassName ?? "text-muted-foreground"}
      text={issueCount === 1 ? firstIssue.displayKey.replace(/^#/, "") : issueCount}
      side="right"
    >
      <ThreadDetailsIssueRows
        links={(thread.issues ?? []).slice(0, LINKED_ITEMS_PREVIEW_LIMIT)}
        threadRef={threadRef}
        compact={false}
        mountScope="sidebar-tooltip"
        onOpen={() => {
          if (!props.isRouteThread) onThreadActivate(threadRef);
        }}
      />
      <LinkedItemsOverflow
        hidden={issueCount - LINKED_ITEMS_PREVIEW_LIMIT}
        onShowAll={openLinkedItems}
      />
    </ThreadLinkBadge>
  ) : null;
  const terminalStatusIcon = (
    <ThreadTerminalStatusButton
      threadRef={threadRef}
      terminalIds={runningTerminalIds}
      onThreadActivate={onThreadActivate}
    />
  );
  const draftIndicator = hasUnsentDraft ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={t("Unsent draft")}
            data-testid={`sidebar-draft-indicator-${thread.id}`}
            className="inline-flex shrink-0 items-center"
          />
        }
      >
        <SquarePenIcon aria-hidden className={draftPenClassName} />
      </TooltipTrigger>
      <TooltipPopup side="top">{t("Unsent draft")}</TooltipPopup>
    </Tooltip>
  ) : null;
  const queuedIndicator = hasQueuedMessages ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={t("Messages queued to send")}
            className="inline-flex shrink-0 items-center text-muted-foreground"
          />
        }
      >
        <ClockIcon aria-hidden className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">{t("Messages queued to send")}</TooltipPopup>
    </Tooltip>
  ) : null;
  const pinIndicator = showPin ? (
    props.pinningSupported && canOperateThread && !sortable?.isDragging ? (
      <SharedTooltipTrigger
        render={
          <button
            type="button"
            aria-label={t("Unpin thread")}
            onClick={handleUnpinClick}
            className="group/unpin inline-flex cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
        label={<>{t("Unpin thread")}</>}
      >
        <PinIcon
          aria-hidden
          className="size-3 shrink-0 group-hover/unpin:hidden group-focus-visible/unpin:hidden"
        />
        <PinOffIcon
          aria-hidden
          className="hidden size-3 shrink-0 group-hover/unpin:block group-focus-visible/unpin:block"
        />
      </SharedTooltipTrigger>
    ) : (
      <PinIcon
        aria-label={t("Pinned")}
        role="img"
        className="size-3 shrink-0 text-muted-foreground/65"
      />
    )
  ) : null;

  const canPinOnHover =
    !props.isPinned &&
    props.pinningSupported &&
    canOperateThread &&
    !machineUnreachable &&
    !sortable?.isDragging;
  const renderPinButton = (className: string, iconClassName: string) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={t("Pin thread")}
            onClick={handlePinClick}
            className={className}
          />
        }
      >
        <PinIcon aria-hidden className={iconClassName} />
      </TooltipTrigger>
      <TooltipPopup>{t("Pin thread")}</TooltipPopup>
    </Tooltip>
  );

  const renderPrimaryMarker = (kind: RowMarkerKind, layout: "card" | "inline"): ReactNode => {
    switch (kind) {
      case "needsYou":
        return (
          <span
            data-row-marker="needsYou"
            className={cn(
              "inline-flex shrink-0 items-center gap-1 text-xs font-medium",
              topStatus?.className ?? "text-warning-foreground",
            )}
          >
            {topStatus ? (
              <ThreadRowStatusContent status={topStatus} iconClassName="size-3" />
            ) : (
              <>
                <CircleAlertIcon aria-hidden className="size-3 shrink-0" />
                <span>{t("Needs you")}</span>
              </>
            )}
          </span>
        );
      case "failed":
        return (
          <span
            data-row-marker="failed"
            className={cn(
              "inline-flex shrink-0 items-center gap-1 text-xs font-medium",
              topStatus?.className ?? "text-error-foreground",
            )}
          >
            {topStatus ? (
              <ThreadRowStatusContent status={topStatus} iconClassName="size-3" />
            ) : (
              <>
                <CircleAlertIcon aria-hidden className="size-3 shrink-0" />
                <span>{t("Failed")}</span>
              </>
            )}
          </span>
        );
      case "pr":
        return prBadge ? (
          <span data-row-marker="pr" className="inline-flex shrink-0 items-center">
            {prBadge}
          </span>
        ) : null;
      case "machineOffline":
        return (
          <span
            data-row-marker="machineOffline"
            className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground"
          >
            <WifiOffIcon aria-hidden className="size-3 shrink-0" />
            <span>{machineAvailabilityLabel(machine)}</span>
          </span>
        );
      case "draft":
        return draftIndicator ? (
          <span data-row-marker="draft" className="inline-flex shrink-0 items-center">
            {draftIndicator}
          </span>
        ) : null;
      case "queued":
        return queuedIndicator ? (
          <span data-row-marker="queued" className="inline-flex shrink-0 items-center">
            {queuedIndicator}
          </span>
        ) : null;
      case "terminal":
        return (
          <span data-row-marker="terminal" className="inline-flex shrink-0 items-center">
            {terminalStatusIcon}
          </span>
        );
      case "scheduled":
        return (
          <span data-row-marker="scheduled" className="inline-flex shrink-0 items-center">
            <ThreadScheduledTaskIndicator
              environmentId={thread.environmentId}
              threadId={thread.id}
              tasks={scheduledTasks}
            />
          </span>
        );
      case "pinned":
        return pinIndicator ? (
          <span data-row-marker="pinned" className="inline-flex shrink-0 items-center">
            {pinIndicator}
          </span>
        ) : null;
      case "machine":
        return (
          <span
            data-row-marker="machine"
            className={cn(
              "inline-flex items-center gap-1",
              layout === "card" ? "min-w-0" : "shrink-0",
            )}
          >
            <MachineBadge
              environmentId={thread.environmentId}
              label={machineBadgeLabel}
              className="size-3.5 text-4xs"
            />
            {layout === "card" ? (
              <span className="min-w-0 truncate text-xs font-normal text-secondary-label">
                {machineBadgeLabel}
              </span>
            ) : null}
          </span>
        );
      case "project":
        return layout === "card" ? (
          <span data-row-marker="project" className="inline-flex min-w-0 items-center gap-1.5">
            {props.project ? (
              <ProjectFavicon project={props.project} className="size-4 shrink-0" />
            ) : null}
            {props.projectDisplayName ? (
              <span className="min-w-0 truncate font-normal text-secondary-label text-xs">
                {props.projectDisplayName}
              </span>
            ) : null}
          </span>
        ) : props.project ? (
          <span
            data-row-marker="project"
            className={cn(
              "flex shrink-0 items-center transition-opacity",
              (!props.isActive || variantAction === "unsettle") &&
                "opacity-40 grayscale group-focus-within/sidebar-row:opacity-100 group-focus-within/sidebar-row:grayscale-0 group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
            )}
          >
            <ProjectFavicon project={props.project} className="size-4" />
          </span>
        ) : null;
      case "tags":
        return tagChips ? (
          <span
            data-row-marker="tags"
            className={cn(
              "inline-flex shrink-0 items-center",
              layout === "inline" ? "max-w-[40%]" : "min-w-0 max-w-full",
            )}
          >
            {tagChips}
          </span>
        ) : null;
      case "color":
        return thread.color != null ? (
          <span
            data-row-marker="color"
            aria-hidden
            className={cn("size-2 shrink-0 rounded-full", threadColorDotClass[thread.color])}
          />
        ) : null;
      case "notifications":
        return thread.notificationLevel === "muted" ? (
          <span data-row-marker="notifications" className="inline-flex shrink-0 items-center">
            <BellOffIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          </span>
        ) : thread.notificationLevel === "following" ? (
          <span data-row-marker="notifications" className="inline-flex shrink-0 items-center">
            <BellIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          </span>
        ) : null;
      case "provider":
        return (
          <span
            data-row-marker="provider"
            aria-hidden
            className="inline-flex shrink-0 items-center"
          >
            <SidebarProviderStack
              thread={thread}
              providerEntryByInstanceId={props.providerEntryByInstanceId}
            />
          </span>
        );
    }
  };

  const metaLineEmpty = issueBadge === null;
  const metaLine = metaLineEmpty ? null : (
    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
      {issueBadge}
    </div>
  );

  if (variant !== "card") {
    return (
      <li
        data-thread-item={copy ? undefined : threadKey}
        {...sortableRootProps}
        {...(fileDropHandlers ?? {})}
        className={cn(
          "list-none [content-visibility:auto]",
          // A fixed-height row reserves its exact density height; `auto` would keep a stale one.
          !multiline
            ? "[contain-intrinsic-size:none_var(--sidebar-thread-row-height)]"
            : metaLine !== null
              ? "[contain-intrinsic-size:auto_--spacing(13.5)]"
              : "[contain-intrinsic-size:auto_--spacing(9)]",
          sortable?.isDragging && "relative z-20",
        )}
      >
        <ThreadHoverCardTrigger
          card={detailsTooltip}
          disabled={isRenaming || sortable?.isDragging}
          render={
            <div
              ref={rowRef}
              role="button"
              tabIndex={0}
              data-sidebar-row={rowId}
              data-sidebar-parent={props.navigationParent}
              aria-label={[
                accessibility.label,
                preferenceLabels.color,
                preferenceLabels.notifications,
              ]
                .filter(Boolean)
                .join(", ")}
              aria-current={accessibility.current}
              data-testid={
                indented ? "sidebar-row-folder" : inFolder ? "sidebar-row-line" : "sidebar-row-slim"
              }
              aria-busy={isRegeneratingTitle || undefined}
              className={cn(
                rowSurfaceClassName,
                multiline
                  ? "flex flex-col justify-center px-2.5 py-1.5"
                  : "flex h-(--sidebar-thread-row-height) items-center gap-2.5 px-2.5",
                // Lines titles up with the folder name, past its chevron and icon.
                indented && (props.inMachineFolder && props.inProjectFolder ? "ps-15.5" : "ps-9"),
              )}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onKeyDown={handleKeyDown}
              onPointerEnter={intentPrefetch.onPointerEnter}
              onPointerLeave={intentPrefetch.onPointerLeave}
              onPointerDown={intentPrefetch.onPointerDown}
              onContextMenu={handleContextMenu}
            />
          }
        >
          {/* `contents` keeps one-line rows a single flex row. */}
          <div className={multiline ? "flex h-6 min-w-0 items-center gap-2.5" : "contents"}>
            {renderedMarkerKind === "project" ? renderPrimaryMarker("project", "inline") : null}
            {title}
            {renderedMarkerKind !== null && renderedMarkerKind !== "project"
              ? renderPrimaryMarker(renderedMarkerKind, "inline")
              : null}
            {variant === "line" && pinIndicator !== null ? (
              // One-line pinned rows sit under the Pinned header, so the pin shows as Unpin on hover.
              <span className="inline-flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-any-hover/sidebar-row:opacity-100 group-focus-visible/sidebar-row:opacity-100 motion-reduce:transition-none">
                {pinIndicator}
              </span>
            ) : canPinOnHover ? (
              // The slot is always reserved so revealing Pin never moves the title.
              <span className="inline-flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-any-hover/sidebar-row:opacity-100 group-focus-visible/sidebar-row:opacity-100 motion-reduce:transition-none">
                {renderPinButton(
                  "inline-flex cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  "size-3 shrink-0",
                )}
              </span>
            ) : null}
            {isRegeneratingTitle ? (
              <span role="status" className="sr-only">
                {t("Regenerating title")}
              </span>
            ) : null}
            {sortable?.isDragging ? (
              dragDestination
            ) : (
              <span
                className={cn(
                  "relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end",
                  props.sweepAction !== null && "hidden",
                  jumpHintLabel && JUMP_HINT_SLOT_CLASS_NAME,
                )}
              >
                <span
                  className={cn(
                    "inline-flex justify-end tabular-nums text-secondary-label transition-opacity",
                    !isWoke && "group-any-hover/sidebar-row:opacity-0",
                  )}
                >
                  {pendingSync ? (
                    <PendingSyncLabel />
                  ) : variantAction === "unsnooze" && props.snoozeWakeLabelText !== null ? (
                    <span className="inline-flex items-center gap-1 text-xs text-info-foreground calm:text-calm-quiet tabular-nums">
                      {/* The clock tells a wake time from an age at a glance. */}
                      <AlarmClockIcon aria-hidden className="size-3" />
                      {props.snoozeWakeLabelText}
                    </span>
                  ) : (inFolder ? isWokeStatus : isWoke) ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label={t("Dismiss Woke notification")}
                            onClick={handleAcknowledgeWokeClick}
                            className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs font-medium text-warning-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          >
                            <AlarmClockIcon aria-hidden className="size-3" />
                            <span role="status">{t("Woke")}</span>
                          </button>
                        }
                      />
                      <TooltipPopup side="top">{t("Dismiss Woke notification")}</TooltipPopup>
                    </Tooltip>
                  ) : inFolder && topStatus ? (
                    // Folder rows have no status line, so the status takes the time slot.
                    <span
                      data-row-marker={
                        statusCoversPrimary ? (pickedMarkers.primary ?? undefined) : undefined
                      }
                      className={cn(
                        "inline-flex items-center gap-1 text-xs font-medium",
                        topStatus.className,
                      )}
                    >
                      <ThreadRowStatusContent status={topStatus} iconClassName="size-3" />
                      {/* The Working shelf's one-line rows keep the elapsed time its cards showed. */}
                      {stall !== null && statusIsLive ? (
                        <span className="font-normal">
                          <QuietSinceLabel since={stall.lastEventAt} />
                        </span>
                      ) : variant === "line" && status === "working" && statusIsLive ? (
                        <span aria-hidden className="font-normal">
                          <WorkingDuration
                            environmentId={thread.environmentId}
                            startedAt={resolveWorkingStartedAt(thread)}
                          />
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-xs">
                      <RelativeTimeLabel
                        timestamp={
                          variantAction === "unsettle"
                            ? resolveSettledThreadTimestamp(thread)
                            : resolveThreadActivityTimestamp(thread)
                        }
                      />
                    </span>
                  )}
                </span>
                {variantAction === "unsnooze" ? (
                  !props.snoozeSupported || !canTriageThread ? null : (
                    <button
                      type="button"
                      aria-label={t("Wake thread now")}
                      onClick={handleUnsnoozeClick}
                      onPointerDown={handleActionPointerDown}
                      className={cn(
                        "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                        isWoke && "group-any-hover/sidebar-row:static",
                      )}
                    >
                      <AlarmClockOffIcon className="mb-px size-3" />
                    </button>
                  )
                ) : !settlementSupported ? null : variantAction === "unsettle" ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label={t("Un-settle thread")}
                          onClick={handleUnsettleClick}
                          onPointerDown={handleActionPointerDown}
                          className={cn(
                            "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                            isWoke && "group-any-hover/sidebar-row:static",
                          )}
                        />
                      }
                    >
                      <Undo2Icon className="mb-px size-3.5" />
                    </TooltipTrigger>
                    <TooltipPopup side="top">{t("Un-settle thread")}</TooltipPopup>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label={t("Settle thread")}
                          onClick={handleSettleClick}
                          onPointerDown={handleActionPointerDown}
                          className={cn(
                            "pointer-events-none absolute inset-y-0 right-0 -mr-2 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                            isWoke && "group-any-hover/sidebar-row:static",
                          )}
                        />
                      }
                    >
                      <CheckIcon className="size-3" />
                    </TooltipTrigger>
                    <TooltipPopup side="top">{t("Settle thread")}</TooltipPopup>
                  </Tooltip>
                )}
                {jumpHintLabel ? <JumpHintBadge label={jumpHintLabel} /> : null}
              </span>
            )}
            {props.sweepAction !== null ? dragDestination : null}
          </div>
          {multiline ? metaLine : null}
        </ThreadHoverCardTrigger>
      </li>
    );
  }

  return (
    <li
      data-thread-item={copy ? undefined : threadKey}
      {...sortableRootProps}
      {...(fileDropHandlers ?? {})}
      // The hints are the rendered heights inside py-0.5. Revealing the open thread measures rows
      // that have not rendered yet, so a hint off by a pixel lands it a pixel short per row above.
      className={cn(
        "list-none py-(--sidebar-row-gap) [content-visibility:auto] [contain-intrinsic-size:auto_var(--sidebar-thread-card-height)]",
        metaLineEmpty && "[contain-intrinsic-size:auto_60px]",
        sortable?.isDragging && "relative z-20",
      )}
    >
      <ThreadHoverCardTrigger
        card={detailsTooltip}
        disabled={isRenaming || snoozeMenuOpen || sortable?.isDragging}
        render={
          <div
            ref={rowRef}
            role="button"
            tabIndex={0}
            data-sidebar-row={rowId}
            data-sidebar-parent={props.navigationParent}
            aria-label={[
              accessibility.label,
              preferenceLabels.color,
              preferenceLabels.notifications,
            ]
              .filter(Boolean)
              .join(", ")}
            aria-current={accessibility.current}
            data-testid="sidebar-row-card"
            aria-busy={isRegeneratingTitle || undefined}
            className={rowSurfaceClassName}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            onKeyDown={handleKeyDown}
            onPointerEnter={intentPrefetch.onPointerEnter}
            onPointerLeave={intentPrefetch.onPointerLeave}
            onPointerDown={intentPrefetch.onPointerDown}
            onContextMenu={handleContextMenu}
          />
        }
      >
        <div
          className={cn(
            "relative z-10 h-(--sidebar-thread-card-height) px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)",
            metaLineEmpty && "h-auto",
          )}
        >
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            {renderedMarkerKind !== null ? (
              <span className="flex min-w-0 flex-1 items-center">
                {renderPrimaryMarker(renderedMarkerKind, "card")}
              </span>
            ) : (
              <span className="flex-1" />
            )}
            {sortable?.isDragging ? (
              dragDestination
            ) : (
              <span
                className={cn(
                  "group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs",
                  props.sweepAction !== null && "hidden",
                  jumpHintLabel && JUMP_HINT_SLOT_CLASS_NAME,
                )}
              >
                <span
                  className={cn(
                    isWokeStatus
                      ? "pointer-events-auto"
                      : "pointer-events-none group-has-[:focus-visible]/sidebar-status-slot:absolute group-has-[:focus-visible]/sidebar-status-slot:right-0 group-has-[:focus-visible]/sidebar-status-slot:opacity-0 group-any-hover/sidebar-row:absolute group-any-hover/sidebar-row:right-0 group-any-hover/sidebar-row:opacity-0",
                    "flex items-center self-center justify-self-end tabular-nums text-secondary-label",
                    snoozeMenuOpen && "pointer-events-none absolute right-0 opacity-0",
                  )}
                >
                  {topStatus ? (
                    isWokeStatus ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              aria-label={t("Dismiss Woke notification")}
                              onClick={handleAcknowledgeWokeClick}
                              className={cn(
                                "inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                                topStatus.className,
                              )}
                            >
                              <AlarmClockIcon aria-hidden className="size-4 shrink-0" />
                              <span role="status">{topStatus.label}</span>
                            </button>
                          }
                        />
                        <TooltipPopup side="top">{t("Dismiss Woke notification")}</TooltipPopup>
                      </Tooltip>
                    ) : (
                      <span
                        data-row-marker={
                          statusCoversPrimary ? (pickedMarkers.primary ?? undefined) : undefined
                        }
                        className={cn(
                          "inline-flex items-center gap-1 font-medium",
                          topStatus.className,
                        )}
                      >
                        {/* Not a live region: a collapsed sidebar is inert, so
                            BackgroundThreadAnnouncer and the open thread's
                            timeline speak status changes instead. */}
                        <ThreadRowStatusContent status={topStatus} iconClassName="size-4" />
                        {!statusIsLive ? null : stall !== null ? (
                          <span className="font-normal">
                            <QuietSinceLabel since={stall.lastEventAt} />
                          </span>
                        ) : props.waitingSince != null ? (
                          <span className="font-normal">
                            <WaitingSinceLabel since={props.waitingSince} />
                          </span>
                        ) : status === "working" ? (
                          <span aria-hidden>
                            <WorkingDuration
                              environmentId={thread.environmentId}
                              startedAt={resolveWorkingStartedAt(thread)}
                            />
                          </span>
                        ) : status === "waiting" ? (
                          <span aria-hidden>
                            <WorkingDuration
                              environmentId={thread.environmentId}
                              startedAt={thread.latestRun?.completedAt ?? null}
                            />
                          </span>
                        ) : null}
                      </span>
                    )
                  ) : (
                    <RelativeTimeLabel timestamp={resolveThreadActivityTimestamp(thread)} />
                  )}
                </span>
                {settlementSupported || showSnoozeButton || hasUnsentDraft || canPinOnHover ? (
                  <span
                    className={cn(
                      // Mouse clicks leave Settle focused; focus-within would pin controls over
                      // the status label after the pointer leaves. Use focus-visible instead.
                      "pointer-events-none absolute inset-y-0 right-0 flex items-stretch opacity-0 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:static has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:static group-any-hover/sidebar-row:opacity-100",
                      snoozeMenuOpen && "pointer-events-auto static opacity-100",
                    )}
                  >
                    {hasUnsentDraft ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              aria-label={t("Discard draft")}
                              onClick={handleDiscardDraftClick}
                              className="inline-flex cursor-pointer items-center rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                            />
                          }
                        >
                          <XIcon className="size-3.5" />
                        </TooltipTrigger>
                        <TooltipPopup side="top">{t("Discard draft")}</TooltipPopup>
                      </Tooltip>
                    ) : null}
                    {canPinOnHover
                      ? renderPinButton(
                          "inline-flex cursor-pointer items-center rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground",
                          "size-3.5",
                        )
                      : null}
                    {showSnoozeButton ? (
                      <SnoozeMenuButton
                        open={snoozeMenuOpen}
                        onOpenChange={setSnoozeMenuOpen}
                        onSnooze={handleSnoozePreset}
                        timestampFormat={props.timestampFormat}
                        environmentId={thread.environmentId}
                      />
                    ) : null}
                    {settlementSupported ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              aria-label={t("Settle thread")}
                              onClick={handleSettleClick}
                              onPointerDown={handleActionPointerDown}
                              className="-mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                            />
                          }
                        >
                          <CheckIcon className="size-3.5" />
                          {t("Settle")}
                        </TooltipTrigger>
                        <TooltipPopup>{t("Settle thread")}</TooltipPopup>
                      </Tooltip>
                    ) : null}
                  </span>
                ) : null}
                {jumpHintLabel ? <JumpHintBadge label={jumpHintLabel} /> : null}
              </span>
            )}
            {props.sweepAction !== null ? dragDestination : null}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5">
            {title}
            {isRegeneratingTitle ? (
              <span role="status" className="sr-only">
                {t("Regenerating title")}
              </span>
            ) : null}
          </div>
          {metaLine}
        </div>
      </ThreadHoverCardTrigger>
    </li>
  );
});

// Attached only to the highlighted result, so React calls it each time the
// highlight lands on a different row: a new query, late rows replacing the first
// result, or arrow keys moving past the scrolled edge.
const scrollHighlightedResultIntoView = (node: HTMLLIElement | null) => {
  node?.scrollIntoView({ block: "nearest" });
};

export const SidebarSearchResultRow = memo(function SidebarSearchResultRow(props: {
  isSettled: boolean;
  thread: SidebarThreadSummary;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  isHighlighted: boolean;
  isRouteActive: boolean;
  resultId: string;
  searchMatch: EnvironmentThreadSearchMatch | null;
  searchQuery: string;
  /** The query `searchMatch` was found for, which lags `searchQuery` while a search runs. */
  searchMatchQuery?: string;
  onHighlight: () => void;
  onSelect: () => void;
  onContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
}) {
  const thread =
    useThreadShell(scopeThreadRef(props.thread.environmentId, props.thread.id)) ?? props.thread;
  const preferenceLabels = threadPreferenceLabels(thread);
  const accessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel: null,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isRouteActive,
  });
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  // Results only drag out as chat context; the row keeps its own listbox attributes.
  const { listeners: dragListeners, setNodeRef: setDragNodeRef } = useDraggable({
    id: scopedThreadKey(threadRef),
  });
  const { leaseLiveStatus, rowRef: leaseRowRef } = useSidebarRowSubscriptionLease(
    props.isHighlighted || props.isRouteActive,
  );
  const isRegeneratingTitle = thread.titleRegeneration != null;
  const rowRef = (row: HTMLElement | null) => {
    setDragNodeRef(row);
    return leaseRowRef(row);
  };
  const gitCwd = thread.worktreePath ?? props.project?.workspaceRoot ?? null;
  const branchTarget =
    leaseLiveStatus && (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? { environmentId: thread.environmentId, cwd: gitCwd }
      : null;
  const gitStatus = useEnvironmentQuery(
    branchTarget === null
      ? null
      : vcsEnvironment.branch({
          environmentId: branchTarget.environmentId,
          input: { cwd: branchTarget.cwd },
        }),
  );
  useAtomMount(vcsBranchRevalidation(branchTarget));
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const checkoutThread = withoutRemovedCheckout(thread, visibleGitStatus, props.project);
  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: visibleGitStatus?.refName ?? null,
  });
  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelName(selectedModel, providerEntry?.driverKind)
    : thread.modelSelection.model;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds, t);
  const scheduledTasks = useThreadScheduledTasks(thread.environmentId, thread.id);
  const status = resolveSidebarRowStatus(thread);
  const pickedMarkers = resolveSidebarRowMarkers(
    {
      status,
      hasPr: false,
      machineUnreachable: false,
      hasUnsentDraft: false,
      hasQueuedMessages: false,
      hasRunningTerminal: runningTerminalIds.length > 0,
      hasScheduledTask: scheduledTasks.length > 0,
      showPin: thread.pinnedAt != null,
      hasMachineBadge: false,
      hasProject: props.project !== null,
      hasTags: Boolean(thread.source.tags?.length),
      hasColor: thread.color != null,
      hasNotificationPreference:
        thread.notificationLevel === "muted" || thread.notificationLevel === "following",
      hasProvider: providerEntry !== null,
    },
    { machine: false, project: false },
  );
  const renderSearchMarker = (kind: RowMarkerKind): ReactNode => {
    switch (kind) {
      case "needsYou":
        return (
          <CircleAlertIcon
            aria-hidden
            data-row-marker="needsYou"
            className="size-3.5 shrink-0 text-warning-foreground"
          />
        );
      case "failed":
        return (
          <CircleAlertIcon
            aria-hidden
            data-row-marker="failed"
            className="size-3.5 shrink-0 text-error-foreground"
          />
        );
      case "terminal":
        return terminalStatus ? (
          <TerminalIcon
            aria-hidden
            data-row-marker="terminal"
            className={cn("size-3.5 shrink-0", terminalStatus.colorClass)}
          />
        ) : null;
      case "scheduled":
        return (
          <CalendarClockIcon
            aria-hidden
            data-row-marker="scheduled"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        );
      case "pinned":
        return (
          <PinIcon
            aria-hidden
            data-row-marker="pinned"
            className="size-3 shrink-0 text-muted-foreground/65"
          />
        );
      case "project":
        return props.project ? (
          <span data-row-marker="project" className="inline-flex shrink-0 items-center">
            <ProjectFavicon
              project={props.project}
              className={cn(
                "size-4 shrink-0 transition-opacity",
                props.isSettled &&
                  !props.isRouteActive &&
                  !props.isHighlighted &&
                  "opacity-40 grayscale group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
              )}
            />
          </span>
        ) : null;
      case "tags":
        return (
          <TagIcon
            aria-hidden
            data-row-marker="tags"
            className="size-3 shrink-0 text-muted-foreground"
          />
        );
      case "color":
        return thread.color != null ? (
          <span
            aria-hidden
            data-row-marker="color"
            className={cn("size-2 shrink-0 rounded-full", threadColorDotClass[thread.color])}
          />
        ) : null;
      case "notifications":
        return thread.notificationLevel === "muted" ? (
          <BellOffIcon
            aria-hidden
            data-row-marker="notifications"
            className="size-3 shrink-0 text-muted-foreground"
          />
        ) : thread.notificationLevel === "following" ? (
          <BellIcon
            aria-hidden
            data-row-marker="notifications"
            className="size-3 shrink-0 text-muted-foreground"
          />
        ) : null;
      case "provider":
        return (
          <span
            aria-hidden
            data-row-marker="provider"
            className="inline-flex shrink-0 items-center"
          >
            <SidebarProviderStack
              thread={thread}
              providerEntryByInstanceId={props.providerEntryByInstanceId}
            />
          </span>
        );
      case "pr":
      case "machineOffline":
      case "draft":
      case "queued":
      case "machine":
        return null;
    }
  };
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const onFileDropThreads = props.onFileDropThreads;
  const fileDropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive: (active) => setFileDragActive(setIsFileDragOver, active),
    addFiles: (files) => {
      onFileDropThreads(threadRef, files);
    },
    addFolders: () => {},
  });
  return (
    <li
      ref={props.isHighlighted ? scrollHighlightedResultIntoView : undefined}
      role="presentation"
      className="list-none"
      {...fileDropHandlers}
    >
      <ThreadHoverCardTrigger
        card={
          <SidebarThreadTooltip
            thread={checkoutThread}
            project={props.project}
            projectDisplayName={props.projectDisplayName}
            environmentLabel={props.environmentLabel}
            environmentMachine={props.environmentMachine}
            providerEntry={providerEntry}
            providerEntryByInstanceId={props.providerEntryByInstanceId}
            showInstanceBadge={showInstanceBadge}
            modelInstanceId={modelInstanceId}
            modelLabel={modelLabel}
            branchMismatch={branchMismatch}
            terminalStatus={terminalStatus}
            terminalProcessCount={runningTerminalIds.length}
            overflowMarkers={pickedMarkers.overflow}
            scheduledTasks={scheduledTasks}
            preferenceLabels={preferenceLabels}
          />
        }
        render={
          <button
            ref={rowRef}
            id={props.resultId}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={props.isHighlighted}
            aria-current={accessibility.current}
            aria-describedby={`${props.resultId}-pr`}
            aria-label={[
              accessibility.label,
              preferenceLabels.color,
              preferenceLabels.notifications,
            ]
              .filter(Boolean)
              .join(", ")}
            {...dragListeners}
            onMouseMove={props.onHighlight}
            // Focus stays in the search box, as for Enter. A focused result would lose focus as
            // the results close, and its recovery scrolls the list away from the opened thread.
            // dnd-kit ignores a prevented press, so the drag listener runs first.
            onPointerDown={(event) => {
              dragListeners?.onPointerDown?.(event);
              event.preventDefault();
            }}
            onClick={props.onSelect}
            onContextMenu={(event) => {
              event.preventDefault();
              props.onContextMenu(
                threadRef,
                { x: event.clientX, y: event.clientY },
                contextMenuSourceOf(event),
              );
            }}
            className={cn(
              "group/sidebar-row group/v2-row flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1 text-left text-sm outline-none",
              props.isHighlighted || props.isRouteActive
                ? "bg-sidebar-row-active text-sidebar-foreground"
                : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
              isFileDragOver && "ring-1 ring-inset ring-primary/70",
              isFileDragOver && !props.isRouteActive && "bg-sidebar-row-hover",
            )}
          />
        }
      >
        {pickedMarkers.primary ? renderSearchMarker(pickedMarkers.primary) : null}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2.5">
            <span
              ref={isRegeneratingTitle ? observeVisibleAnimation : undefined}
              className={cn(
                "min-w-0 flex-1 truncate",
                props.isSettled ? "font-normal" : "font-medium",
                isRegeneratingTitle
                  ? "relative text-muted-foreground"
                  : props.isSettled && !props.isHighlighted && !props.isRouteActive
                    ? "text-secondary-label/70 group-hover/sidebar-row:text-foreground"
                    : "text-foreground",
              )}
            >
              {thread.title}
              {isRegeneratingTitle ? (
                <ActivityShimmerOverlay className="truncate">{thread.title}</ActivityShimmerOverlay>
              ) : null}
            </span>
            <span id={`${props.resultId}-pr`} className="contents">
              <ThreadSearchPullRequestNumber
                thread={thread}
                query={props.searchQuery}
                enabled={leaseLiveStatus}
                settled={props.isSettled}
              />
            </span>
            <span className="min-w-8 shrink-0 text-right text-xs text-muted-foreground/55 tabular-nums">
              <RelativeTimeLabel timestamp={resolveThreadActivityTimestamp(thread)} />
            </span>
          </span>
          {props.searchMatch ? (
            <ThreadSearchMatchExcerpt
              match={{
                source: props.searchMatch.source,
                snippet: props.searchMatch.snippet,
                query: props.searchMatchQuery ?? props.searchQuery,
              }}
            />
          ) : null}
        </span>
      </ThreadHoverCardTrigger>
    </li>
  );
});

const threadColorDotClass = {
  red: "bg-red-600 dark:bg-red-400",
  orange: "bg-orange-600 dark:bg-orange-400",
  yellow: "bg-yellow-700 dark:bg-yellow-400",
  green: "bg-green-600 dark:bg-green-400",
  blue: "bg-blue-600 dark:bg-blue-400",
  purple: "bg-purple-600 dark:bg-purple-400",
  gray: "bg-gray-600 dark:bg-gray-400",
} satisfies Record<ThreadColor, string>;
