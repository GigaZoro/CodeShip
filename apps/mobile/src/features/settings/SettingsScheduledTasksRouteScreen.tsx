import { t, tn, tx } from "../../lib/i18n";
import * as Dialog from "../../components/ui/Dialog";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  clampManagedRuntimeMode,
  defaultCatchUpMissedRun,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { managedCapabilityDenial } from "@t3tools/shared/managedPolicyMessages";
import { readEnvironmentScope } from "../../state/session";
import type {
  EnvironmentId,
  LinkedScheduledTaskMachine,
  ProjectId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskPlacement,
  ScheduledTaskRunStats,
  ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import {
  formatLastRunAgo,
  formatTimeAgo,
  pinnedTaskRunThreadId,
  resolveScheduledTaskPlacement,
  scheduledTaskPlacementOptions,
} from "@t3tools/client-runtime/scheduled-task-pins";
import {
  runConditionHelpText,
  runConditionInput,
  runConditionInvalidText,
} from "@t3tools/client-runtime/scheduled-task-run-condition";
import { providerDriverDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  MAX_SCHEDULED_TASK_GROUP_LENGTH,
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  MAX_WEBHOOK_FILTERS,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { resolvePastedPath } from "@t3tools/shared/path";
import {
  DEFAULT_WEBHOOK_PROMPT,
  emptyWebhookFilterDraft,
  parseMaxDeliveryAge,
  parseWebhookFilterDrafts,
  removeWebhookFilterDraft,
  WEBHOOK_FILTER_OPS,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import { useRef, useState, type ReactNode } from "react";
import { useFocusEffect, useNavigation, usePreventRemove } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  AppState,
  Platform,
  Pressable,
  ScrollView as NativeScrollView,
  TextInput as RNTextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import {
  EnvironmentMachineSymbol,
  ENVIRONMENT_MACHINE_SYMBOLS,
} from "../../components/EnvironmentMachineSymbol";
import { Menu } from "../../components/ui/Menu";
import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import {
  effectivePromptSource,
  promptFileDraftProblem,
  promptFileLostOnTarget,
  promptFileReadFor,
  promptUpsertFields,
} from "@t3tools/client-runtime/scheduled-task-prompt-file";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import {
  describeOneMachineLinkWarning,
  effectiveOneMachineOrder,
  groupSharedScheduledTasks,
  newestProjectMachineOrder,
  oneMachineLinkWarnings,
  seedMachineOrder,
  sharedProjectReference,
  sharedUpsertField,
  visibleMachineOrder,
  type SharedScheduledTaskGroup,
} from "@t3tools/client-runtime/scheduled-task-sharing";
import {
  scheduledTaskGroupAction,
  scheduledTaskGroupKey,
  scheduledTaskGroupLabels,
  scheduledTaskGroupPausePlan,
  scheduledTaskGroupUpsertField,
  scheduledTaskLastDayStatsInput,
  scheduledTaskListItemCopies,
  scheduledTaskListItemGroupCopy,
  groupScheduledTaskItems,
  summarizeScheduledTaskGroup,
  type ScheduledTaskListItem,
} from "@t3tools/client-runtime/scheduled-task-groups";
import {
  linkedProjectName,
  pickLinkedMachineTasks,
} from "@t3tools/client-runtime/linked-scheduled-tasks";
import { AsyncResult, Atom } from "effect/reactivity";
import { useSharedScheduledTaskSnapshots } from "../../state/sharedScheduledTasks";
import { webhookAddress } from "@t3tools/client-runtime/webhook-address";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { usePreparedConnection } from "../../state/session";
import { buildModelOptions } from "../../lib/modelOptions";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useEnvironmentServerConfig, useServerConfigs } from "../../state/entities";
import {
  autoModePick,
  resolveInheritedDefaultModelSelection,
} from "@t3tools/shared/serverSettings";
import { useEnvironmentQuery } from "../../state/query";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { ListSection } from "../../components/ui/ListSection";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { resolveNewTaskBranchLabel } from "../threads/new-task-context-presentation";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { ScheduledTaskPromptField } from "./components/ScheduledTaskPromptField";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import {
  SettingsEnvironmentFilterProvider,
  useSettingsEnvironmentFilter,
  type SettingsTarget,
} from "./settings-environment-filter";
import {
  duplicateDraft,
  editDraft,
  parseIntervalMinutes,
  runConditionLostOnTarget,
  scheduledTaskDefaultModel,
  scheduleFromDraft,
  type ScheduledTaskDraft as Draft,
} from "./scheduledTaskDraft";
import { settingsTargetsForProject } from "./settings-environment-filter.logic";
import { useScheduledTaskEditor } from "./scheduled-task-editor";
import { useOpenScheduledTaskThread } from "./ScheduledTaskRunsRouteScreen";
import {
  discardScheduledTaskEditor,
  markScheduledTaskEditorSaved,
  scheduledTaskEditorSessionAtom,
} from "./scheduled-task-editor-state";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  SCHEDULED_TASK_WEEKDAYS as DAYS,
  describeSchedule,
  formatNoWorkSkip,
  formatNextScheduledTaskRun,
  formatRunAtDate,
  formatRunAtTime,
  formatScheduledTaskRunTime,
  formatScheduledTaskTime as formatTime,
  isWeekdaysRepeat,
  repeatLabel,
} from "./scheduledTaskPresentation";

const FILTER_VALUE_EXAMPLE = "opened";
const FILTER_LIST_EXAMPLE = "opened, reopened";

/** Keyed by environment ids; a list that has not loaded is left out. */
const scheduledTaskListsAtom = Atom.family((key: string) =>
  Atom.make((get) =>
    (key === "" ? [] : (key.split("\n") as EnvironmentId[])).flatMap((environmentId) => {
      const list = AsyncResult.getOrElse(
        get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} })),
        () => null,
      );
      return list === null ? [] : [{ environmentId, tasks: list.tasks }];
    }),
  ).pipe(Atom.withLabel(`mobile-scheduled-task-lists:${key}`)),
);

/** Keyed by a window start, then environment ids; a machine that has not answered is left out. */
const scheduledTaskStatsListsAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const [since, ...ids] = key.split("\n");
    return ids.flatMap((environmentId) => {
      const stats = AsyncResult.getOrElse(
        get(
          serverEnvironment.scheduledTaskStats({
            environmentId: environmentId as EnvironmentId,
            input: { since: since! },
          }),
        ),
        () => null,
      );
      return stats === null ? [] : [{ environmentId: environmentId as EnvironmentId, ...stats }];
    });
  }).pipe(Atom.withLabel(`mobile-scheduled-task-stats:${key}`)),
);

/** Keyed by environment ids: whether the account may operate on every one of them. */
const canOperateAllAtom = Atom.family((key: string) =>
  Atom.make((get) =>
    (key === "" ? [] : (key.split("\n") as EnvironmentId[])).every((environmentId) =>
      get(serverEnvironment.upsertScheduledTask.permissionAtom(environmentId)),
    ),
  ).pipe(Atom.withLabel(`mobile-scheduled-task-can-operate:${key}`)),
);

/** The collapsed-groups preference stores this for the tasks without a group. */
const NO_GROUP_PREFERENCE_KEY = "\u0000no-group";

/** Keyed by environment ids: the task lists each one stored for the machines it links to. */
const linkedScheduledTaskListsAtom = Atom.family((key: string) =>
  Atom.make((get) =>
    (key === "" ? [] : (key.split("\n") as EnvironmentId[])).map((environmentId) => ({
      environmentId,
      machines:
        AsyncResult.getOrElse(
          get(serverEnvironment.linkedScheduledTasksLive({ environmentId, input: {} })),
          () => null,
        )?.machines ?? [],
    })),
  ).pipe(Atom.withLabel(`mobile-linked-scheduled-task-lists:${key}`)),
);

/** Mobile can't send a webhook secret, and a task bound to a thread runs only in that thread. */
function canDuplicateOnMobile(task: ScheduledTask) {
  return (
    task.threadId === null &&
    !(task.schedule.type === "webhook" && task.schedule.signature !== null)
  );
}

/** The thread the last run used; a run that failed before it had one leaves an older one recorded. */
function lastRunThreadId(task: ScheduledTask) {
  return task.lastRunStatus === "succeeded" ? pinnedTaskRunThreadId(task) : null;
}

function nextRunText(task: ScheduledTask, now: number) {
  if (task.blockedByPolicy) return task.blockedByPolicy;
  if (!task.enabled) return t("Paused");
  return task.nextRunAt ? formatNextScheduledTaskRun(task.nextRunAt, now) : t("Not scheduled");
}

function lastRunText(task: Pick<ScheduledTask, "lastRunStatus" | "lastRunAt">, now: number) {
  if (task.lastRunStatus === "running") return t("Running now");
  if (!task.lastRunAt) return null;
  const lastRun = formatLastRunAgo(task.lastRunAt, now);
  return task.lastRunStatus === "failed" ? t("{lastRun}, failed", { lastRun }) : lastRun;
}

type ScheduledTaskRoutes = {
  SettingsScheduledTaskNew: undefined;
  SettingsScheduledTaskEdit: undefined;
  SettingsScheduledTaskRuns: {
    readonly environmentId: EnvironmentId;
    readonly taskId: ScheduledTaskId;
    readonly title: string;
  };
  SettingsScheduledTaskModel: undefined;
  SettingsScheduledTaskBranch: undefined;
};

function timePickerValue(value: string): Date {
  const [hours, minutes] = value.split(":").map(Number);
  const time = new Date();
  time.setHours(
    Number.isInteger(hours) ? (hours ?? 9) : 9,
    Number.isInteger(minutes) ? (minutes ?? 0) : 0,
    0,
    0,
  );
  return time;
}

function FormField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly keyboardType?: "decimal-pad" | "number-pad";
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly borderTop?: boolean;
  readonly technical?: boolean;
}) {
  return (
    <View
      className={
        props.borderTop ? "gap-2 border-t border-border-subtle px-4 py-3" : "gap-2 px-4 py-3"
      }
    >
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <RNTextInput
        accessibilityLabel={props.label}
        value={props.value}
        readOnly={props.disabled}
        onChangeText={props.onChange}
        textAlignVertical="center"
        keyboardType={props.keyboardType}
        autoCorrect={props.technical ? false : undefined}
        autoCapitalize={props.technical ? "none" : undefined}
        placeholder={props.placeholder}
        placeholderTextColorClassName="accent-foreground-muted"
        className="min-h-8 font-sans text-base text-foreground"
      />
    </View>
  );
}

