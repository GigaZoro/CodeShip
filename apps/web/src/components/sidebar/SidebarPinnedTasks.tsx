import {
  resolveThreadStatus,
  THREAD_STATUS_DISPLAY,
} from "@t3tools/client-runtime/state/thread-status";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  applyHeldPinOrder,
  collectPinnedTasks,
  formatLastRunAgo,
  formatNextRunCountdown,
  holdPinOrder,
  intervalWaitProgress,
  pinnedTaskKey,
  pinnedTaskRunThreadId,
  planPinnedTaskMove,
  resolvePinnedTaskStatus,
  type HeldPinOrder,
  resolveScheduledTaskPlacement,
  scheduledTaskPlacementOptions,
  scheduledTaskHiddenThreadKeys,
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
  EnvironmentMachineKind,
  ScheduledTask,
  ScheduledTaskPlacement,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { AuthOrchestrationOperateScope, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import {
  CalendarClockIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  MessageCircleQuestionIcon,
  PauseIcon,
  PinOffIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
} from "lucide-react";
import {
  memo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { useNowSecond } from "../../hooks/useNowSecond";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  supportsScheduledTaskPlacement,
  useSetScheduledTaskPlacement,
} from "../../hooks/useSetScheduledTaskPlacement";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ScheduledTaskRunsDialog } from "../settings/ScheduledTaskRunsDialog";
import { scheduleLabel } from "../settings/ScheduledTasksSettings";
import { resolveSidebarRowAccessibility, resolveWorkingStartedAt } from "../Sidebar.logic";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkingDuration } from "./SidebarThreadRow";
import { THREAD_ROW_TONE_CLASS } from "./threadRowStatus";

import { t } from "~/i18n";
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

const hiddenThreadKeysAtom = Atom.family((environmentIdsKey: string) => {
  let previous: ReadonlySet<string> = new Set();
  return Atom.make((get) => {
    previous = scheduledTaskHiddenThreadKeys(
      JSON.parse(environmentIdsKey) as ReadonlyArray<EnvironmentId>,
      (environmentId) =>
        AsyncResult.getOrElse(
          get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} })),
          () => null,
        )?.tasks ?? [],
      previous,
    );
    return previous;
  }).pipe(Atom.withLabel(`web:sidebar-hidden-task-threads:${environmentIdsKey}`));
});

/** Scoped keys of the threads that scheduled tasks placed nowhere in the thread list. */
export function useScheduledTaskHiddenThreadKeys(environmentIdsKey: string): ReadonlySet<string> {
  return useAtomValue(hiddenThreadKeysAtom(environmentIdsKey));
}

const STATUS_ICON: Record<Exclude<PinnedTaskStatus, "idle">, typeof CircleDashedIcon> = {
  starting: CircleDashedIcon,
  working: CircleDashedIcon,
  approval: ShieldQuestionIcon,
  input: MessageCircleQuestionIcon,
  request: UserRoundIcon,
  failed: CircleAlertIcon,
  limited: CircleAlertIcon,
  paused: PauseIcon,
};

function pinnedTaskStatusDisplay(status: Exclude<PinnedTaskStatus, "idle">) {
  const display = THREAD_STATUS_DISPLAY[status];
  return {
    label: display.label,
    icon: STATUS_ICON[status],
    className: THREAD_ROW_TONE_CLASS[display.tone],
  };
}

type PinnedTaskMenuId =
  | "open-run"
  | "edit"
  | "run-now"
  | "run-history"
  | "move-up"
  | "move-down"
  | "show-in"
  | `place:${ScheduledTaskPlacement}`;

// Module constants keep dnd-kit's sensor and modifier inputs stable across renders.
const PINNED_TASK_POINTER_OPTIONS = { activationConstraint: { distance: 6 } };
const PINNED_TASK_DRAG_MODIFIERS = [restrictToVerticalAxis, restrictToFirstScrollableAncestor];

// Each ticks once a second on the shared clock, so only these spans re-render.
function NextRunCountdown(props: { nextRunAt: string }) {
  return (
    <span className="tabular-nums">{formatNextRunCountdown(props.nextRunAt, useNowSecond())}</span>
  );
}

