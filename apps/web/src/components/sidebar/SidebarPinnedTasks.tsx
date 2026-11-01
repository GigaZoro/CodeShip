import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  collectPinnedTasks,
  formatNextRunCountdown,
  intervalWaitProgress,
  pinnedTaskRunThreadId,
  resolvePinnedTaskStatus,
  type PinnedTaskStatus,
} from "@t3tools/client-runtime/scheduled-task-pins";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ContextMenuItem,
  EnvironmentId,
  ScheduledTask,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { AuthOrchestrationOperateScope, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  CalendarClockIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  MessageCircleQuestionIcon,
  PauseIcon,
  PinOffIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { useNowSecond } from "../../hooks/useNowSecond";
import { useSetScheduledTaskPinned } from "../../hooks/useSetScheduledTaskPinned";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { scheduleLabel } from "../settings/ScheduledTasksSettings";
import {
  resolveSidebarRowAccessibility,
  resolveSidebarThreadStatus,
  resolveWorkingStartedAt,
} from "../Sidebar.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkingDuration } from "./SidebarThreadRow";

const pinnedTasksAtom = Atom.family((environmentIdsKey: string) =>
  Atom.make((get) =>
    collectPinnedTasks(
      JSON.parse(environmentIdsKey) as ReadonlyArray<EnvironmentId>,
      (environmentId) =>
        AsyncResult.getOrElse(
          get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} })),
          () => null,
        )?.tasks ?? [],
    ),
  ).pipe(Atom.withLabel(`web:sidebar-pinned-tasks:${environmentIdsKey}`)),
);

const STATUS_DISPLAY: Record<
  Exclude<PinnedTaskStatus, "idle">,
  { readonly label: string; readonly icon: typeof CircleDashedIcon; readonly className: string }
> = {
  starting: { label: "Starting", icon: CircleDashedIcon, className: "text-info-foreground" },
  working: { label: "Working", icon: CircleDashedIcon, className: "text-info-foreground" },
  approval: { label: "Approval", icon: ShieldQuestionIcon, className: "text-warning-foreground" },
  input: {
    label: "Input",
    icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  failed: { label: "Failed", icon: CircleAlertIcon, className: "text-error-foreground" },
  paused: { label: "Paused", icon: PauseIcon, className: "text-muted-foreground" },
};

type PinnedTaskMenuId = "open-run" | "edit" | "run-now" | "unpin";

// Each ticks once a second on the shared clock, so only these spans re-render.
function NextRunCountdown(props: { nextRunAt: string }) {
  return (
    <span className="tabular-nums">{formatNextRunCountdown(props.nextRunAt, useNowSecond())}</span>
  );
}

function IntervalWaitBar(props: { task: ScheduledTask }) {
  const progress = intervalWaitProgress(props.task, useNowSecond());
  if (progress === null) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-(--sidebar-row-content-inset) bottom-1 h-0.5 overflow-hidden rounded-full bg-sidebar-foreground/10"
    >
      <span
        className="block h-full origin-left bg-info-foreground/60"
        style={{ transform: `scaleX(${progress})` }}
      />
    </span>
  );
}