function GroupField(props: {
  readonly value: string;
  readonly suggestions: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const chosen = scheduledTaskGroupKey(props.value);
  const suggestions = props.suggestions.filter((label) => scheduledTaskGroupKey(label) !== chosen);
  return (
    <View className="gap-2 border-t border-border-subtle px-4 py-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-sm text-foreground-muted">{t("Group")}</Text>
        <Text className="text-sm text-foreground-muted">
          {`${props.value.length} / ${MAX_SCHEDULED_TASK_GROUP_LENGTH}`}
        </Text>
      </View>
      <RNTextInput
        accessibilityLabel={t("Group")}
        value={props.value}
        readOnly={props.disabled}
        maxLength={MAX_SCHEDULED_TASK_GROUP_LENGTH}
        onChangeText={props.onChange}
        textAlignVertical="center"
        placeholder={t("No group")}
        placeholderTextColorClassName="accent-foreground-muted"
        className="min-h-8 font-sans text-base text-foreground"
      />
      {suggestions.length > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          {suggestions.map((label) => (
            <Pressable
              key={label}
              accessibilityRole="button"
              accessibilityLabel={t("Use group {group}", { group: label })}
              disabled={props.disabled}
              onPress={() => props.onChange(label)}
              className="min-h-11 justify-center rounded-full bg-subtle px-4 active:opacity-70 disabled:opacity-50"
            >
              <Text className="text-sm text-foreground" numberOfLines={1}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Text className="text-sm text-foreground-muted">
        {t("Tasks with the same group are listed and paused together.")}
      </Text>
    </View>
  );
}

function SelectRow(props: {
  readonly label: string;
  readonly value: string;
  readonly valueIcon?: ReactNode;
  readonly actions: MenuAction[];
  readonly onSelect: (id: string) => void;
  readonly borderTop?: boolean;
}) {
  const value = (
    <View className="min-w-0 flex-1 flex-row items-center justify-end gap-2">
      {props.valueIcon}
      <Text
        textRole="footnote"
        className="shrink text-right text-foreground-muted"
        numberOfLines={1}
      >
        {props.value}
      </Text>
    </View>
  );
  if (props.actions.length === 0) {
    return (
      <View
        className={
          props.borderTop
            ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3"
            : "min-h-14 flex-row items-center gap-3 px-4 py-3"
        }
      >
        <Text textRole="body" className="text-foreground">
          {props.label}
        </Text>
        {value}
      </View>
    );
  }
  return (
    <Menu
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("{label}, {value}", { label: props.label, value: props.value })}
        className={
          props.borderTop
            ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
            : "min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
        }
      >
        <Text textRole="body" className="text-foreground">
          {props.label}
        </Text>
        {value}
        <SymbolView
          name="chevron.down"
          size={14}
          tintColorClassName="accent-chevron"
          type="monochrome"
        />
      </Pressable>
    </Menu>
  );
}

function WebhookFilterRows(props: {
  readonly filters: ReadonlyArray<WebhookFilterDraft>;
  readonly disabled: boolean;
  readonly onChange: (filters: ReadonlyArray<WebhookFilterDraft>) => void;
}) {
  const update = (index: number, patch: Partial<WebhookFilterDraft>) =>
    props.onChange(
      props.filters.map((filter, at) => (at === index ? { ...filter, ...patch } : filter)),
    );
  return (
    <>
      {props.filters.map((filter, index) => (
        <View key={filter.id}>
          <View className="flex-row items-center gap-3 border-t border-border-subtle px-4 pt-3">
            <Text className="min-w-0 flex-1 text-sm text-foreground-muted">
              {t("Filter {number}", { number: index + 1 })}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Remove filter {number}", { number: index + 1 })}
              disabled={props.disabled}
              hitSlop={8}
              onPress={() => props.onChange(removeWebhookFilterDraft(props.filters, filter.id))}
              className="active:opacity-70"
            >
              <SymbolView name="trash" size={16} tintColorClassName="accent-danger-foreground" />
            </Pressable>
          </View>
          <FormField
            label={t("Path")}
            value={filter.path}
            placeholder={"body.action"}
            disabled={props.disabled}
            onChange={(path) => update(index, { path })}
          />
          <SelectRow
            label={t("Test")}
            value={t(WEBHOOK_FILTER_OPS.find((option) => option.op === filter.op)?.label ?? "")}
            actions={WEBHOOK_FILTER_OPS.map((option) => ({
              id: option.op,
              title: t(option.label),
              state: option.op === filter.op ? ("on" as const) : undefined,
            }))}
            onSelect={(id) => {
              const known = WEBHOOK_FILTER_OPS.find((option) => option.op === id);
              if (known) update(index, { op: known.op });
            }}
          />
          {filter.op === "exists" ? null : (
            <FormField
              label={filter.op === "in" ? t("Values, comma-separated") : t("Value")}
              value={filter.value}
              placeholder={filter.op === "in" ? FILTER_LIST_EXAMPLE : FILTER_VALUE_EXAMPLE}
              disabled={props.disabled}
              onChange={(value) => update(index, { value })}
            />
          )}
        </View>
      ))}
      {props.filters.length < MAX_WEBHOOK_FILTERS ? (
        <Pressable
          accessibilityRole="button"
          disabled={props.disabled}
          onPress={() => props.onChange([...props.filters, emptyWebhookFilterDraft()])}
          className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
        >
          <Text textRole="body" className="min-w-0 flex-1 text-foreground">
            {t("Add filter")}
          </Text>
          <SymbolView name="plus" size={16} tintColorClassName="accent-icon" />
        </Pressable>
      ) : null}
      {props.filters.length > 0 ? (
        <Text className="px-4 pb-3 text-sm text-foreground-muted">
          {t(
            "Runs only when every filter matches. Other requests are logged as filtered. Separate “is one of” values with commas; a value can't contain a comma.",
          )}
        </Text>
      ) : null}
    </>
  );
}

function PickerRow(props: {
  readonly label: string;
  readonly value: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly borderTop?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("{label}, {value}", { label: props.label, value: props.value })}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.borderTop
          ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
          : "min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70 disabled:opacity-50"
      }
    >
      <Text textRole="body" className="text-foreground">
        {props.label}
      </Text>
      <Text
        textRole="footnote"
        className="min-w-0 flex-1 text-right text-foreground-muted"
        numberOfLines={1}
      >
        {props.value}
      </Text>
      <SymbolView
        name="chevron.right"
        size={14}
        tintColorClassName="accent-chevron"
        type="monochrome"
      />
    </Pressable>
  );
}

export function SettingsScheduledTasksRouteScreen() {
  return <ScheduledTasksScreen />;
}

/**
 * `workspace` is the Tasks tab. It keeps its own environment and project filter for as long as
 * the tab is mounted, because the Settings scope resets whenever Settings closes.
 */
export function ScheduledTasksScreen(props: { readonly workspace?: boolean }) {
  if (!props.workspace) return <ScheduledTasksContent />;
  return (
    <SettingsEnvironmentFilterProvider open>
      <ScheduledTasksContent workspace />
    </SettingsEnvironmentFilterProvider>
  );
}

function ScheduledTasksContent(props: { readonly workspace?: boolean }) {
  const [now, setNow] = useState(Date.now);
  useFocusEffect(() => {
    const updateNow = () => setNow(Date.now());
    updateNow();
    const timer = setInterval(updateNow, 60_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") updateNow();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  });
  const { availableTargets, selectedTargets, selectedProjectKey, projectGroups } =
    useSettingsEnvironmentFilter();
  const selectedGroup = projectGroups.find((group) => group.key === selectedProjectKey);
  const visibleEnvironments = settingsTargetsForProject(
    selectedTargets,
    selectedProjectKey === null ? null : selectedGroup,
  );
  const { startEditor, resetEditor } = useScheduledTaskEditor();
  const navigation = useNavigation<NativeStackNavigationProp<ScheduledTaskRoutes>>();
  const insets = useSafeAreaInsets();
  const projectIdsFor = (environmentId: EnvironmentId) =>
    selectedProjectKey === null
      ? null
      : (selectedGroup?.members
          .filter((member) => member.project.environmentId === environmentId)
          .map((member) => member.project.id) ?? []);
  const lists = useAtomValue(
    scheduledTaskListsAtom(visibleEnvironments.map((entry) => entry.environmentId).join("\n")),
  );
  const { shared: sharedGroups } = groupSharedScheduledTasks(
    lists.map(({ environmentId, tasks }) => {
      const projectIds = projectIdsFor(environmentId);
      return {
        environmentId,
        tasks: tasks.filter((task) => projectIds === null || projectIds.includes(task.projectId)),
      };
    }),
  );
  const labelOf = (environmentId: EnvironmentId) =>
    availableTargets.find((target) => target.environmentId === environmentId)?.label ??
    environmentId;
  const listedTasks: ScheduledTaskListItem[] = [
    ...sharedGroups.map((group): ScheduledTaskListItem => ({ kind: "shared", group })),
    ...lists.flatMap(({ environmentId, tasks }) => {
      const projectIds = projectIdsFor(environmentId);
      return tasks
        .filter(
          (task) => !task.shared && (projectIds === null || projectIds.includes(task.projectId)),
        )
        .map((task): ScheduledTaskListItem => ({ kind: "local", environmentId, task }));
    }),
  ];
  const taskGroupSections = groupScheduledTaskItems(
    listedTasks,
    (item) => scheduledTaskListItemGroupCopy(item).task.group,
  );
  const grouped = taskGroupSections.some((section) => section.key !== null);
  const statsEnvironmentIds = visibleEnvironments
    .filter((entry) => entry.serverConfig.environment.capabilities.scheduledTaskGroups === true)
    .map((entry) => entry.environmentId);
  const statsLists = useAtomValue(
    scheduledTaskStatsListsAtom(
      grouped && statsEnvironmentIds.length > 0
        ? [scheduledTaskLastDayStatsInput(now).since, ...statsEnvironmentIds].join("\n")
        : "",
    ),
  );
  const collapsedKeys = useCollapsedScheduledTaskGroups();
  const projectNameOf = (environmentId: EnvironmentId, projectId: ProjectId) => {
    for (const group of projectGroups) {
      const member = group.members.find(
        (candidate) =>
          candidate.project.environmentId === environmentId && candidate.project.id === projectId,
      );
      if (member !== undefined) return member.project.isScratch ? t("No project") : group.label;
    }
    return null;
  };
  const linkedLists = useAtomValue(
    linkedScheduledTaskListsAtom(
      availableTargets
        .flatMap((target) =>
          target.serverConfig.environment.capabilities.linkedScheduledTasks === true
            ? [target.environmentId]
            : [],
        )
        .join("\n"),
    ),
  );
  // Linked machines can't be picked in the filters, so they show only while nothing is filtered.
  const linkedMachines =
    selectedProjectKey === null && selectedTargets.length === availableTargets.length
      ? pickLinkedMachineTasks({
          lists: linkedLists,
          readsLive: (id) => availableTargets.some((target) => target.environmentId === id),
        })
      : [];
  const editTask = (environmentId: EnvironmentId, task: ScheduledTask) => {
    startEditor({
      environmentId,
      environmentLabel: labelOf(environmentId),
      draft: editDraft(task),
    });
    navigation.navigate("SettingsScheduledTaskEdit");
  };
  const duplicateTask = (environmentId: EnvironmentId, task: ScheduledTask) => {
    startEditor({
      environmentId,
      environmentLabel: labelOf(environmentId),
      draft: duplicateDraft(task, t("{name} (copy)", { name: task.title })),
    });
    navigation.navigate("SettingsScheduledTaskNew");
  };
  const newTask = () => {
    if (visibleEnvironments.length === 0) return;
    resetEditor();
    navigation.navigate("SettingsScheduledTaskNew");
  };

  const newTaskHeaderItem = withNativeGlassHeaderItem({
    type: "button",
    label: "",
    accessibilityLabel: t("New task"),
    icon: { type: "sfSymbol", name: "plus" } as const,
    disabled: visibleEnvironments.length === 0,
    onPress: newTask,
  });

  return (
    <>
      {props.workspace && Platform.OS === "ios" ? (
        <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
      ) : null}
      <SettingsEnvironmentFilterHeader trailingItems={[newTaskHeaderItem]} />
      <SettingsScreen
        title={t("Scheduled tasks")}
        workspaceRoot={props.workspace}
        trailing={
          <View className="flex-row items-center">
            <AndroidSettingsEnvironmentFilter />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("New task")}
              accessibilityState={{ disabled: visibleEnvironments.length === 0 }}
              disabled={visibleEnvironments.length === 0}
              onPress={newTask}
              className="size-11 items-center justify-center rounded-full disabled:opacity-50"
            >
              <SymbolView name="plus" size={22} tintColorClassName="accent-icon" />
            </Pressable>
          </View>
        }
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-5 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {grouped
            ? taskGroupSections.map((section) => (
                <ScheduledTaskGroupSection
                  key={section.key ?? NO_GROUP_PREFERENCE_KEY}
                  label={section.label}
                  groupKey={section.key}
                  items={section.items}
                  environments={visibleEnvironments}
                  statsLists={statsLists}
                  collapsed={collapsedKeys.isCollapsed(section.key ?? NO_GROUP_PREFERENCE_KEY)}
                  onToggle={() => collapsedKeys.toggle(section.key ?? NO_GROUP_PREFERENCE_KEY)}
                  now={now}
                  labelOf={labelOf}
                  projectIdsFor={projectIdsFor}
                  projectNameOf={projectNameOf}
                  onEdit={editTask}
                  onDuplicate={duplicateTask}
                  onOpenRuns={(environmentId, task) =>
                    navigation.navigate("SettingsScheduledTaskRuns", {
                      environmentId,
                      taskId: task.id,
                      title: task.title,
                    })
                  }
                />
              ))
            : null}
          {!grouped && sharedGroups.length > 0 ? (
            <SettingsSection title={t("On more than one machine")}>
              {sharedGroups.map((group, index) => (
                <SharedTaskRow
                  key={group.primary.task.id}
                  group={group}
                  first={index === 0}
                  now={now}
                  labelOf={labelOf}
                  onEdit={editTask}
                  onDuplicate={duplicateTask}
                />
              ))}
            </SettingsSection>
          ) : null}
          {visibleEnvironments.length > 0 ? (
            visibleEnvironments.map((environment) => (
              <EnvironmentTasks
                key={environment.environmentId}
                environment={environment}
                grouping={grouped ? { kind: "status" } : undefined}
                now={now}
                projectIds={projectIdsFor(environment.environmentId)}
                projectNameOf={(projectId) => projectNameOf(environment.environmentId, projectId)}
                sharedCopies={
                  sharedGroups.filter((group) =>
                    group.copies.some((copy) => copy.environmentId === environment.environmentId),
                  ).length
                }
                onEdit={(task) => editTask(environment.environmentId, task)}
                onDuplicate={(task) => duplicateTask(environment.environmentId, task)}
                onOpenRuns={(task) =>
                  navigation.navigate("SettingsScheduledTaskRuns", {
                    environmentId: environment.environmentId,
                    taskId: task.id,
                    title: task.title,
                  })
                }
              />
            ))
          ) : (
            <Text className="px-2 text-base text-foreground-muted">
              {availableTargets.length === 0
                ? t("Connect an environment to view and create scheduled tasks.")
                : t("No environments match these filters. Change the filter above.")}
            </Text>
          )}
          {linkedMachines.map(({ machine, via }) => (
            <LinkedMachineTasks
              key={machine.environmentId}
              machine={machine}
              via={labelOf(via)}
              now={now}
            />
          ))}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

// The "New task" action and takeScheduledTaskNewLink clear the editor before
// this screen opens, so it starts from the default target.
export function SettingsScheduledTaskNewRouteScreen() {
  return <SettingsScheduledTaskEditorScreen title={t("New scheduled task")} />;
}

export function SettingsScheduledTaskEditRouteScreen() {
  return <SettingsScheduledTaskEditorScreen title={t("Edit scheduled task")} />;
}

function SettingsScheduledTaskEditorScreen({ title }: { readonly title: string }) {
  const { editor, voiceOwnerKey, readEditor, setEditor, hasChanges, draftForEnvironment } =
    useScheduledTaskEditor();
  const { availableTargets } = useSettingsEnvironmentFilter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [saving, setSaving] = useState(false);
  // Set once the save lands, so the removal guard lets the editor close.
  const saved = useRef(false);
  const ownerKey = editor ? `${voiceOwnerKey}:${editor.environmentId}` : null;
  const prompt = editor?.draft.prompt ?? "";
  const [selectionState, setSelectionState] = useState<{
    readonly ownerKey: string | null;
    readonly selection: ComposerEditorSelection;
  } | null>(null);
  const selection =
    selectionState?.ownerKey === ownerKey
      ? selectionState.selection
      : { start: prompt.length, end: prompt.length };
  const setSelection = (next: ComposerEditorSelection) =>
    setSelectionState({ ownerKey, selection: next });
  const setPrompt = (next: string) =>
    setEditor((current) =>
      current
        ? {
            ...current,
            draft: { ...current.draft, prompt: next },
          }
        : current,
    );
  const voiceInput = useVoiceInputController({
    ownerKey,
    label: editor?.draft.title.trim() || title,
    subscribeToDraftChanges: (onChange) =>
      appAtomRegistry.subscribe(scheduledTaskEditorSessionAtom, onChange),
    selection,
    readDraftMessage: () => {
      const current = readEditor();
      if (current?.environmentId !== editor?.environmentId) return null;
      return current?.draft.prompt ?? null;
    },
    onChangeSelection: setSelection,
    onChangeDraftMessage: (text) => {
      if (readEditor()?.environmentId === editor?.environmentId) setPrompt(text);
    },
    disabled: saving,
  });
  const preventRemove = hasChanges || saving;
  usePreventRemove(preventRemove, ({ data }) => {
    if (saved.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (saving) {
      Dialog.alert(t("Saving task"), t("Wait for the task to finish saving before leaving."));
      return;
    }
    Dialog.alert(t("Discard changes?"), t("Your unsaved changes will be lost."), [
      { text: t("Keep editing"), style: "cancel" },
      {
        text: t("Discard changes"),
        style: "destructive",
        onPress: () => {
          if (voiceInput.isBusy) voiceInput.cancel();
          discardScheduledTaskEditor();
          navigation.dispatch(data.action);
        },
      },
    ]);
  });
  return (
    <SettingsScreen title={title}>
      {Platform.OS === "ios" ? (
        <NativeStackScreenOptions
          options={{
            headerBackVisible: false,
            gestureEnabled: !preventRemove,
            // Native Back pops before removal guards; a bar action lets the guard run first.
            unstable_headerLeftItems: () => [
              withNativeGlassHeaderItem({
                type: "button",
                label: "",
                accessibilityLabel: t("Back"),
                icon: { type: "sfSymbol", name: "chevron.backward" },
                onPress: () => navigation.goBack(),
              }),
            ],
          }}
        />
      ) : null}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {editor ? (
          <TaskForm
            key={editor.environmentId}
            environmentId={editor.environmentId}
            environmentLabel={
              availableTargets.find((target) => target.environmentId === editor.environmentId)
                ?.label ?? editor.environmentLabel
            }
            availableTargets={availableTargets}
            draft={editor.draft}
            saving={saving}
            setSaving={setSaving}
            dictationPending={voiceInput.blocksSubmission}
            promptField={
              <ScheduledTaskPromptField
                value={prompt}
                onChange={setPrompt}
                selection={selection}
                onChangeSelection={setSelection}
                disabled={saving}
                voiceInput={voiceInput}
              />
            }
            setDraft={(draft) => {
              if (!saving) setEditor({ ...editor, draft });
            }}
            onSaved={() => {
              saved.current = true;
              markScheduledTaskEditorSaved();
              if (navigation.isFocused()) navigation.goBack();
            }}
            onChangeEnvironment={(target) => {
              if (target.environmentId === editor.environmentId) return;
              setEditor({
                environmentId: target.environmentId,
                environmentLabel: target.label,
                draft: {
                  ...draftForEnvironment(target.environmentId),
                  title: editor.draft.title,
                  group: editor.draft.group,
                  prompt: editor.draft.prompt,
                  promptSource: editor.draft.promptSource,
                  promptFile: editor.draft.promptFile,
                  schedule: editor.draft.schedule,
                  enabled: editor.draft.enabled,
                  runCondition: editor.draft.runCondition,
                },
              });
            }}
          />
        ) : (
          <Text className="px-2 text-base text-foreground-muted">
            {availableTargets.length === 0
              ? t("Connect an environment to create a scheduled task.")
              : t(
                  "No environments match the current filters. Change the filters to create a task.",
                )}
          </Text>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function TaskForm({
  environmentId,
  environmentLabel,
  availableTargets,
  draft,
  saving,
  setSaving,
  dictationPending,
  promptField,
  setDraft,
  onSaved,
  onChangeEnvironment,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly availableTargets: readonly SettingsTarget[];
  readonly draft: Draft;
  readonly saving: boolean;
  readonly setSaving: (saving: boolean) => void;
  readonly dictationPending: boolean;
  readonly promptField: ReactNode;
  readonly setDraft: (draft: Draft) => void;
  readonly onSaved: () => void;
  readonly onChangeEnvironment: (target: SettingsTarget) => void;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<ScheduledTaskRoutes>>();
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  // Pinned first. The chosen project stays listed after it is archived.
  const projects = useProjects()
    .filter(
      (project) =>
        project.environmentId === environmentId &&
        (project.archivedAt == null ||
          project.id === draft.projectId ||
          project.id === draft.task?.projectId),
    )
    .sort((left, right) => Number(right.pinnedAt != null) - Number(left.pinnedAt != null));
  const config = useEnvironmentServerConfig(environmentId);
  const serverConfigs = useServerConfigs();
  const modelOptions = buildModelOptions(config, null, undefined, draft.projectId);
  // A task bound to a thread runs that thread's model, so the default does not apply to it.
  const offersShared = config?.environment.capabilities.sharedScheduledTasks === true;
  const sharing = offersShared && draft.shared;
  const sharingTargetIds = availableTargets
    .filter((target) => target.serverConfig.environment.capabilities.sharedScheduledTasks === true)
    .map((target) => target.environmentId);
  const sharedSnapshots = useSharedScheduledTaskSnapshots();
  const draftProject = projects.find((project) => project.id === draft.projectId);
  const sharedProject = sharedProjectReference({
    editedShared: draft.task?.shared,
    editedProjectId: draft.task?.projectId,
    project: draftProject,
  });
  const storedMachineOrder =
    sharedProject === null ? null : newestProjectMachineOrder(sharedSnapshots, sharedProject);
  const machineOrder = visibleMachineOrder(
    seedMachineOrder(storedMachineOrder, sharingTargetIds, environmentId),
    sharingTargetIds,
  );
  const [openedAt] = useState(Date.now);
  const targetLabel = (id: EnvironmentId) =>
    availableTargets.find((target) => target.environmentId === id)?.label ?? id;
  const linkWarnings = oneMachineLinkWarnings(
    sharedSnapshots,
    effectiveOneMachineOrder(machineOrder, draft.sharedExcludedEnvironmentIds, sharingTargetIds),
    openedAt,
  ).map((warning) => describeOneMachineLinkWarning(warning, targetLabel));
  const offersDefaultModel =
    config?.environment.capabilities.scheduledTaskDefaultModel === true &&
    (sharing || !draft.task?.threadId);
  const followsDefaultModel = offersDefaultModel && draft.followsDefaultModel;
  const offersCatchUp = config?.environment.capabilities.scheduledTaskRunHistory === true;
  const offersGroups = config?.environment.capabilities.scheduledTaskGroups === true;
  const groupSuggestions = scheduledTaskGroupLabels(
    useAtomValue(
      scheduledTaskListsAtom(
        availableTargets
          .filter((target) => target.serverConfig.environment.capabilities.scheduledTaskGroups)
          .map((target) => target.environmentId)
          .join("\n"),
      ),
    ).flatMap(({ tasks }) => tasks.map((task) => task.group)),
  );
  const catchUpMissedRun =
    draft.catchUpMissedRun ??
    defaultCatchUpMissedRun({
      type: "fixed_time",
      timeOfDay: draft.schedule.timeOfDay,
      weekdays: draft.schedule.weekdays,
    });
  const taskModel = followsDefaultModel
    ? (scheduledTaskDefaultModel(
        config,
        projects.find((project) => project.id === draft.projectId) ?? null,
        resolveInheritedDefaultModelSelection({
          configs: serverConfigs,
          environmentId,
          projectId: draft.projectId,
          preferredEnvironmentId: null,
        }),
      ) ?? draft.modelSelection)
    : draft.modelSelection;
  const modelLabel =
    modelOptions.find(
      (option) =>
        option.selection.instanceId === taskModel?.instanceId &&
        option.selection.model === taskModel?.model,
    )?.label ?? taskModel?.model;
  // With Auto mode off, an Auto task runs the model it names.
  const autoOn =
    taskModel?.autoAccount === true &&
    config?.environment.capabilities.autoMode === true &&
    autoModePick({ settings: config.settings, accounts: config.providers, lockedDriver: null }) !==
      null;
  // Existing webhook tasks keep the option so they can still switch to a timer.
  const webhookDenial = managedCapabilityDenial(config?.managedPolicy, "webhookTasks");
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const upsert = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
    reportFailure: false,
  });
  const submissionPending = useRef(false);
  const [timePickerOpen, setTimePickerOpen] = useState(false);
  const [runAtPicker, setRunAtPicker] = useState<"date" | "time" | null>(null);
  const taskMissing =
    draft.task !== null &&
    tasks.data !== null &&
    !tasks.data.tasks.some((task) => task.id === draft.task?.id);
  const environmentUnavailable = !availableTargets.some(
    (target) => target.environmentId === environmentId,
  );

  const failure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(title, String(squashAtomCommandFailure(result)));
    }
  };

  const targetSupportsRunConditions =
    config?.environment.capabilities.scheduledTaskRunConditions === true;
  const offersRunCondition = targetSupportsRunConditions && draft.schedule.mode !== "webhook";
  const runConditionLost = runConditionLostOnTarget({ targetSupportsRunConditions, draft });
  const supportsPromptFiles = config?.environment.capabilities.scheduledTaskPromptFiles === true;
  const offersDelegateProviders =
    config?.environment.capabilities.scheduledTaskDelegateProviders === true;
  const delegateProviderChoices = [
    ...new Set([
      ...(config?.providers ?? []).map((provider) => provider.driver),
      ...draft.delegateProviders,
    ]),
  ];
  const promptSource = effectivePromptSource({ supportsPromptFiles, draft });
  const promptFileLost = promptFileLostOnTarget({
    supportsPromptFiles,
    isWebhook: draft.schedule.mode === "webhook",
    draft,
  });
  const promptFileRead = promptFileReadFor(draft);
  const offersOnce =
    config?.environment.capabilities.oneTimeSchedules === true ||
    draft.task?.schedule.type === "once";
  const save = async () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      submissionPending.current ||
      saving ||
      dictationPending ||
      taskMissing ||
      environmentUnavailable
    )
      return;
    // Preserve signatures edited on other clients by sending the task's current value.
    const liveTask = tasks.data?.tasks.find((task) => task.id === draft.task?.id);
    const schedule = scheduleFromDraft(
      draft.schedule.mode === "webhook" && liveTask?.schedule.type === "webhook"
        ? { ...draft.schedule, signature: liveTask.schedule.signature }
        : draft.schedule,
    );
    if (
      draft.schedule.mode === "webhook" &&
      parseMaxDeliveryAge(draft.schedule.maxDeliveryAgeMinutes) === undefined
    ) {
      Dialog.alert(
        t("Invalid age limit"),
        t("Enter whole minutes from 1 to {max}, or leave it blank.", {
          max: MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
        }),
      );
      return;
    }
    if (draft.schedule.mode === "once" && !offersOnce) {
      Dialog.alert(
        t("Once is not available here"),
        t(
          "This environment runs an older T3.CodeShip. Update it to schedule a one-time task, or pick another schedule.",
        ),
      );
      return;
    }
    const parsedFilters = parseWebhookFilterDrafts(draft.schedule.filters);
    if (draft.schedule.mode === "webhook" && "error" in parsedFilters) {
      Dialog.alert(t("Invalid filter"), parsedFilters.error);
      return;
    }
    if (draft.schedule.mode === "webhook" && schedule === null) {
      Dialog.alert(
        t("Invalid webhook settings"),
        t(
          "Each dedupe key must contain a valid request placeholder. The coalesce window must be whole seconds from 10 to 3600, or blank.",
        ),
      );
      return;
    }
    if (
      !draft.title.trim() ||
      (promptSource === "file" ? !draft.promptFile.trim() : !draft.prompt.trim()) ||
      !draft.projectId ||
      !taskModel ||
      !schedule ||
      (draft.workspace === "existing_worktree" && !draft.checkoutPath.trim())
    ) {
      Dialog.alert(
        t("Incomplete task"),
        t("Add a name, prompt, project, model, valid schedule, and checkout path if needed."),
      );
      return;
    }
    if (promptSource === "file") {
      const problem = promptFileDraftProblem({
        promptFile: draft.promptFile,
        isWebhook: draft.schedule.mode === "webhook",
      });
      if (problem !== undefined) {
        Dialog.alert(t("Invalid prompt file"), problem);
        return;
      }
    }
    if (!projects.some((project) => project.id === draft.projectId)) {
      Dialog.alert(t("Project unavailable"), t("Choose a project in this environment."));
      return;
    }
    if (runConditionLost) {
      Dialog.alert(
        t("Check would be dropped"),
        t("{machine} cannot run checks. Remove the check or pick another machine.", {
          machine: environmentLabel,
        }),
      );
      return;
    }
    if (promptFileLost) {
      Dialog.alert(
        t("Prompt file would be dropped"),
        t(
          "{machine} cannot read prompts from files. Use the text instead or pick another machine.",
          { machine: environmentLabel },
        ),
      );
      return;
    }
    const runCondition = offersRunCondition ? runConditionInput(draft.runCondition) : null;
    if (runCondition === undefined) {
      Dialog.alert(t("Invalid check"), runConditionInvalidText());
      return;
    }
    const input: ScheduledTaskUpsertInput = {
      ...(draft.task ? { id: draft.task.id, requireExisting: true } : {}),
      title: draft.title.trim(),
      ...promptUpsertFields({ supportsPromptFiles, draft }),
      projectId: draft.projectId,
      modelSelection: taskModel,
      ...(offersDefaultModel ? { followsDefaultModel } : {}),
      // Untouched on a new task, the server applies the schedule's default.
      ...(offersCatchUp && draft.schedule.mode === "fixed_time" && draft.catchUpMissedRun !== null
        ? { catchUpMissedRun: draft.catchUpMissedRun }
        : {}),
      ...scheduledTaskGroupUpsertField({
        supported: offersGroups,
        group: draft.group,
        hadGroup: (liveTask ?? draft.task)?.group != null,
      }),
      schedule,
      ...(offersRunCondition ? { runCondition } : {}),
      ...(offersDelegateProviders ? { delegateProviders: draft.delegateProviders } : {}),
      enabled: draft.enabled,
      threadId: sharing ? null : (draft.task?.threadId ?? null),
      workspaceStrategy:
        draft.workspace === "root"
          ? { type: "root" }
          : draft.workspace === "existing_worktree"
            ? { type: "existing_worktree", worktreePath: draft.checkoutPath.trim() }
            : {
                type: "worktree",
                baseRef: draft.baseRef.trim() || "main",
                startFromOrigin: draft.startFromOrigin,
              },
      // Tasks have no mode picker; a mode above the administrator's ceiling is refused.
      runtimeMode:
        clampManagedRuntimeMode(config?.managedPolicy, draft.runtimeMode) ?? draft.runtimeMode,
      interactionMode: draft.task?.interactionMode ?? "default",
      creationSource: draft.task?.creationSource ?? "mobile",
      ...sharedUpsertField({
        supported: offersShared,
        shared: draft.shared,
        wasShared: (liveTask ?? draft.task)?.shared != null,
        excludedEnvironmentIds: draft.sharedExcludedEnvironmentIds,
        runOn: draft.sharedRunOn,
        ...(sharedProject !== null && storedMachineOrder === null ? { machineOrder } : {}),
      }),
    };
    submissionPending.current = true;
    setSaving(true);
    const result = await upsert({ environmentId, input });
    setSaving(false);
    if (result._tag === "Failure") {
      submissionPending.current = false;
      failure(t("Could not save task"), result);
      return;
    }
    onSaved();
  };

  return (
    <View className="gap-5">
      <View
        className="gap-5"
        pointerEvents={saving ? "none" : "auto"}
        accessibilityElementsHidden={saving}
        importantForAccessibility={saving ? "no-hide-descendants" : "auto"}
      >
        {taskMissing ? (
          <Text className="px-1 text-base text-danger-foreground">
            {t("This task no longer exists.")}
          </Text>
        ) : null}

        {environmentUnavailable ? (
          <Text className="px-1 text-base text-danger-foreground">
            {t("This environment is disconnected. Reconnect before saving.")}
          </Text>
        ) : null}
        <SettingsSection>
          <SelectRow
            label={t("Runs on")}
            value={environmentLabel}
            valueIcon={
              <EnvironmentMachineSymbol
                kind={resolveEnvironmentMachineKind(config)}
                size={18}
                tintColorClassName="accent-foreground-muted"
              />
            }
            actions={
              draft.task || saving || dictationPending
                ? []
                : availableTargets.map((target) => ({
                    id: target.environmentId,
                    title: target.label,
                    image:
                      ENVIRONMENT_MACHINE_SYMBOLS[
                        resolveEnvironmentMachineKind(target.serverConfig)
                      ],
                    state: target.environmentId === environmentId ? "on" : undefined,
                  }))
            }
            onSelect={(id) => {
              const target = availableTargets.find((entry) => entry.environmentId === id);
              if (target) onChangeEnvironment(target);
            }}
          />
          {offersShared ? (
            <View className="gap-3 border-t border-border-subtle px-4 py-3">
              <SegmentedControl
                variant="card"
                options={[
                  { value: "this", label: t("Only {machine}", { machine: environmentLabel }) },
                  { value: "every", label: t("Every machine") },
                  { value: "one", label: t("One machine") },
                ]}
                selected={draft.shared ? draft.sharedRunOn : "this"}
                onSelect={(choice) =>
                  setDraft({
                    ...draft,
                    shared: choice !== "this",
                    sharedRunOn: choice === "one" ? "one" : "every",
                    // Shared tasks never use a webhook, so a webhook draft falls back to a time.
                    schedule:
                      choice !== "this" && draft.schedule.mode === "webhook"
                        ? { ...draft.schedule, mode: "fixed_time" }
                        : draft.schedule,
                  })
                }
              />
              {draft.shared && draft.sharedRunOn === "one" ? (
                <View
                  accessible
                  accessibilityLabel={t("Machine order for {project}", {
                    project: draftProject?.title ?? t("this project"),
                  })}
                  className="gap-1"
                >
                  <Text className="text-sm text-foreground-muted">
                    {t(
                      "Order for {project}, used by all its one-machine tasks. The first machine that's online runs each run; the next one runs it if the first is offline or its run fails.",
                      { project: draftProject?.title ?? t("this project") },
                    )}
                  </Text>
                  {machineOrder.map((id, index) => (
                    <Text key={id} className="text-sm text-foreground">
                      {`${index + 1}. ${targetLabel(id)}`}
                    </Text>
                  ))}
                  {linkWarnings.map((warning) => (
                    <Text key={warning} className="text-sm text-warning-foreground">
                      {warning}
                    </Text>
                  ))}
                  {linkWarnings.length > 0 ? (
                    <Text className="text-sm text-foreground-muted">
                      {t("A machine that can't check the ones ahead of it runs the task anyway.")}
                    </Text>
                  ) : null}
                </View>
              ) : draft.shared ? (
                <Text className="text-sm text-foreground-muted">
                  {t(
                    "Keeps a copy on each machine, in sync. Each machine runs it on its own schedule.",
                  )}
                </Text>
              ) : null}
            </View>
          ) : null}
        </SettingsSection>
        <SettingsSection title={t("Task")}>
          <FormField
            label={t("Name")}
            disabled={saving}
            value={draft.title}
            placeholder={t("Check for issues")}
            onChange={(title) => setDraft({ ...draft, title })}
          />
          {offersGroups ? (
            <GroupField
              value={draft.group}
              suggestions={groupSuggestions}
              disabled={saving}
              onChange={(group) => setDraft({ ...draft, group })}
            />
          ) : null}
          {supportsPromptFiles ? (
            <View className="gap-2 border-t border-border-subtle px-4 py-3">
              <Text className="text-sm text-foreground-muted">{t("Prompt")}</Text>
              <SegmentedControl
                variant="card"
                options={[
                  { value: "text" as const, label: t("Write it here") },
                  // The control cannot disable one option, so a webhook task leaves it out.
                  ...(draft.schedule.mode === "webhook"
                    ? []
                    : [{ value: "file" as const, label: t("Read from a file") }]),
                ]}
                selected={promptSource}
                onSelect={(choice) => setDraft({ ...draft, promptSource: choice })}
              />
              {draft.schedule.mode === "webhook" ? (
                <Text className="text-sm text-foreground-muted">
                  {t("A webhook task fills its prompt from each request.")}
                </Text>
              ) : null}
            </View>
          ) : null}
          {promptSource === "file" ? (
            <>
              <FormField
                label={t("Prompt file")}
                disabled={saving}
                technical
                borderTop
                value={draft.promptFile}
                placeholder={"automations/daily.md"}
                onChange={(promptFile) => setDraft({ ...draft, promptFile })}
              />
              <View className="gap-2 px-4 pb-3">
                <Text className="text-sm text-foreground-muted">
                  {t(
                    "A path from the root of the project's repository. Each run reads it from the remote's default branch, so a push changes the next run.",
                  )}
                </Text>
                {promptFileRead ? (
                  <>
                    <Text className="text-sm text-foreground-muted">
                      {t("Read from {ref} at {commit} on {date}", {
                        ref: promptFileRead.ref,
                        commit: promptFileRead.commit.slice(0, 7),
                        date: formatScheduledTaskRunTime(promptFileRead.at),
                      })}
                    </Text>
                    <Text className="text-sm text-foreground-muted">{t("Text it read")}</Text>
                    <NativeScrollView className="max-h-64" nestedScrollEnabled>
                      <Text selectable className="text-base text-foreground">
                        {draft.prompt}
                      </Text>
                    </NativeScrollView>
                  </>
                ) : draft.task && draft.savedPromptFile === draft.promptFile.trim() ? (
                  <Text className="text-sm text-foreground-muted">
                    {t("Not read on this machine yet. Saving or the next run reads it.")}
                  </Text>
                ) : null}
              </View>
            </>
          ) : (
            promptField
          )}
          {promptFileLost ? (
            <View className="gap-3 border-t border-border-subtle px-4 py-3">
              <Text className="text-sm text-warning-foreground">
                {t(
                  "{machine} runs an older T3.CodeShip that cannot read prompts from files. Saving there would replace {path} with the text above.",
                  { machine: environmentLabel, path: draft.promptFile.trim() },
                )}
              </Text>
              <Button
                label={t("Use the text")}
                disabled={saving}
                onPress={() => setDraft({ ...draft, promptSource: "text" })}
              />
            </View>
          ) : null}
        </SettingsSection>

        <SettingsSection title={t("Context")}>
          <SelectRow
            label={t("Project")}
            value={
              projects.find((project) => project.id === draft.projectId)?.title ??
              (projects.length ? t("Choose project") : t("No projects available"))
            }
            actions={projects.map((project) => ({
              id: project.id,
              title: project.title,
              state: project.id === draft.projectId ? "on" : undefined,
            }))}
            onSelect={(id) => {
              const project = projects.find((item) => item.id === id);
              if (!project) return;
              const keepsExplicitModel =
                draft.modelSelectionIsExplicit &&
                (draft.modelSelection === null ||
                  !config?.settings ||
                  resolveProjectProviderInstanceEnabled(
                    config.settings,
                    project.id,
                    draft.modelSelection.instanceId,
                  ));
              setDraft({
                ...draft,
                projectId: project.id,
                modelSelection: keepsExplicitModel
                  ? draft.modelSelection
                  : scheduledTaskDefaultModel(
                      config,
                      project,
                      resolveInheritedDefaultModelSelection({
                        configs: serverConfigs,
                        environmentId,
                        projectId: project.id,
                        preferredEnvironmentId: null,
                      }),
                    ),
                modelSelectionIsExplicit: keepsExplicitModel,
              });
            }}
          />
          {offersDefaultModel ? (
            <View className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3">
              <View className="min-w-0 flex-1">
                <Text textRole="body" className="text-foreground">
                  {t("Use default model")}
                </Text>
                <Text className="text-sm text-foreground-muted">
                  {t("Runs the scheduled tasks model from Settings › Threads.")}
                </Text>
              </View>
              <ThemedSwitch
                accessibilityLabel={t("Use default model")}
                value={draft.followsDefaultModel}
                disabled={saving || dictationPending || environmentUnavailable}
                onValueChange={(value) => setDraft({ ...draft, followsDefaultModel: value })}
              />
            </View>
          ) : null}
          <PickerRow
            label={t("Model")}
            borderTop
            value={
              modelLabel === undefined
                ? modelOptions.length
                  ? t("Choose model")
                  : t("No models available")
                : autoOn
                  ? t("Auto · {model}", { model: modelLabel })
                  : modelLabel
            }
            onPress={() => navigation.navigate("SettingsScheduledTaskModel")}
            disabled={saving || dictationPending || environmentUnavailable || followsDefaultModel}
          />
        </SettingsSection>

        <SettingsSection title={t("Workspace")}>
          <SelectRow
            label={t("Run in")}
            value={
              draft.workspace === "worktree"
                ? t("New worktree")
                : draft.workspace === "root"
                  ? t("Project checkout")
                  : t("Specific checkout")
            }
            actions={[
              {
                id: "worktree",
                title: t("New worktree"),
                state: draft.workspace === "worktree" ? "on" : undefined,
              },
              {
                id: "root",
                title: t("Project checkout"),
                state: draft.workspace === "root" ? "on" : undefined,
              },
              {
                id: "existing_worktree",
                title: t("Specific checkout"),
                state: draft.workspace === "existing_worktree" ? "on" : undefined,
              },
            ]}
            onSelect={(id) => {
              if (id === "worktree" || id === "root" || id === "existing_worktree")
                setDraft({ ...draft, workspace: id });
            }}
          />
          {draft.workspace === "worktree" ? (
            <PickerRow
              label={t("Base branch")}
              value={resolveNewTaskBranchLabel({
                branchName: draft.baseRef,
                startFromOrigin: draft.startFromOrigin,
                workspaceMode: "worktree",
              })}
              borderTop
              disabled={!draft.projectId || saving || dictationPending || environmentUnavailable}
              onPress={() => navigation.navigate("SettingsScheduledTaskBranch")}
            />
          ) : null}
          {draft.workspace === "existing_worktree" ? (
            <FormField
              label={t("Checkout path")}
              disabled={saving}
              value={draft.checkoutPath}
              borderTop
              onChange={(checkoutPath) =>
                setDraft({
                  ...draft,
                  checkoutPath: resolvePastedPath(draft.checkoutPath, checkoutPath),
                })
              }
            />
          ) : null}
        </SettingsSection>

        <SettingsSection title={t("Schedule")}>
          <View className="px-4 py-3">
            <SegmentedControl
              variant="card"
              options={[
                { value: "fixed_time", label: t("At a time") },
                // Older servers reject one-time schedules on save.
                ...(offersOnce || draft.schedule.mode === "once"
                  ? [{ value: "once" as const, label: t("Once") }]
                  : []),
                { value: "interval", label: t("Interval") },
                ...(!sharing && (webhookDenial === undefined || draft.schedule.mode === "webhook")
                  ? [{ value: "webhook" as const, label: t("On webhook") }]
                  : []),
              ]}
              selected={draft.schedule.mode}
              onSelect={(mode) => {
                setTimePickerOpen(false);
                setRunAtPicker(null);
                setDraft({
                  ...draft,
                  prompt:
                    mode === "webhook" && !draft.prompt.trim()
                      ? DEFAULT_WEBHOOK_PROMPT
                      : draft.prompt,
                  schedule: {
                    ...draft.schedule,
                    mode,
                    runAt:
                      mode === "once" && !draft.schedule.runAt
                        ? new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000).toISOString()
                        : draft.schedule.runAt,
                  },
                });
              }}
            />
          </View>
          {draft.schedule.mode === "fixed_time" ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Time, {time}", {
                  time: formatTime(draft.schedule.timeOfDay),
                })}
                onPress={() => setTimePickerOpen((open) => !open)}
                className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
              >
                <Text textRole="body" className="text-foreground">
                  {t("Time")}
                </Text>
                <Text
                  textRole="footnote"
                  className="min-w-0 flex-1 text-right text-foreground-muted"
                >
                  {formatTime(draft.schedule.timeOfDay)}
                </Text>
                <SymbolView
                  name="chevron.right"
                  size={14}
                  tintColorClassName="accent-chevron"
                  type="monochrome"
                />
              </Pressable>
              {timePickerOpen ? (
                <DateTimePicker
                  value={timePickerValue(draft.schedule.timeOfDay)}
                  mode="time"
                  display={Platform.OS === "ios" ? "spinner" : "default"}
                  onDismiss={() => setTimePickerOpen(false)}
                  onValueChange={(_, selected) => {
                    const timeOfDay = `${String(selected.getHours()).padStart(2, "0")}:${String(selected.getMinutes()).padStart(2, "0")}`;
                    setDraft({ ...draft, schedule: { ...draft.schedule, timeOfDay } });
                  }}
                />
              ) : null}
              <SelectRow
                label={t("Repeat")}
                value={repeatLabel(draft.schedule.weekdays)}
                borderTop
                actions={[
                  {
                    id: "every_day",
                    title: t("Every day"),
                    state: draft.schedule.weekdays.length === 7 ? "on" : undefined,
                  },
                  {
                    id: "weekdays",
                    title: t("Weekdays"),
                    state: isWeekdaysRepeat(draft.schedule.weekdays) ? "on" : undefined,
                  },
                  ...DAYS.map((day) => ({
                    id: String(day.index),
                    title: t(day.label),
                    attributes: { keepsMenuPresented: true },
                    state: draft.schedule.weekdays.includes(day.index)
                      ? ("on" as const)
                      : undefined,
                  })),
                ]}
                onSelect={(id) => {
                  const weekdays =
                    id === "every_day"
                      ? DAYS.map((day) => day.index)
                      : id === "weekdays"
                        ? [1, 2, 3, 4, 5]
                        : (() => {
                            const day = DAYS.find((item) => String(item.index) === id);
                            if (!day) return draft.schedule.weekdays;
                            return draft.schedule.weekdays.includes(day.index)
                              ? draft.schedule.weekdays.filter((index) => index !== day.index)
                              : [...draft.schedule.weekdays, day.index];
                          })();
                  setDraft({ ...draft, schedule: { ...draft.schedule, weekdays } });
                }}
              />
            </>
          ) : draft.schedule.mode === "webhook" && webhookDenial !== undefined && draft.enabled ? (
            <Text className="border-t border-border-subtle px-4 py-3 text-sm text-foreground-muted">
              {t("{reason} Switch the task to a timer, or turn it off, to save it.", {
                reason: webhookDenial,
              })}
            </Text>
          ) : draft.schedule.mode === "once" ? (
            (["date", "time"] as const).map((field) => {
              const runAt = new Date(draft.schedule.runAt);
              const label = field === "date" ? formatRunAtDate(runAt) : formatRunAtTime(runAt);
              return (
                <View key={field}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("{field}, {value}", {
                      field: field === "date" ? t("Date") : t("Time"),
                      value: label,
                    })}
                    onPress={() => setRunAtPicker((open) => (open === field ? null : field))}
                    className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
                  >
                    <Text textRole="body" className="text-foreground">
                      {field === "date" ? t("Date") : t("Time")}
                    </Text>
                    <Text
                      textRole="footnote"
                      className="min-w-0 flex-1 text-right text-foreground-muted"
                    >
                      {label}
                    </Text>
                    <SymbolView
                      name="chevron.right"
                      size={14}
                      tintColorClassName="accent-chevron"
                      type="monochrome"
                    />
                  </Pressable>
                  {runAtPicker === field ? (
                    <DateTimePicker
                      value={runAt}
                      mode={field}
                      display={Platform.OS === "ios" ? "spinner" : "default"}
                      onDismiss={() => setRunAtPicker(null)}
                      onValueChange={(_, selected) => {
                        // Android shows a dialog that closes on pick; iOS stays inline.
                        if (Platform.OS === "android") setRunAtPicker(null);
                        setDraft({
                          ...draft,
                          schedule: { ...draft.schedule, runAt: selected.toISOString() },
                        });
                      }}
                    />
                  ) : null}
                </View>
              );
            })
          ) : draft.schedule.mode === "webhook" ? (
            <>
              <WebhookScheduleDetails
                environmentId={environmentId}
                // Use the live row for rotated URLs; hide the URL once a loaded list no longer contains the task.
                task={
                  tasks.data
                    ? (tasks.data.tasks.find((task) => task.id === draft.task?.id) ?? null)
                    : draft.task
                }
                signatureConfigured={draft.schedule.signature !== null}
                disabled={!canOperate || saving || environmentUnavailable}
              />
              <FormField
                label={t("Skip requests older than (minutes)")}
                value={draft.schedule.maxDeliveryAgeMinutes}
                placeholder={t("Run every request")}
                keyboardType="number-pad"
                disabled={saving}
                borderTop
                onChange={(maxDeliveryAgeMinutes) =>
                  setDraft({ ...draft, schedule: { ...draft.schedule, maxDeliveryAgeMinutes } })
                }
              />
              <WebhookFilterRows
                filters={draft.schedule.filters}
                disabled={saving}
                onChange={(filters) =>
                  setDraft({ ...draft, schedule: { ...draft.schedule, filters } })
                }
              />
              <FormField
                label={t("Duplicate request key")}
                value={draft.schedule.replayKey}
                placeholder={"{{headers.delivery-id}}"}
                disabled={saving}
                borderTop
                onChange={(replayKey) =>
                  setDraft({ ...draft, schedule: { ...draft.schedule, replayKey } })
                }
              />
              <Text className="px-4 pb-3 text-sm text-foreground-muted">
                {t("Requests with the same key run only once within 7 days.")}
              </Text>
              <FormField
                label={t("Coalesce key template")}
                value={draft.schedule.coalesceKey}
                placeholder={"{{body.id}}"}
                disabled={saving}
                borderTop
                onChange={(coalesceKey) =>
                  setDraft({ ...draft, schedule: { ...draft.schedule, coalesceKey } })
                }
              />
              <FormField
                label={t("Coalesce window (seconds, 10–3600)")}
                value={draft.schedule.coalesceWindowSeconds}
                placeholder="120"
                keyboardType="number-pad"
                disabled={saving}
                borderTop
                onChange={(coalesceWindowSeconds) =>
                  setDraft({ ...draft, schedule: { ...draft.schedule, coalesceWindowSeconds } })
                }
              />
              <Text className="px-4 pb-3 text-sm text-foreground-muted">
                {t(
                  "Coalescing runs the latest payload when the window from the first delivery closes. Empty keys run normally.",
                )}
              </Text>
            </>
          ) : (
            <>
              <FormField
                label={t("Minutes between runs")}
                value={draft.schedule.intervalMinutes}
                keyboardType="decimal-pad"
                disabled={saving}
                borderTop
                onChange={(intervalMinutes) =>
                  setDraft({ ...draft, schedule: { ...draft.schedule, intervalMinutes } })
                }
              />
              {!(parseIntervalMinutes(draft.schedule.intervalMinutes) >= 1) ? (
                <Text className="px-4 pb-3 text-sm text-danger-foreground">
                  {t("Intervals must be at least 1 minute. Update this interval before saving.")}
                </Text>
              ) : draft.task?.schedule.type === "interval" &&
                draft.task.schedule.everyMs < 60_000 ? (
                <Text className="px-4 pb-3 text-sm text-foreground-muted">
                  {t(
                    "This task previously ran more than once per minute. Saving requires an interval of at least 1 minute.",
                  )}
                </Text>
              ) : null}
            </>
          )}
          {offersCatchUp && draft.schedule.mode === "fixed_time" ? (
            <View className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3">
              <View className="min-w-0 flex-1">
                <Text textRole="body" className="text-foreground">
                  {t("Catch up a missed run")}
                </Text>
                <Text className="text-sm text-foreground-muted">
                  {t(
                    "If the machine was off or asleep at the time, run once when it is back, unless the next run comes sooner.",
                  )}
                </Text>
              </View>
              <ThemedSwitch
                accessibilityLabel={t("Catch up a missed run")}
                value={catchUpMissedRun}
                disabled={saving || environmentUnavailable}
                onValueChange={(value) => setDraft({ ...draft, catchUpMissedRun: value })}
              />
            </View>
          ) : null}
          <View className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3">
            <Text textRole="body" className="min-w-0 flex-1 text-foreground">
              {t("Enabled")}
            </Text>
            <ThemedSwitch
              accessibilityLabel={t("Task enabled")}
              value={draft.enabled}
              onValueChange={(enabled) => setDraft({ ...draft, enabled })}
            />
          </View>
        </SettingsSection>
        {draft.schedule.mode === "fixed_time" ? (
          <Text className="px-2 text-sm text-foreground-muted">
            {t("Time uses the environment's time zone, which may differ from your phone's.")}
          </Text>
        ) : null}
        {runConditionLost ? (
          <SettingsSection title={t("Check before running")}>
            <View className="gap-3 px-4 py-3">
              <Text className="text-sm text-warning-foreground">
                {t(
                  "{machine} runs an older T3.CodeShip that cannot run checks. Saving there would drop this task's check.",
                  { machine: environmentLabel },
                )}
              </Text>
              <Button
                label={t("Remove check")}
                disabled={saving}
                onPress={() =>
                  setDraft({ ...draft, runCondition: { ...draft.runCondition, command: "" } })
                }
              />
            </View>
          </SettingsSection>
        ) : null}
        {offersRunCondition ? (
          <SettingsSection title={t("Check before running")} footer={runConditionHelpText()}>
            <FormField
              label={t("Check command")}
              value={draft.runCondition.command}
              placeholder={"node ~/scripts/has-work.mjs"}
              technical
              disabled={saving}
              onChange={(command) =>
                setDraft({ ...draft, runCondition: { ...draft.runCondition, command } })
              }
            />
            <FormField
              label={t("Check timeout (seconds)")}
              value={draft.runCondition.timeoutSeconds}
              keyboardType="number-pad"
              disabled={saving || draft.runCondition.command.trim() === ""}
              borderTop
              onChange={(timeoutSeconds) =>
                setDraft({ ...draft, runCondition: { ...draft.runCondition, timeoutSeconds } })
              }
            />
          </SettingsSection>
        ) : null}
        {offersDelegateProviders && delegateProviderChoices.length > 0 ? (
          <SettingsSection
            title={t("Hands work to")}
            footer={t(
              "Providers this task delegates work to. A scheduled run is skipped while every account of one is out of usage.",
            )}
          >
            {delegateProviderChoices.map((driver) => (
              <SettingsSwitchRow
                key={driver}
                label={providerDriverDisplayName(driver)}
                value={draft.delegateProviders.includes(driver)}
                disabled={saving || environmentUnavailable}
                onValueChange={(on) =>
                  setDraft({
                    ...draft,
                    delegateProviders: delegateProviderChoices.filter((choice) =>
                      choice === driver ? on : draft.delegateProviders.includes(choice),
                    ),
                  })
                }
              />
            ))}
          </SettingsSection>
        ) : null}
      </View>
      <Button
        tone="primary"
        fullWidth
        loading={saving}
        disabled={
          !canOperate ||
          dictationPending ||
          taskMissing ||
          environmentUnavailable ||
          // The server refuses an enabled webhook task under this policy.
          (draft.enabled && draft.schedule.mode === "webhook" && webhookDenial !== undefined)
        }
        onPress={() => void save()}
        label={saving ? t("Saving…") : draft.task ? t("Save changes") : t("Create task")}
      />
    </View>
  );
}