function LastRunAgo(props: { lastRunAt: string }) {
  return <>{formatLastRunAgo(props.lastRunAt, useNowSecond())}</>;
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
  sortableId: string;
  environmentId: EnvironmentId;
  task: ScheduledTask;
  projectDisplayName: string | null;
  machineLabel: string | null;
  machineKind: EnvironmentMachineKind;
  routeThreadKey: string | null;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (sortableId: string, offset: -1 | 1) => void;
  onNavigateToThread: (threadRef: ScopedThreadRef) => void;
}) {
  const { environmentId, task, onNavigateToThread } = props;
  const navigate = useNavigate();
  const canOperate = useAtomValue(
    serverEnvironment.setScheduledTaskPlacement.permissionAtom(environmentId),
  );
  // Servers without reordering leave pinOrderKey out of the task.
  const canReorder = canOperate && task.pinOrderKey !== undefined;
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.sortableId,
    disabled: !canReorder,
  });
  const setPlacement = useSetScheduledTaskPlacement();
  const canMove = supportsScheduledTaskPlacement(task);
  const currentPlacement = resolveScheduledTaskPlacement(task);
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "sidebar scheduled task run now",
  });
  const offersRunHistory =
    useEnvironment(environmentId)?.serverConfig?.environment.capabilities
      .scheduledTaskRunHistory === true;
  const [runsOpen, setRunsOpen] = useState(false);
  const runThreadId = pinnedTaskRunThreadId(task);
  const runThreadRef =
    runThreadId === null ? null : scopeThreadRef(environmentId, ThreadId.make(runThreadId));
  const runThread = useQuietThreadShell(runThreadRef);
  const status = resolvePinnedTaskStatus(
    task,
    runThread === null
      ? null
      : {
          status: resolveThreadStatus(runThread),
          runtimeStatus: runThread.runtime?.status ?? null,
        },
  );
  const display = status === "idle" ? null : pinnedTaskStatusDisplay(status);
  const isActive = runThreadRef !== null && scopedThreadKey(runThreadRef) === props.routeThreadKey;
  const accessibility = resolveSidebarRowAccessibility({
    title: task.title,
    statusLabel: display ? t(display.label) : null,
    projectDisplayName:
      [props.projectDisplayName, props.machineLabel].filter(Boolean).join(", ") || null,
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
        ? [{ id: "open-run" as const, label: t("Open last run"), icon: "message-square" }]
        : []),
      { id: "edit", label: t("Edit task"), icon: "pencil" },
      // Webhook tasks run only when their URL receives a request.
      ...(task.schedule.type === "webhook"
        ? []
        : [
            {
              id: "run-now" as const,
              label: t("Run now"),
              icon: "refresh-cw",
              disabled: !canOperate || status === "starting",
            },
          ]),
      ...(offersRunHistory
        ? [{ id: "run-history" as const, label: t("Run history"), icon: "history" }]
        : []),
      ...(canReorder
        ? [
            {
              id: "move-up" as const,
              label: t("Move up"),
              icon: "arrow-up",
              disabled: !props.canMoveUp,
              separatorBefore: true,
            },
            {
              id: "move-down" as const,
              label: t("Move down"),
              icon: "arrow-down",
              disabled: !props.canMoveDown,
            },
          ]
        : []),
      ...(canMove
        ? [
            {
              id: "show-in" as const,
              label: t("Show in"),
              icon: "pin",
              disabled: !canOperate,
              separatorBefore: true,
              children: scheduledTaskPlacementOptions().map((option) => ({
                id: `place:${option.value}` as const,
                label: option.label,
                checked: option.value === currentPlacement,
              })),
            },
          ]
        : []),
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
      case "run-history":
        setRunsOpen(true);
        return;
      case "run-now": {
        if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
        const result = await runNow({ environmentId, input: { id: task.id } });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: t("Could not run task"),
              description: String(squashAtomCommandFailure(result)),
            }),
          );
        }
        return;
      }
      case "move-up":
        props.onMove(props.sortableId, -1);
        return;
      case "move-down":
        props.onMove(props.sortableId, 1);
        return;
      default: {
        const placement = scheduledTaskPlacementOptions().find(
          (option) => `place:${option.value}` === clicked.value,
        )?.value;
        if (placement !== undefined) await setPlacement(environmentId, [task], placement);
      }
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
    void setPlacement(environmentId, [task], "chat");
  };

  const StatusIcon = display?.icon;
  const row = (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...listeners}
      className={cn("list-none py-0.5", isDragging && "relative z-20")}
    >
      <div
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={`task:${environmentId}:${task.id}`}
        data-sidebar-parent="shelf:scheduled"
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        data-testid="sidebar-pinned-task-row"
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isActive ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
          isDragging &&
            "bg-sidebar bg-linear-to-b from-sidebar-row-active to-sidebar-row-active shadow-lg",
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
                {t(display.label)}
                {status === "working" && runThread !== null ? (
                  <span aria-hidden>
                    <WorkingDuration startedAt={resolveWorkingStartedAt(runThread)} />
                  </span>
                ) : null}
              </span>
            ) : null}
            {canMove ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={t("Unpin {title} from sidebar", { title: task.title })}
                      disabled={!canOperate}
                      onClick={handleUnpin}
                      className="pointer-events-none inline-flex shrink-0 cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100 motion-reduce:transition-none"
                    >
                      <PinOffIcon className="size-3.5" />
                    </button>
                  }
                />
                <TooltipPopup side="top">{t("Unpin from sidebar")}</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 pl-5 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">
              {scheduleLabel(task.schedule)}
              {task.enabled && task.nextRunAt !== null ? (
                <>
                  {" · "}
                  <NextRunCountdown nextRunAt={task.nextRunAt} />
                </>
              ) : task.lastRunAt !== null ? (
                <>
                  {" · "}
                  <LastRunAgo lastRunAt={task.lastRunAt} />
                </>
              ) : null}
            </span>
            {props.machineLabel !== null ? (
              <span className="inline-flex max-w-[45%] shrink-0 items-center gap-1">
                <EnvironmentMachineIcon
                  kind={props.machineKind}
                  className="size-3 shrink-0 stroke-muted-foreground"
                />
                <span className="truncate">{props.machineLabel}</span>
              </span>
            ) : null}
          </div>
        </div>
        {status === "idle" || status === "failed" ? <IntervalWaitBar task={task} /> : null}
      </div>
    </li>
  );
  if (!runsOpen) return row;
  return (
    <>
      {row}
      {/* Outside the row: React bubbles a portal's events to its parents, which drag and open runs. */}
      <ScheduledTaskRunsDialog
        environmentId={environmentId}
        task={task}
        onClose={() => setRunsOpen(false)}
      />
    </>
  );
});

