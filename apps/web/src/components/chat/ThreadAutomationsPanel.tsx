import { useAtomValue } from "@effect/atom-react";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { useNavigate } from "@tanstack/react-router";
import { CalendarClockIcon, PinIcon, PlayIcon, Settings2Icon } from "lucide-react";
import { useId, useState } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTask,
  type ScheduledTaskPlacement,
  type ThreadId,
} from "@t3tools/contracts";
import {
  resolveScheduledTaskPlacement,
  scheduledTaskPlacementLabel,
} from "@t3tools/client-runtime/scheduled-task-pins";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { cn } from "../../lib/utils";
import {
  ScheduledRelativeLabel,
  ScheduledTaskScheduleLine,
} from "../settings/ScheduledTasksSettings";
import { threadScheduledTasks } from "../settings/scheduledTasksSettings.logic";
import { useQuietThreadProjection } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  supportsScheduledTaskPlacement,
  useSetScheduledTaskPlacement,
} from "../../hooks/useSetScheduledTaskPlacement";

import { readEnvironmentScope } from "../../state/session";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScheduledTaskPlacementRadioGroup } from "../settings/ScheduledTaskPlacementRadioGroup";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

const STATUS_DOT_CLASS: Record<ScheduledTask["lastRunStatus"], string> = {
  never: "bg-muted-foreground/40",
  running: "bg-sky-500",
  succeeded: "bg-emerald-500",
  failed: "bg-destructive",
};

const LAST_RUN_LABEL: Record<ScheduledTask["lastRunStatus"], string> = {
  never: "Not run yet",
  running: "Running now",
  succeeded: "Last run succeeded",
  failed: "Last run failed",
};

function taskThreadRelation(task: ScheduledTask, threadId: ThreadId) {
  if (task.threadId === threadId) return "Runs in this thread";
  if (task.threadId === null) return "Started this thread; each run starts a new one";
  return "Now runs in another thread";
}

function ShowInControl(props: {
  readonly task: ScheduledTask;
  readonly disabled: boolean;
  readonly onChange: (placement: ScheduledTaskPlacement) => void;
}) {
  const label = scheduledTaskPlacementLabel(resolveScheduledTaskPlacement(props.task));
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  aria-label={`Show ${props.task.title} in: ${label}`}
                  disabled={props.disabled}
                />
              }
            >
              <PinIcon className="size-3.5" />
            </MenuTrigger>
          }
        />
        <TooltipPopup>Show in: {label}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end">
        <ScheduledTaskPlacementRadioGroup task={props.task} onChange={props.onChange} />
      </MenuPopup>
    </Menu>
  );
}