function WebhookScheduleDetails({
  environmentId,
  task,
  signatureConfigured,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly signatureConfigured: boolean;
  readonly disabled: boolean;
}) {
  const [rotating, setRotating] = useState(false);
  const rotate = useAtomCommand(serverEnvironment.rotateScheduledTaskWebhookToken, {
    label: "scheduled task rotate webhook token",
    reportFailure: false,
  });
  const preparedConnection = usePreparedConnection(environmentId);
  const httpBaseUrl =
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null;
  const webhook = task?.schedule.type === "webhook" ? task.webhook : undefined;
  const resolved = webhook ? webhookAddress(webhook, httpBaseUrl) : null;
  return (
    <View className="gap-2 border-t border-border-subtle px-4 py-3">
      <Text className="text-sm text-foreground-muted">
        {t(
          "The prompt can use {{body.a.b}}, {{headers.name}}, {{query.name}}, {{body}} and {{request}}. The filled-in prompt is all the agent sees.",
        )}
      </Text>
      {task === null || resolved === null ? (
        <Text className="text-sm text-foreground-muted">
          {t("Save the task to get its webhook URL.")}
        </Text>
      ) : (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Copy webhook URL")}
            accessibilityHint={t("Copies the URL to the clipboard")}
            disabled={!resolved.copyable}
            onPress={() => void tryCopyTextWithHaptic(resolved.address)}
            className="gap-1 active:opacity-70"
          >
            <Text textRole="body" className="text-foreground">
              {resolved.copyable ? t("Webhook URL") : t("Webhook path")}
            </Text>
            <Text className="text-sm text-foreground-muted" numberOfLines={2} selectable>
              {resolved.address}
            </Text>
          </Pressable>
          {resolved.note !== null ? (
            <Text className="text-sm text-foreground-muted">{resolved.note}</Text>
          ) : null}
          <Button
            label={rotating ? t("Rotating…") : t("Rotate URL")}
            tone="danger"
            disabled={disabled || rotating}
            onPress={() =>
              Dialog.alert(t("Rotate URL?"), t("The current URL stops working immediately."), [
                { text: t("Cancel"), style: "cancel" },
                {
                  text: t("Rotate"),
                  style: "destructive",
                  onPress: () => {
                    setRotating(true);
                    void rotate({ environmentId, input: { id: task.id } }).then((result) => {
                      setRotating(false);
                      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                        Dialog.alert(
                          t("Could not rotate URL"),
                          String(squashAtomCommandFailure(result)),
                        );
                      }
                    });
                  },
                },
              ])
            }
            loading={rotating}
          />
        </>
      )}
      {signatureConfigured ? (
        <Text className="text-sm text-foreground-muted">
          {t("Signature check configured on desktop/web.")}
        </Text>
      ) : null}
    </View>
  );
}