/** Pinned scheduled tasks above the thread list, with each one's run and countdown. */
export const SidebarPinnedTasksBlock = memo(function SidebarPinnedTasksBlock(props: {
  /** JSON array of environment ids, so the prop stays equal across renders. */
  environmentIdsKey: string;
  scopedProjectKeys: ReadonlySet<string> | null;
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  environmentLabelById: ReadonlyMap<EnvironmentId, string>;
  environmentMachineById: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
  routeThreadKey: string | null;
  onNavigateToThread: (threadRef: ScopedThreadRef) => void;
}) {
  const [expanded, setExpanded] = useLocalStorage(
    "t3code:sidebar:scheduled-expanded",
    true,
    Schema.Boolean,
  );
  // Keys this client sent, shown until the server's list reflects them, so a drop does not snap back.
  const [held, setHeld] = useState<HeldPinOrder | null>(null);
  const reorder = useAtomCommand(serverEnvironment.reorderPinnedScheduledTasks, {
    label: "sidebar scheduled task reorder",
  });
  const sensors = useSensors(useSensor(PointerSensor, PINNED_TASK_POINTER_OPTIONS));
  const collected = useAtomValue(pinnedTasksAtom(props.environmentIdsKey));
  const pinned = held === null ? collected : applyHeldPinOrder(collected, held);
  const entries = pinned.filter(
    ({ environmentId, task }) =>
      props.scopedProjectKeys === null ||
      props.scopedProjectKeys.has(`${environmentId}:${task.projectId}`),
  );
  if (entries.length === 0) return null;
  const visibleKeys = entries.map(pinnedTaskKey);

  const moveTo = (movedKey: string, toIndex: number) => {
    const fromIndex = visibleKeys.indexOf(movedKey);
    if (fromIndex === -1 || toIndex < 0 || toIndex >= visibleKeys.length || toIndex === fromIndex) {
      return;
    }
    const assignments = planPinnedTaskMove({
      pinned,
      visibleOrder: arrayMove(visibleKeys, fromIndex, toIndex),
      movedKey,
    });
    if (assignments.length === 0) return;
    const taskByKey = new Map(pinned.map((entry) => [pinnedTaskKey(entry), entry.task]));
    // A move that would rewrite a task this client cannot reorder is not applied at all.
    if (
      assignments.some(
        (assignment) =>
          taskByKey.get(
            pinnedTaskKey({ environmentId: assignment.environmentId, task: assignment }),
          )?.pinOrderKey === undefined ||
          !readEnvironmentScope(assignment.environmentId, AuthOrchestrationOperateScope),
      )
    ) {
      return;
    }
    const nextHeld = holdPinOrder(collected, held, assignments);
    setHeld(nextHeld);
    const byEnvironment = new Map<
      EnvironmentId,
      Array<{ id: ScheduledTask["id"]; orderKey: string }>
    >();
    for (const { environmentId, id, orderKey } of assignments) {
      byEnvironment.set(environmentId, [
        ...(byEnvironment.get(environmentId) ?? []),
        { id, orderKey },
      ]);
    }
    void (async () => {
      const results = await Promise.all(
        [...byEnvironment].map(([environmentId, environmentAssignments]) =>
          reorder({ environmentId, input: { assignments: environmentAssignments } }),
        ),
      );
      const failure = results.find((result) => result._tag === "Failure");
      if (failure === undefined) return;
      setHeld((current) => (current === nextHeld ? null : current));
      if (isAtomCommandInterrupted(failure)) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Could not reorder pinned tasks"),
          description: String(squashAtomCommandFailure(failure)),
        }),
      );
    })();
  };
  const moveBy = (movedKey: string, offset: -1 | 1) =>
    moveTo(movedKey, visibleKeys.indexOf(movedKey) + offset);
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null || active.id === over.id) return;
    moveTo(String(active.id), visibleKeys.indexOf(String(over.id)));
  };
  const showMachine = (JSON.parse(props.environmentIdsKey) as ReadonlyArray<string>).length > 1;
  return (
    <>
      <li className="mx-0.5 h-8 shrink-0 list-none">
        <CollapsibleSectionHeader
          role="treeitem"
          tabIndex={-1}
          data-sidebar-row="shelf:scheduled"
          expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          accessory={<span className="font-normal tabular-nums">{entries.length}</span>}
        >
          {t("Scheduled")}
        </CollapsibleSectionHeader>
      </li>
      {expanded && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={PINNED_TASK_DRAG_MODIFIERS}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={visibleKeys} strategy={verticalListSortingStrategy}>
            {entries.map(({ environmentId, task }, index) => (
              <SidebarPinnedTaskRow
                key={visibleKeys[index]}
                sortableId={visibleKeys[index]!}
                environmentId={environmentId}
                task={task}
                projectDisplayName={
                  props.projectDisplayNameByKey.get(`${environmentId}:${task.projectId}`) ?? null
                }
                machineLabel={
                  showMachine ? (props.environmentLabelById.get(environmentId) ?? null) : null
                }
                machineKind={props.environmentMachineById.get(environmentId) ?? "server"}
                routeThreadKey={props.routeThreadKey}
                canMoveUp={index > 0}
                canMoveDown={index < entries.length - 1}
                onMove={moveBy}
                onNavigateToThread={props.onNavigateToThread}
              />
            ))}
          </SortableContext>
        </DndContext>
      )}
      <li
        aria-hidden
        data-testid="sidebar-pinned-tasks-divider"
        className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
      />
    </>
  );
});