function ThreadAutomationRow(props: {
  readonly task: ScheduledTask;
  readonly threadId: ThreadId;
  readonly canOperate: boolean;
  readonly busy: boolean;
  readonly onEdit: () => void;
  readonly onRun: () => void;
  readonly onSetEnabled: (enabled: boolean) => void;
  readonly onSetPlacement: (placement: ScheduledTaskPlacement) => void;
}) {
  const { task } = props;
  const descriptionId = useId();
  const movable = supportsScheduledTaskPlacement(task);
  // Webhook tasks need a request from their URL.
  const runnable = task.schedule.type !== "webhook";
  return (
    <li>
      <div className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}>
        <Tooltip>
          <TooltipTrigger
            delay={200}
            render={
              <ThreadDetailsControl
                size="sm"
                variant="ghost"
                part="primary"
                multiline
                aria-label={`Edit ${task.title}`}
                aria-describedby={`${descriptionId}-schedule ${descriptionId}-status`}
                onClick={props.onEdit}
              />
            }
          >
            <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
              <CalendarClockIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <span
                className={cn(
                  "absolute -right-1 -top-1 size-1.5 rounded-full",
                  STATUS_DOT_CLASS[task.lastRunStatus],
                )}
                aria-hidden
              />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-medium leading-4 text-foreground/85">
                {task.title}
              </span>
              <span
                id={`${descriptionId}-schedule`}
                className="truncate text-2xs font-normal leading-4 text-muted-foreground"
              >
                <ScheduledTaskScheduleLine task={task} />
              </span>
              <span id={`${descriptionId}-status`} className="sr-only">
                {LAST_RUN_LABEL[task.lastRunStatus]}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipPopup side="left">
            <p className="font-medium">{task.title}</p>
            <p className="text-muted-foreground">
              <ScheduledTaskScheduleLine task={task} />
            </p>
            <p className="text-muted-foreground">
              {LAST_RUN_LABEL[task.lastRunStatus]}
              {task.lastRunStatus !== "running" && task.lastRunAt !== null ? (
                <>
                  {" · "}
                  <ScheduledRelativeLabel value={task.lastRunAt} />
                </>
              ) : null}
            </p>
            <p className="text-muted-foreground">{taskThreadRelation(task, props.threadId)}</p>
          </TooltipPopup>
        </Tooltip>
        <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
        {/* Shown on hover and focus so the title keeps the row's width at rest. */}
        {movable || runnable ? (
          <div className="ms-1 hidden shrink-0 items-center gap-0.5 group-hover/details-split:flex group-focus-within/details-split:flex pointer-coarse:flex [@media(hover:none)]:flex">
            {movable ? (
              <ShowInControl
                task={task}
                disabled={!props.canOperate}
                onChange={props.onSetPlacement}
              />
            ) : null}
            {runnable ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <ThreadDetailsControl
                      size="icon-xs"
                      variant="ghost"
                      part="icon"
                      aria-label={`Run ${task.title} now`}
                      disabled={!props.canOperate || props.busy || task.lastRunStatus === "running"}
                      onClick={props.onRun}
                    >
                      <PlayIcon className="size-3.5" />
                    </ThreadDetailsControl>
                  }
                />
                <TooltipPopup>Run now</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
        <span className="flex shrink-0 items-center ps-1.5 pe-2.5">
          <Switch
            checked={task.enabled}
            disabled={!props.canOperate || props.busy}
            aria-label={task.enabled ? `Pause ${task.title}` : `Resume ${task.title}`}
            onCheckedChange={props.onSetEnabled}
          />
        </span>
      </div>
    </li>
  );
}

export function ThreadAutomationsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const canOperate = useAtomValue(
    serverEnvironment.runScheduledTaskNow.permissionAtom(props.environmentId),
  );
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  );
  const structure = useQuietThreadProjection(scopeThreadRef(props.environmentId, props.threadId));
  const setTaskEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "thread automation toggle",
  });
  const runTaskNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "thread automation run now",
  });
  const setPlacement = useSetScheduledTaskPlacement();
  const navigate = useNavigate();
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const threadTasks = threadScheduledTasks(
    tasksQuery.data?.tasks ?? [],
    props.threadId,
    structure?.projection.turnItems ?? [],
  );

  if (tasksQuery.error === null && threadTasks.length === 0) return null;

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const toggleEnabled = async (task: ScheduledTask, enabled: boolean) => {
    if (
      busyTaskId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setBusyTaskId(task.id);
    const result = await setTaskEnabled({
      environmentId: props.environmentId,
      input: { id: task.id, enabled },
    });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not update automation", squashAtomCommandFailure(result));
    }
  };

  const runNow = async (task: ScheduledTask) => {
    if (
      busyTaskId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setBusyTaskId(task.id);
    const result = await runTaskNow({
      environmentId: props.environmentId,
      input: { id: task.id },
    });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not run automation", squashAtomCommandFailure(result));
    }
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-automations-heading"
      title="Automations"
      data-thread-automations-panel
      actions={
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                size="icon-xs"
                variant="ghost"
                part="icon"
                aria-label="Manage scheduled tasks"
                onClick={() =>
                  void navigate({
                    to: "/scheduled-tasks",
                    search: { environmentId: props.environmentId },
                  })
                }
              >
                <Settings2Icon className="size-3.5" />
              </ThreadDetailsControl>
            }
          />
          <TooltipPopup>Manage scheduled tasks</TooltipPopup>
        </Tooltip>
      }
    >
      <ul className="m-0 flex max-h-[13.5rem] list-none flex-col gap-0.5 overflow-y-auto p-0">
        {threadTasks.map((task) => (
          <ThreadAutomationRow
            key={task.id}
            task={task}
            threadId={props.threadId}
            canOperate={canOperate}
            busy={busyTaskId !== null}
            onEdit={() =>
              void navigate({
                to: "/scheduled-tasks",
                search: { environmentId: props.environmentId, taskId: task.id },
              })
            }
            onRun={() => void runNow(task)}
            onSetEnabled={(enabled) => void toggleEnabled(task, enabled)}
            onSetPlacement={(placement) =>
              void setPlacement(props.environmentId, [task], placement)
            }
          />
        ))}
      </ul>
      {/* Kept last: the details card treats a section whose last child is empty as empty. */}
      {tasksQuery.error !== null ? (
        <p className="px-2.5 py-1.5 text-2xs text-destructive">
          Could not load automations: {tasksQuery.error}
        </p>
      ) : null}
    </ThreadDetailsSection>
  );
}