function useCollapsedScheduledTaskGroups() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const collapsed = AsyncResult.isSuccess(preferences)
    ? (preferences.value.collapsedScheduledTaskGroups ?? [])
    : [];
  return {
    isCollapsed: (key: string) => collapsed.includes(key),
    toggle: (key: string) =>
      save({
        transform: (current) => {
          const keys = current.collapsedScheduledTaskGroups ?? [];
          return {
            collapsedScheduledTaskGroups: keys.includes(key)
              ? keys.filter((candidate) => candidate !== key)
              : [...keys, key],
          };
        },
      }),
  };
}

/**
 * One group of tasks across the visible machines: a header with its numbers and Pause group, then
 * the shared tasks, then each machine's own tasks (their rows name the machine).
 */
function ScheduledTaskGroupSection({
  label,
  groupKey,
  items,
  environments,
  statsLists,
  collapsed,
  onToggle,
  now,
  labelOf,
  projectIdsFor,
  projectNameOf,
  onEdit,
  onDuplicate,
  onOpenRuns,
}: {
  readonly label: string | null;
  readonly groupKey: string | null;
  readonly items: ReadonlyArray<ScheduledTaskListItem>;
  readonly environments: ReadonlyArray<SettingsTarget>;
  readonly statsLists: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly tasks: ReadonlyArray<ScheduledTaskRunStats>;
  }>;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly now: number;
  readonly labelOf: (environmentId: EnvironmentId) => string;
  readonly projectIdsFor: (environmentId: EnvironmentId) => readonly ProjectId[] | null;
  readonly projectNameOf: (environmentId: EnvironmentId, projectId: ProjectId) => string | null;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
  readonly onDuplicate: (environmentId: EnvironmentId, task: ScheduledTask) => void;
  readonly onOpenRuns: (environmentId: EnvironmentId, task: ScheduledTask) => void;
}) {
  const title = label ?? t("No group");
  const sharedGroups = items.flatMap((item) => (item.kind === "shared" ? [item.group] : []));
  const ownEnvironmentIds = new Set(
    items.flatMap((item) => (item.kind === "local" ? [item.environmentId] : [])),
  );
  // A shared task changes through one copy only; sync carries it to the others.
  const changeable = items.map(scheduledTaskListItemGroupCopy);
  const summary = summarizeScheduledTaskGroup(
    items.flatMap(scheduledTaskListItemCopies),
    (environmentId, taskId) =>
      statsLists
        .find((list) => list.environmentId === environmentId)
        ?.tasks.find((stats) => stats.id === taskId),
  );
  const action =
    groupKey === null ? null : scheduledTaskGroupAction(changeable.map(({ task }) => task));
  const paused = action === "pause";
  const plan = action === null ? [] : scheduledTaskGroupPausePlan(changeable, paused);
  const sharedIds = new Set(sharedGroups.map((group) => group.primary.task.id));
  const sharedChanging = plan.reduce(
    (count, entry) => count + entry.ids.filter((id) => sharedIds.has(id)).length,
    0,
  );
  const canOperate = useAtomValue(
    canOperateAllAtom(plan.map((entry) => entry.environmentId).join("\n")),
  );
  const setGroupPaused = useAtomCommand(serverEnvironment.setScheduledTaskGroupPaused, {
    label: "scheduled task group paused",
    reportFailure: false,
  });
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    const problems: string[] = [];
    await Promise.all(
      plan.map(async ({ environmentId, ids }) => {
        if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
        const result = await setGroupPaused({ environmentId, input: { ids, paused } });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            problems.push(`${labelOf(environmentId)}: ${String(squashAtomCommandFailure(result))}`);
          }
          return;
        }
        for (const refused of result.value.refused) {
          problems.push(`${labelOf(environmentId)}: ${refused.message}`);
        }
      }),
    );
    if (problems.length > 0) {
      Dialog.alert(
        paused ? t("Could not pause group") : t("Could not resume group"),
        problems.join("\n"),
      );
    }
    setRunning(false);
  };
  const confirmAndRun = () => {
    if (sharedChanging === 0) {
      void run();
      return;
    }
    Dialog.alert(
      paused
        ? t("Pause group “{group}”?", { group: title })
        : t("Resume group “{group}”?", { group: title }),
      tn(
        sharedChanging,
        "{count} shared task in this group changes on every machine.",
        "{count} shared tasks in this group change on every machine.",
      ),
      [
        { text: t("Cancel"), style: "cancel" },
        { text: paused ? t("Pause") : t("Resume"), onPress: () => void run() },
      ],
    );
  };
  const hasEnabled = changeable.some(({ task }) => task.enabled);
  const nextRun = !hasEnabled
    ? t("Paused")
    : summary.nextRunAt !== null
      ? formatNextScheduledTaskRun(summary.nextRunAt, now)
      : null;
  const health = summary.health;
  const healthParts =
    health === null
      ? null
      : {
          runs: tn(health.runs, "{count} run", "{count} runs"),
          failed: t("{count} failed", { count: health.failed }),
          limited: t("{count} limited", { count: health.usageLimited }),
        };
  const healthText =
    healthParts === null ? null : t("24h: {runs} · {failed} · {limited}", healthParts);
  const summaryText = [tn(summary.count, "{count} task", "{count} tasks"), nextRun]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <ListSection>
      <View className="flex-row items-center gap-1 pr-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={[title, summaryText, healthText]
            .filter((part) => part !== null)
            .join(". ")}
          accessibilityState={{ expanded: !collapsed }}
          onPress={onToggle}
          className="min-h-14 min-w-0 flex-1 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
        >
          <SymbolView
            name={collapsed ? "chevron.right" : "chevron.down"}
            size={14}
            tintColorClassName="accent-chevron"
            type="monochrome"
          />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text textRole="body" className="font-t3-medium text-foreground" numberOfLines={1}>
              {title}
            </Text>
            <Text className="text-sm text-foreground-muted">{summaryText}</Text>
            {health === null || healthParts === null ? null : (
              <Text className="text-sm text-foreground-muted">
                {tx("24h: {runs} · {failed} · {limited}", {
                  runs: healthParts.runs,
                  failed: (
                    <Text
                      className={
                        health.failed > 0 ? "text-warning-foreground" : "text-foreground-muted"
                      }
                    >
                      {healthParts.failed}
                    </Text>
                  ),
                  limited: (
                    <Text
                      className={
                        health.usageLimited > 0
                          ? "text-warning-foreground"
                          : "text-foreground-muted"
                      }
                    >
                      {healthParts.limited}
                    </Text>
                  ),
                })}
              </Text>
            )}
          </View>
        </Pressable>
        {action === null ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              paused
                ? t("Pause group {group}", { group: title })
                : t("Resume group {group}", { group: title })
            }
            accessibilityState={{ disabled: running || !canOperate || plan.length === 0 }}
            disabled={running || !canOperate || plan.length === 0}
            onPress={confirmAndRun}
            className="min-h-11 justify-center rounded-full px-3 active:opacity-70 disabled:opacity-50"
          >
            <Text className="text-sm text-primary">
              {paused ? t("Pause group") : t("Resume group")}
            </Text>
          </Pressable>
        )}
      </View>
      {collapsed ? null : (
        <>
          {sharedGroups.map((group) => (
            <SharedTaskRow
              key={group.primary.task.id}
              group={group}
              first={false}
              now={now}
              labelOf={labelOf}
              onEdit={onEdit}
              onDuplicate={onDuplicate}
            />
          ))}
          {environments
            .filter((environment) => ownEnvironmentIds.has(environment.environmentId))
            .map((environment) => (
              <EnvironmentTasks
                key={environment.environmentId}
                environment={environment}
                grouping={{ kind: "group", key: groupKey }}
                now={now}
                projectIds={projectIdsFor(environment.environmentId)}
                projectNameOf={(projectId) => projectNameOf(environment.environmentId, projectId)}
                sharedCopies={0}
                onEdit={(task) => onEdit(environment.environmentId, task)}
                onDuplicate={(task) => onDuplicate(environment.environmentId, task)}
                onOpenRuns={(task) => onOpenRuns(environment.environmentId, task)}
              />
            ))}
        </>
      )}
    </ListSection>
  );
}