const SidebarPinnedTaskRow = memo(function SidebarPinnedTaskRow(props: {
  environmentId: EnvironmentId;
  task: ScheduledTask;
  projectDisplayName: string | null;
  routeThreadKey: string | null;
  onNavigateToThread: (threadRef: ScopedThreadRef) => void;
}) {
  const { environmentId, task, onNavigateToThread } = props;
  const navigate = useNavigate();
  const canOperate = useAtomValue(
    serverEnvironment.setScheduledTaskPinned.permissionAtom(environmentId),
  );
  const setPinned = useSetScheduledTaskPinned();
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "sidebar scheduled task run now",
  });
  const runThreadId = pinnedTaskRunThreadId(task);
  const runThreadRef =
    runThreadId === null ? null : scopeThreadRef(environmentId, ThreadId.make(runThreadId));
  const runThread = useQuietThreadShell(runThreadRef);
  const status = resolvePinnedTaskStatus(
    task,
    runThread === null
      ? null
      : {
          status: resolveSidebarThreadStatus(runThread),
          runtimeStatus: runThread.runtime?.status ?? null,
        },
  );
  const display = status === "idle" ? null : STATUS_DISPLAY[status];
  const isActive = runThreadRef !== null && scopedThreadKey(runThreadRef) === props.routeThreadKey;
  const accessibility = resolveSidebarRowAccessibility({
    title: task.title,
    statusLabel: display?.label ?? null,
    projectDisplayName: props.projectDisplayName,
    isActive,
  });

  const openSettings = () =>
    void navigate({
      to: "/scheduled-tasks",
      search: { environmentId, taskId: task.id },
    });
  const openRun = () => {
    if (runThread !== null && runThreadRef !== null) onNavigateToThread(runThreadRef);
    else openSettings();
  };
  const showMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const items: ContextMenuItem<PinnedTaskMenuId>[] = [
      ...(runThread !== null
        ? [{ id: "open-run" as const, label: "Open last run", icon: "message-square" }]
        : []),
      { id: "edit", label: "Edit task", icon: "pencil" },
      // Webhook tasks run only when their URL receives a request.
      ...(task.schedule.type === "webhook"
        ? []
        : [
            {
              id: "run-now" as const,
              label: "Run now",
              icon: "refresh-cw",
              disabled: !canOperate || status === "starting",
            },
          ]),
      {
        id: "unpin",
        label: "Unpin from sidebar",
        icon: "pin-off",
        disabled: !canOperate,
        separatorBefore: true,
      },
    ];
    const clicked = await settlePromise(() => api.contextMenu.show(items, position));
    if (clicked._tag === "Failure") return;
    switch (clicked.value) {
      case "open-run":
        openRun();
        return;
      case "edit":
        openSettings();
        return;
      case "run-now": {
        if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
        const result = await runNow({ environmentId, input: { id: task.id } });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not run task",
              description: String(squashAtomCommandFailure(result)),
            }),
          );
        }
        return;
      }
      case "unpin":
        await setPinned(environmentId, task, false);
        return;
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      void showMenu({ x: rect.left, y: rect.bottom });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openRun();
    }
  };
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    void showMenu({ x: event.clientX, y: event.clientY });
  };
  const handleUnpin = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void setPinned(environmentId, task, false);
  };

  const StatusIcon = display?.icon;
  return (
    <li className="list-none py-0.5">
      <div
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={`task:${environmentId}:${task.id}`}
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        data-testid="sidebar-pinned-task-row"
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isActive ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
        onClick={openRun}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
      >
        <div className="relative px-(--sidebar-row-content-inset) pt-(--sidebar-content-inset) pb-2.5">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <CalendarClockIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
              {task.title}
            </span>
            {display !== null && StatusIcon !== undefined ? (
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 text-xs font-medium",
                  display.className,
                )}
              >
                <StatusIcon aria-hidden className="size-3.5 shrink-0" />
                {display.label}
                {status === "working" && runThread !== null ? (
                  <span aria-hidden>
                    <WorkingDuration startedAt={resolveWorkingStartedAt(runThread)} />
                  </span>
                ) : null}
              </span>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Unpin ${task.title} from sidebar`}
                    disabled={!canOperate}
                    onClick={handleUnpin}
                    className="pointer-events-none inline-flex shrink-0 cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100 motion-reduce:transition-none"
                  >
                    <PinOffIcon className="size-3.5" />
                  </button>
                }
              />
              <TooltipPopup side="top">Unpin from sidebar</TooltipPopup>
            </Tooltip>
          </div>
          <div className="mt-0.5 truncate pl-5 text-xs text-muted-foreground">
            {scheduleLabel(task.schedule)}
            {task.enabled && task.nextRunAt !== null ? (
              <>
                {" · next "}
                <NextRunCountdown nextRunAt={task.nextRunAt} />
              </>
            ) : null}
          </div>
        </div>
        {status === "idle" || status === "failed" ? <IntervalWaitBar task={task} /> : null}
      </div>
    </li>
  );
});

/** Pinned scheduled tasks above the thread list, with each one's run and countdown. */
export const SidebarPinnedTasksBlock = memo(function SidebarPinnedTasksBlock(props: {
  /** JSON array of environment ids, so the prop stays equal across renders. */
  environmentIdsKey: string;
  scopedProjectKeys: ReadonlySet<string> | null;
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  routeThreadKey: string | null;
  onNavigateToThread: (threadRef: ScopedThreadRef) => void;
}) {
  const entries = useAtomValue(pinnedTasksAtom(props.environmentIdsKey)).filter(
    ({ environmentId, task }) =>
      props.scopedProjectKeys === null ||
      props.scopedProjectKeys.has(`${environmentId}:${task.projectId}`),
  );
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map(({ environmentId, task }) => (
        <SidebarPinnedTaskRow
          key={`${environmentId}:${task.id}`}
          environmentId={environmentId}
          task={task}
          projectDisplayName={
            props.projectDisplayNameByKey.get(`${environmentId}:${task.projectId}`) ?? null
          }
          routeThreadKey={props.routeThreadKey}
          onNavigateToThread={props.onNavigateToThread}
        />
      ))}
      <li
        aria-hidden
        data-testid="sidebar-pinned-tasks-divider"
        className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
      />
    </>
  );
});
