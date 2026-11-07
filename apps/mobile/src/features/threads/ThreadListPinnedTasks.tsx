import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  collectPinnedTasks,
  formatLastRunAgo,
  formatNextRunCountdown,
  intervalWaitProgress,
  pinnedTaskRunThreadId,
  resolvePinnedTaskStatus,
  resolveScheduledTaskPlacement,
  scheduledTaskHiddenThreadKeys,
  scheduledTaskPlacementOptions,
  type PinnedTaskStatus,
} from "@t3tools/client-runtime/scheduled-task-pins";
import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  ThreadId,
  type EnvironmentId,
  type ScheduledTask,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { memo } from "react";
import { View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useQuietThreadShell } from "../../state/entities";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeSchedule } from "../settings/scheduledTaskPresentation";
import { useOpenScheduledTasks } from "../workspace/useOpenScheduledTasks";
import {
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
  THREAD_LIST_V2_ROW_DIVIDERS,
  getThreadListV2RowAppearance,
} from "./thread-list-v2-row-appearance";
import { resolveThreadListV2Status } from "./threadListV2";
import { useVisibleSecondClock } from "./use-visible-second-clock";
import { useVisibleWorkingDurationLabel } from "./use-visible-working-duration-label";
import { msg, t, type Message } from "../../lib/i18n";

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
  ).pipe(Atom.withLabel(`mobile:thread-list-pinned-tasks:${environmentIdsKey}`)),
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
  }).pipe(Atom.withLabel(`mobile:thread-list-hidden-task-threads:${environmentIdsKey}`));
});

/** Scoped keys of the threads that scheduled tasks placed nowhere in the thread list. */
export function useScheduledTaskHiddenThreadKeys(environmentIdsKey: string): ReadonlySet<string> {
  return useAtomValue(hiddenThreadKeysAtom(environmentIdsKey));
}

const WORKING_TONE = {
  className: "text-adaptive-sky-600-400",
  iconTintClassName: "accent-adaptive-sky-600-400",
};
const STATUS_DISPLAY: Record<
  Exclude<PinnedTaskStatus, "idle">,
  {
    readonly label: Message;
    readonly icon: AppSymbolName;
    readonly className: string;
    readonly iconTintClassName: string;
  }
> = {
  starting: { label: msg("Starting"), icon: "circle.dashed", ...WORKING_TONE },
  working: { label: msg("Working"), icon: "circle.dashed", ...WORKING_TONE },
  approval: {
    label: msg("Approval"),
    icon: "exclamationmark.shield",
    className: "text-warning-foreground",
    iconTintClassName: "accent-warning-foreground",
  },
  input: {
    label: msg("Question"),
    icon: "questionmark.bubble",
    className: "text-adaptive-indigo-600-300",
    iconTintClassName: "accent-adaptive-indigo-600-300",
  },
  failed: {
    label: msg("Failed"),
    icon: "exclamationmark.circle",
    className: "text-danger-foreground",
    iconTintClassName: "accent-danger-foreground",
  },
  paused: {
    label: msg("Paused"),
    icon: "slash.circle",
    className: "text-foreground-muted",
    iconTintClassName: "accent-foreground-muted",
  },
};

function WorkingDuration(props: { readonly thread: EnvironmentThreadShell }) {
  return useVisibleWorkingDurationLabel(resolveThreadWorkingStartedAt(props.thread));
}

// Ticks once a second while the list is on screen, so only these views re-render.
function NextRunCountdown(props: { readonly nextRunAt: string }) {
  return formatNextRunCountdown(props.nextRunAt, useVisibleSecondClock(true));
}

function LastRunAgo(props: { readonly lastRunAt: string }) {
  return formatLastRunAgo(props.lastRunAt, useVisibleSecondClock(true));
}

function IntervalWaitBar(props: { readonly task: ScheduledTask }) {
  const progress = intervalWaitProgress(props.task, useVisibleSecondClock(true));
  if (progress === null) return null;
  return (
    <View className="mt-2 h-0.5 overflow-hidden rounded-full bg-border-subtle">
      <View
        className="h-full bg-adaptive-sky-600-400"
        style={{ width: `${Math.round(progress * 1000) / 10}%` }}
      />
    </View>
  );
}