/**
 * A shared task once, with a line for each machine's copy. Edits, pausing and deleting go to the
 * newest copy and reach the others by sync; running and the last run's thread are per machine.
 */
function SharedTaskRow({
  group,
  first,
  now,
  labelOf,
  onEdit,
  onDuplicate,
}: {
  readonly group: SharedScheduledTaskGroup;
  readonly first: boolean;
  readonly now: number;
  readonly labelOf: (environmentId: EnvironmentId) => string;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
  readonly onDuplicate: (environmentId: EnvironmentId, task: ScheduledTask) => void;
}) {
  const { environmentId, task } = group.primary;
  const openThread = useOpenScheduledTaskThread();
  const snapshots = useSharedScheduledTaskSnapshots();
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
    reportFailure: false,
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run",
    reportFailure: false,
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
    reportFailure: false,
  });
  const setPlacement = useAtomCommand(serverEnvironment.setScheduledTaskPlacement, {
    label: "scheduled task placement",
    reportFailure: false,
  });
  const failure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(title, String(squashAtomCommandFailure(result)));
    }
  };
  const operate = (targetId: EnvironmentId) =>
    readEnvironmentScope(targetId, AuthOrchestrationOperateScope);
  const oneMachine = task.shared?.runOn === "one";
  const runnable = group.copies;
  const openable = group.copies.filter((copy) => lastRunThreadId(copy.task) !== null);
  const placeable = group.copies.filter((copy) => copy.task.placement !== undefined);
  const holders = [
    ...new Set([
      ...group.copies.map((copy) => copy.environmentId),
      ...snapshots.flatMap((snapshot) =>
        snapshot.tasks.some((candidate) => candidate.id === task.id && candidate.shared)
          ? [snapshot.environmentId]
          : [],
      ),
    ]),
  ];
  const machineActions = (prefix: string, copies: typeof group.copies) =>
    copies.map((copy) => ({
      id: `${prefix}:${copy.environmentId}`,
      title: labelOf(copy.environmentId),
    }));
  const confirmDelete = () =>
    Dialog.alert(
      t("Delete on every machine?"),
      t(
        "“{name}” is shared, so this deletes it on {machines} and on any other machine with a copy. This cannot be undone.",
        {
          name: task.title,
          machines: holders.map(labelOf).join(", "),
        },
      ),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Delete"),
          style: "destructive",
          onPress: () => {
            if (!operate(environmentId)) return;
            void remove({ environmentId, input: { id: task.id } }).then((result) =>
              failure(t("Could not delete task"), result),
            );
          },
        },
      ],
    );
  const copyFor = (prefix: string, action: string) =>
    group.copies.find((copy) => action === `${prefix}:${copy.environmentId}`);

  return (
    <View
      className={
        first
          ? "flex-row items-start gap-1 px-4 py-3"
          : "flex-row items-start gap-1 border-t border-border-subtle px-4 py-3"
      }
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          oneMachine
            ? t("Edit {title}, runs on one machine", { title: task.title })
            : t("Edit {title}, runs on every machine", { title: task.title })
        }
        onPress={() => onEdit(environmentId, task)}
        className="min-w-0 flex-1 gap-1 active:opacity-70"
      >
        <Text textRole="body" className="text-foreground" numberOfLines={1}>
          {task.title}
        </Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={2}>
          {describeSchedule(task)}
          {` · ${oneMachine ? t("One machine") : t("Every machine")}`}
          {task.enabled ? "" : ` · ${t("Paused")}`}
        </Text>
        {group.copies.map((copy) => (
          <View key={copy.environmentId} className="gap-0.5">
            <Text className="text-sm text-foreground-muted" numberOfLines={2}>
              {[
                labelOf(copy.environmentId),
                nextRunText(copy.task, now),
                lastRunText(copy.task, now),
                copy.task.modelUnavailableHere ? t("Runs the default model there") : null,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
            </Text>
            {copy.task.lastRunError ? (
              <Text className="text-sm text-danger-foreground" numberOfLines={2}>
                {t("Last run failed: {error}", { error: copy.task.lastRunError })}
              </Text>
            ) : null}
          </View>
        ))}
      </Pressable>
      <Menu
        actions={[
          { id: "edit", title: t("Edit") },
          { id: "duplicate", title: t("Duplicate") },
          ...(openable.length === 1
            ? [{ id: `open-run:${openable[0]!.environmentId}`, title: t("Open last run") }]
            : openable.length > 1
              ? [
                  {
                    id: "open-run",
                    title: t("Open last run on"),
                    subactions: machineActions("open-run", openable),
                  },
                ]
              : []),
          {
            id: "toggle",
            title: task.enabled ? t("Pause on every machine") : t("Resume on every machine"),
            attributes: { disabled: !canOperate },
          },
          runnable.length === 1
            ? {
                id: `run:${environmentId}`,
                title: t("Run now"),
                attributes: { disabled: !canOperate },
              }
            : {
                id: "run",
                title: t("Run now on"),
                attributes: { disabled: !canOperate },
                subactions: machineActions("run", runnable),
              },
          ...(placeable.length === 0
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
                      option.value === resolveScheduledTaskPlacement(placeable[0]!.task)
                        ? ("on" as const)
                        : ("off" as const),
                  })),
                },
              ]),
          {
            id: "delete",
            title: t("Delete on every machine"),
            attributes: { destructive: true, disabled: !canOperate },
          },
        ]}
        onPressAction={({ nativeEvent }) => {
          const action = nativeEvent.event;
          const opened = copyFor("open-run", action);
          const ran = copyFor("run", action);
          const placement = scheduledTaskPlacementOptions().find(
            (option) => `placement:${option.value}` === action,
          )?.value;
          if (action === "edit") {
            onEdit(environmentId, task);
          } else if (action === "duplicate") {
            onDuplicate(environmentId, task);
          } else if (opened) {
            const threadId = lastRunThreadId(opened.task);
            if (threadId !== null) openThread(opened.environmentId, threadId);
          } else if (ran) {
            if (!operate(ran.environmentId)) return;
            void runNow({ environmentId: ran.environmentId, input: { id: ran.task.id } }).then(
              (result) => failure(t("Could not run task"), result),
            );
          } else if (action === "toggle") {
            if (!operate(environmentId)) return;
            void setEnabled({
              environmentId,
              input: { id: task.id, enabled: !task.enabled },
            }).then((result) => failure(t("Could not update task"), result));
          } else if (placement !== undefined) {
            for (const copy of placeable) {
              if (!operate(copy.environmentId)) continue;
              void setPlacement({
                environmentId: copy.environmentId,
                input: { ids: [copy.task.id], placement },
              }).then((result) => failure(t("Could not move task"), result));
            }
          } else if (action === "delete") {
            confirmDelete();
          }
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Actions for {title}", { title: task.title })}
          className="h-11 w-11 items-center justify-center"
        >
          <SymbolView
            name="ellipsis"
            size={18}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
        </Pressable>
      </Menu>
    </View>
  );
}

