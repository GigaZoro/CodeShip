import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  collectPinnedTasks,
  formatNextRunCountdown,
  intervalWaitProgress,
  pinnedTaskRunThreadId,
  resolvePinnedTaskStatus,
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
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeSchedule } from "../settings/scheduledTaskPresentation";
import { openSettings } from "../settings/settings-navigation";
import {
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
  THREAD_LIST_V2_ROW_DIVIDERS,
  getThreadListV2RowAppearance,
} from "./thread-list-v2-row-appearance";
import { resolveThreadListV2Status } from "./threadListV2";
import { useVisibleSecondClock } from "./use-visible-second-clock";
import { useVisibleWorkingDurationLabel } from "./use-visible-working-duration-label";

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

const WORKING_TONE = {
  className: "text-adaptive-sky-600-400",
  iconTintClassName: "accent-adaptive-sky-600-400",
};
const STATUS_DISPLAY: Record<
  Exclude<PinnedTaskStatus, "idle">,
  {
    readonly label: string;
    readonly icon: AppSymbolName;
    readonly className: string;
    readonly iconTintClassName: string;
  }
> = {
  starting: { label: "Starting", icon: "circle.dashed", ...WORKING_TONE },
  working: { label: "Working", icon: "circle.dashed", ...WORKING_TONE },
  approval: {
    label: "Approval",
    icon: "exclamationmark.shield",
    className: "text-warning-foreground",
    iconTintClassName: "accent-warning-foreground",
  },
  input: {
    label: "Input",
    icon: "questionmark.bubble",
    className: "text-adaptive-indigo-600-300",
    iconTintClassName: "accent-adaptive-indigo-600-300",
  },
  failed: {
    label: "Failed",
    icon: "exclamationmark.circle",
    className: "text-danger-foreground",
    iconTintClassName: "accent-danger-foreground",
  },
  paused: {
    label: "Paused",
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
  readonly pane: "screen" | "sidebar";
  readonly selectedThreadKey: string | null;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { environmentId, task } = props;
  const navigation = useNavigation();
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
    serverEnvironment.setScheduledTaskPinned.permissionAtom(environmentId),
  );
  const setPinned = useAtomCommand(serverEnvironment.setScheduledTaskPinned, {
    label: "thread list task unpin",
    reportFailure: false,
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "thread list task run now",
    reportFailure: false,
  });

  const openRun = () => {
    if (runThread !== null) props.onSelectThread(runThread);
    else openSettings(navigation, "SettingsScheduledTasks");
  };
  const actions: MenuAction[] = [
    ...(runThread !== null ? [{ id: "open-run", title: "Open last run" }] : []),
    { id: "edit", title: "Edit task" },
    // Webhook tasks run only when their URL receives a request.
    ...(task.schedule.type === "webhook"
      ? []
      : [
          {
            id: "run",
            title: "Run now",
            attributes: { disabled: !canOperate || status === "starting" },
          },
        ]),
    { id: "unpin", title: "Unpin", image: "pin.slash", attributes: { disabled: !canOperate } },
  ];
  const handleAction = async (action: string) => {
    if (action === "open-run") return openRun();
    if (action === "edit") return openSettings(navigation, "SettingsScheduledTasks");
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const result =
      action === "run"
        ? await runNow({ environmentId, input: { id: task.id } })
        : action === "unpin"
          ? await setPinned({ environmentId, input: { id: task.id, pinned: false } })
          : null;
    if (result?._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert("Could not update task", String(squashAtomCommandFailure(result)));
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
              {display.label}
              {status === "working" && runThread !== null ? (
                <WorkingDuration thread={runThread} />
              ) : null}
            </Text>
          </View>
        ) : null}
      </View>
      <Text className={cn("mt-1 text-xs", appearance.mutedForegroundClassName)} numberOfLines={1}>
        {describeSchedule(task)}
        {task.enabled && task.nextRunAt !== null ? (
          <>
            {" · next "}
            <NextRunCountdown nextRunAt={task.nextRunAt} />
          </>
        ) : null}
      </Text>
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
          accessibilityLabel={[task.title, display?.label].filter(Boolean).join(", ")}
          accessibilityHint={
            runThread !== null ? "Opens the task's last run." : "Opens scheduled task settings."
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
          pane={props.pane}
          selectedThreadKey={props.selectedThreadKey}
          onSelectThread={props.onSelectThread}
        />
      ))}
    </View>
  );
}