const PinnedTaskRow = memo(function PinnedTaskRow(props: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly machineLabel: string | null;
  readonly pane: "screen" | "sidebar";
  readonly selectedThreadKey: string | null;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { environmentId, task } = props;
  const openScheduledTasks = useOpenScheduledTasks();
  const theme = useUniwindTheme();
  const sidebarPane = props.pane === "sidebar";
  const runThreadId = pinnedTaskRunThreadId(task);
  const runThread = useQuietThreadShell(
    runThreadId === null ? null : scopeThreadRef(environmentId, ThreadId.make(runThreadId)),
  );
  const selected =
    runThread !== null && scopedThreadKey(environmentId, runThread.id) === props.selectedThreadKey;
  const appearance = getThreadListV2RowAppearance(theme, sidebarPane, selected);
  const status = resolvePinnedTaskStatus(
    task,
    runThread === null
      ? null
      : {
          status: resolveThreadListV2Status(runThread),
          runtimeStatus: runThread.runtime?.status ?? null,
        },
  );
  const display = status === "idle" ? null : STATUS_DISPLAY[status];
  const canOperate = useAtomValue(
    serverEnvironment.setScheduledTaskPlacement.permissionAtom(environmentId),
  );
  const setPlacement = useAtomCommand(serverEnvironment.setScheduledTaskPlacement, {
    label: "thread list task placement",
    reportFailure: false,
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "thread list task run now",
    reportFailure: false,
  });

  const openRun = () => {
    if (runThread !== null) props.onSelectThread(runThread);
    else openScheduledTasks();
  };
  const actions: MenuAction[] = [
    ...(runThread !== null ? [{ id: "open-run", title: t("Open last run") }] : []),
    { id: "edit", title: t("Edit task") },
    // Webhook tasks run only when their URL receives a request.
    ...(task.schedule.type === "webhook"
      ? []
      : [
          {
            id: "run",
            title: t("Run now"),
            attributes: { disabled: !canOperate || status === "starting" },
          },
        ]),
    ...(task.placement === undefined
      ? []
      : [
          {
            id: "show-in",
            title: t("Show in"),
            attributes: { disabled: !canOperate },
            subactions: scheduledTaskPlacementOptions().map((option) => ({
              id: `placement:${option.value}`,
              title: option.label,
              state:
                option.value === resolveScheduledTaskPlacement(task)
                  ? ("on" as const)
                  : ("off" as const),
            })),
          },
        ]),
  ];
  const handleAction = async (action: string) => {
    if (action === "open-run") return openRun();
    if (action === "edit") return openScheduledTasks();
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const placement = scheduledTaskPlacementOptions().find(
      (option) => `placement:${option.value}` === action,
    )?.value;
    const result =
      action === "run"
        ? await runNow({ environmentId, input: { id: task.id } })
        : placement !== undefined
          ? await setPlacement({ environmentId, input: { ids: [task.id], placement } })
          : null;
    if (result?._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(
        action === "run" ? t("Could not run task") : t("Could not move task"),
        String(squashAtomCommandFailure(result)),
      );
    }
  };

  const content = (
    <>
      <View className="flex-row items-center gap-1.5">
        <SymbolView
          name="calendar.badge.clock"
          size={14}
          tintColorClassName={appearance.mutedIconTintClassName}
          type="monochrome"
        />
        <Text
          className={cn("flex-1 text-base font-t3-medium", appearance.foregroundClassName)}
          numberOfLines={1}
        >
          {task.title}
        </Text>
        {display !== null ? (
          <View className="flex-row items-center gap-1">
            <SymbolView
              name={display.icon}
              size={12}
              tintColorClassName={display.iconTintClassName}
              type="monochrome"
            />
            <Text className={cn("text-xs font-t3-medium tabular-nums", display.className)}>
              {t(display.label)}
              {status === "working" && runThread !== null ? (
                <WorkingDuration thread={runThread} />
              ) : null}
            </Text>
          </View>
        ) : null}
      </View>
      <View className="mt-1 flex-row items-center gap-2">
        <Text
          className={cn("flex-1 text-xs", appearance.mutedForegroundClassName)}
          numberOfLines={1}
        >
          {describeSchedule(task)}
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
        </Text>
        {props.machineLabel !== null ? (
          <Text
            className={cn("max-w-[45%] shrink-0 text-xs", appearance.mutedForegroundClassName)}
            numberOfLines={1}
          >
            {props.machineLabel}
          </Text>
        ) : null}
      </View>
      {status === "idle" || status === "failed" ? <IntervalWaitBar task={task} /> : null}
    </>
  );

  return (
    <View style={appearance.swipeContainerStyle}>
      <Menu
        actions={actions}
        onPressAction={({ nativeEvent }) => void handleAction(nativeEvent.event)}
        shouldOpenOnLongPress
      >
        <RowPressable
          accessibilityRole="button"
          accessibilityLabel={[task.title, display ? t(display.label) : null, props.machineLabel]
            .filter(Boolean)
            .join(", ")}
          accessibilityHint={
            runThread !== null
              ? t("Opens the task's last run.")
              : t("Opens scheduled task settings.")
          }
          accessibilityState={{ selected }}
          className={appearance.className}
          interactionClassName={appearance.interactionClassName}
          interactionOpacity={appearance.interactionOpacity}
          onPress={openRun}
          style={appearance.cardStyle}
        >
          {sidebarPane ? (
            content
          ) : (
            <View>
              <View className={THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME}>{content}</View>
              {THREAD_LIST_V2_ROW_DIVIDERS ? <View className="ml-5 h-px bg-border-subtle" /> : null}
            </View>
          )}
        </RowPressable>
      </Menu>
    </View>
  );
});

/** Pinned scheduled tasks above the thread list, with each one's run and countdown. */
export function ThreadListPinnedTasks(props: {
  /** JSON array of environment ids, so the atom stays the same across renders. */
  readonly environmentIdsKey: string;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs: ReadonlyArray<ScopedProjectRef> | null;
  readonly pane: "screen" | "sidebar";
  readonly selectedThreadKey: string | null;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const showMachine = props.environmentId === null && Object.keys(savedConnectionsById).length > 1;
  const entries = useAtomValue(pinnedTasksAtom(props.environmentIdsKey)).filter(
    ({ environmentId, task }) =>
      (props.environmentId === null || environmentId === props.environmentId) &&
      (props.projectRefs === null ||
        props.projectRefs.some(
          (ref) => ref.environmentId === environmentId && ref.projectId === task.projectId,
        )),
  );
  if (entries.length === 0) return null;
  return (
    <View className={cn(props.pane === "sidebar" && "pb-2")}>
      {entries.map(({ environmentId, task }) => (
        <PinnedTaskRow
          key={`${environmentId}:${task.id}`}
          environmentId={environmentId}
          task={task}
          machineLabel={
            showMachine ? (savedConnectionsById[environmentId]?.environmentLabel ?? null) : null
          }
          pane={props.pane}
          selectedThreadKey={props.selectedThreadKey}
          onSelectThread={props.onSelectThread}
        />
      ))}
    </View>
  );
}