/**
 * A machine a connected one links to, with the tasks it last reported. Read-only: this app has no
 * connection to it, and while it is offline nothing can reach it.
 */
function LinkedMachineTasks({
  machine,
  via,
  now,
}: {
  readonly machine: LinkedScheduledTaskMachine;
  readonly via: string;
  readonly now: number;
}) {
  const offline = machine.error !== null;
  return (
    <SettingsSection
      title={machine.label}
      titleIcon={
        <EnvironmentMachineSymbol
          kind={resolveEnvironmentMachineKind(null)}
          size={16}
          tintColorClassName={
            Platform.OS === "android" ? "accent-primary" : "accent-foreground-muted"
          }
        />
      }
    >
      <View className="gap-1 px-4 py-3">
        <Text className="text-sm text-foreground">
          {!offline
            ? t("Online · checked {when}", { when: formatTimeAgo(machine.checkedAt, now) })
            : machine.seenAt !== null
              ? t("Offline · last seen {when}", { when: formatTimeAgo(machine.seenAt, now) })
              : t("Offline · not reached yet")}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {t("Read-only: the tasks it last reported to {machine}.", { machine: via })}
        </Text>
      </View>
      {machine.tasks.length === 0 ? (
        <Text className="border-t border-border-subtle p-4 text-base text-foreground-muted">
          {t("No scheduled tasks yet.")}
        </Text>
      ) : (
        machine.tasks.map((task) => {
          const project = linkedProjectName(task.projectTitle);
          const lastRun = lastRunText(task, now);
          const noWorkSkip = formatNoWorkSkip(task, now);
          return (
            <View
              key={task.id}
              accessible
              className="gap-1 border-t border-border-subtle px-4 py-3"
            >
              <Text textRole="body" className="text-foreground" numberOfLines={1}>
                {task.title}
              </Text>
              <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                {[
                  project,
                  describeSchedule(task),
                  // An offline machine runs nothing, so its reported next run would mislead.
                  !task.enabled
                    ? t("Paused")
                    : !offline && task.nextRunAt !== null
                      ? formatNextScheduledTaskRun(task.nextRunAt, now)
                      : null,
                  lastRun,
                ]
                  .filter((part) => part !== null && part !== "")
                  .join(" · ")}
              </Text>
              {noWorkSkip === null ? null : (
                <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                  {noWorkSkip}
                </Text>
              )}
            </View>
          );
        })
      )}
    </SettingsSection>
  );
}

function EnvironmentTasks({
  environment,
  now,
  projectIds,
  projectNameOf,
  sharedCopies,
  grouping,
  onEdit,
  onOpenRuns,
  onDuplicate,
}: {
  readonly environment: SettingsTarget;
  readonly now: number;
  readonly projectIds: readonly ProjectId[] | null;
  readonly projectNameOf: (projectId: ProjectId) => string | null;
  /** Shared tasks this machine holds, listed once above every machine. */
  readonly sharedCopies: number;
  /**
   * Set while the screen lists tasks by group. "group" renders only this machine's tasks in that
   * group as bare rows that name the machine; "status" renders only the machine's loading or
   * error state.
   */
  readonly grouping?:
    | { readonly kind: "group"; readonly key: string | null }
    | { readonly kind: "status" };
  readonly onEdit: (task: ScheduledTask) => void;
  readonly onOpenRuns: (task: ScheduledTask) => void;
  readonly onDuplicate: (task: ScheduledTask) => void;
}) {
  const environmentId = environment.environmentId;
  const openThread = useOpenScheduledTaskThread();
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const visibleTasks = tasks.data?.tasks.filter(
    (task) =>
      !task.shared &&
      (projectIds === null || projectIds.includes(task.projectId)) &&
      (grouping?.kind !== "group" ||
        (task.group?.trim() ? scheduledTaskGroupKey(task.group) : null) === grouping.key),
  );
  const inGroup = grouping?.kind === "group";
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
    reportFailure: false,
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run",
    reportFailure: false,
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
    reportFailure: false,
  });
  const setPlacement = useAtomCommand(serverEnvironment.setScheduledTaskPlacement, {
    label: "scheduled task placement",
    reportFailure: false,
  });
  const failure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(title, String(squashAtomCommandFailure(result)));
    }
  };

  const movable = (placement: ScheduledTaskPlacement) =>
    (visibleTasks ?? []).filter(
      (task) => task.placement !== undefined && resolveScheduledTaskPlacement(task) !== placement,
    );
  const showAllIn = (placement: ScheduledTaskPlacement, label: string) => {
    const moving = movable(placement);
    Dialog.alert(
      t("Show {tasks} in {label}?", {
        tasks: tn(moving.length, "{count} task", "{count} tasks"),
        label,
      }),
      t("Each task you can see on this screen moves. You can change any task again from its menu."),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Move"),
          onPress: () =>
            void setPlacement({
              environmentId,
              input: { ids: moving.map((task) => task.id), placement },
            }).then((result) => failure(t("Could not move tasks"), result)),
        },
      ],
    );
  };
  const runTaskNow = async (task: ScheduledTask) => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const result = await runNow({ environmentId, input: { id: task.id } });
    if (result._tag === "Failure") {
      failure(t("Could not run task"), result);
      return;
    }
    const ran = result.value.task;
    if (ran.lastRunStatus === "failed") {
      Dialog.alert(t("Could not run task"), ran.lastRunError ?? task.title);
      return;
    }
    const runThreadId = ran.lastRunThreadId ?? null;
    Dialog.alert(
      t("Task started"),
      task.title,
      runThreadId === null
        ? undefined
        : [
            { text: t("OK"), style: "cancel" },
            { text: t("Open run"), onPress: () => openThread(environmentId, runThreadId) },
          ],
    );
  };
  const act = async (task: ScheduledTask, action: "toggle" | "delete" | ScheduledTaskPlacement) => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const result =
      action === "toggle"
        ? await setEnabled({ environmentId, input: { id: task.id, enabled: !task.enabled } })
        : action === "delete"
          ? await remove({ environmentId, input: { id: task.id } })
          : await setPlacement({ environmentId, input: { ids: [task.id], placement: action } });
    failure(
      action === "delete"
        ? t("Could not delete task")
        : action === "toggle"
          ? t("Could not update task")
          : t("Could not move task"),
      result,
    );
  };

  const renderTask = (task: ScheduledTask, index: number) => {
    const runThreadId = lastRunThreadId(task);
    const project = projectNameOf(task.projectId);
    const noWorkSkip = formatNoWorkSkip(task, now);
    return (
      <View
        key={task.id}
        className={
          index === 0 && !inGroup
            ? "flex-row items-start gap-1 px-4 py-3"
            : "flex-row items-start gap-1 border-t border-border-subtle px-4 py-3"
        }
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${task.title}${inGroup ? t(", on {machine}", { machine: environment.label }) : ""}${project === null ? "" : t(", in {project}", { project })}${task.shared ? (task.shared.runOn === "one" ? t(", runs on one machine") : t(", runs on every machine")) : ""}${task.modelUnavailableHere ? t(", runs the default model here") : ""}${noWorkSkip === null ? "" : `, ${noWorkSkip}`}`}
          accessibilityHint={
            runThreadId === null ? t("Opens the task editor.") : t("Opens the task's last run.")
          }
          onPress={() => {
            if (runThreadId === null) onEdit(task);
            else openThread(environmentId, runThreadId);
          }}
          className="min-w-0 flex-1 gap-1 active:opacity-70"
        >
          <Text textRole="body" className="text-foreground" numberOfLines={1}>
            {task.title}
          </Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={2}>
            {inGroup ? `${environment.label} · ` : ""}
            {project === null ? "" : `${project} · `}
            {describeSchedule(task)}
            {!task.enabled
              ? ` · ${t("Paused")}`
              : task.nextRunAt
                ? ` · ${formatNextScheduledTaskRun(task.nextRunAt, now)}`
                : ""}
            {task.modelUnavailableHere ? ` · ${t("Runs the default model here")}` : ""}
            {task.shared
              ? task.shared.runOn === "one"
                ? ` · ${t("One machine")}`
                : ` · ${t("Every machine")}`
              : ""}
            {lastRunText(task, now) ? ` · ${lastRunText(task, now)}` : ""}
          </Text>
          {noWorkSkip === null ? null : (
            <Text className="text-sm text-foreground-muted" numberOfLines={1}>
              {noWorkSkip}
            </Text>
          )}
          {task.blockedByPolicy ? (
            <Text className="text-sm text-foreground-muted" numberOfLines={2}>
              {task.blockedByPolicy}
            </Text>
          ) : null}
          {task.lastRunError ? (
            <Text className="text-sm text-danger-foreground" numberOfLines={2}>
              {t("Last run failed: {error}", { error: task.lastRunError })}
            </Text>
          ) : null}
        </Pressable>
        <Menu
          actions={[
            ...(runThreadId === null
              ? []
              : [{ id: "open-run", title: t("Open last run"), image: "text.bubble" }]),
            { id: "edit", title: t("Edit"), image: "square.and.pencil" },
            ...(canDuplicateOnMobile(task)
              ? [{ id: "duplicate", title: t("Duplicate"), image: "plus.square.on.square" }]
              : []),
            { id: "runs", title: t("Run history"), image: "list.number" },
            {
              id: "toggle",
              title: task.enabled ? t("Pause") : t("Resume"),
              attributes: { disabled: !canOperate },
            },
            ...(task.schedule.type === "webhook"
              ? []
              : [{ id: "run", title: t("Run now"), attributes: { disabled: !canOperate } }]),
            // Servers without placements leave placement out of the task.
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
            {
              id: "delete",
              title: t("Delete"),
              attributes: { destructive: true, disabled: !canOperate },
            },
          ]}
          onPressAction={({ nativeEvent }) => {
            const action = nativeEvent.event;
            if (action === "open-run") {
              if (runThreadId !== null) openThread(environmentId, runThreadId);
            } else if (action === "edit") {
              onEdit(task);
            } else if (action === "duplicate") {
              onDuplicate(task);
            } else if (action === "runs") {
              onOpenRuns(task);
            } else if (action === "delete") {
              Dialog.alert(t("Delete task?"), task.title, [
                { text: t("Cancel"), style: "cancel" },
                {
                  text: t("Delete"),
                  style: "destructive",
                  onPress: () => void act(task, "delete"),
                },
              ]);
            } else if (action === "run") {
              void runTaskNow(task);
            } else if (action === "toggle") {
              void act(task, action);
            } else if (action.startsWith("placement:")) {
              const placement = scheduledTaskPlacementOptions().find(
                (option) => `placement:${option.value}` === action,
              )?.value;
              if (placement !== undefined) void act(task, placement);
            }
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Actions for {title}", { title: task.title })}
            className="h-11 w-11 items-center justify-center"
          >
            <SymbolView
              name="ellipsis"
              size={18}
              tintColorClassName="accent-icon"
              type="monochrome"
            />
          </Pressable>
        </Menu>
      </View>
    );
  };

  if (grouping?.kind === "group") {
    return visibleTasks === undefined || visibleTasks.length === 0 ? null : (
      <>{visibleTasks.map(renderTask)}</>
    );
  }
  if (grouping?.kind === "status" && !tasks.error && tasks.data) return null;

  return (
    <SettingsSection
      title={environment.label}
      titleIcon={
        <EnvironmentMachineSymbol
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          size={16}
          tintColorClassName={
            Platform.OS === "android" ? "accent-primary" : "accent-foreground-muted"
          }
        />
      }
    >
      {tasks.error ? (
        <Text className="p-4 text-base text-danger-foreground">{tasks.error}</Text>
      ) : !tasks.data ? (
        <Text className="p-4 text-base text-foreground-muted">{t("Loading tasks…")}</Text>
      ) : visibleTasks?.length === 0 ? (
        <Text className="p-4 text-base text-foreground-muted">
          {sharedCopies > 0
            ? t("No other tasks on this machine.")
            : projectIds === null
              ? t("No scheduled tasks yet.")
              : t("No tasks in this project.")}
        </Text>
      ) : (
        <>
          {visibleTasks?.map(renderTask)}
          <Menu
            actions={scheduledTaskPlacementOptions().map((option) => ({
              id: option.value,
              title: option.label,
              attributes: { disabled: !canOperate || movable(option.value).length === 0 },
            }))}
            onPressAction={({ nativeEvent }) => {
              const option = scheduledTaskPlacementOptions().find(
                (candidate) => candidate.value === nativeEvent.event,
              );
              if (option !== undefined) showAllIn(option.value, option.label);
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Show all in")}
              className="min-h-11 justify-center border-t border-border-subtle px-4 active:opacity-70"
            >
              <Text className="text-sm text-foreground-muted">{t("Show all in…")}</Text>
            </Pressable>
          </Menu>
        </>
      )}
    </SettingsSection>
  );
}
