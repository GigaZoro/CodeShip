import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  connectionMayStillAnswer,
  connectionStatusTitle,
} from "@t3tools/client-runtime/connection";
import { AsyncResult } from "effect/reactivity";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  Clock3Icon,
  CopyIcon,
  HistoryIcon,
  InboxIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useContext, useRef, useState } from "react";
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskPlacement,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertInput,
  ScheduledTaskWebhookDeliverySummary,
  ThreadId,
} from "@t3tools/contracts";
import {
  DEFAULT_WEBHOOK_PROMPT,
  emptyWebhookFilterDraft,
  parseWebhookFilterDrafts,
  removeWebhookFilterDraft,
  WEBHOOK_FILTER_OPS,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import {
  defaultCatchUpMissedRun,
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  MAX_WEBHOOK_FILTERS,
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ProviderInstanceId,
  resolveEnvironmentMachineKind,
  scheduledTaskSharedProjectKey,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { getFormattingLocale, msg, t, tn, tx, type Message } from "~/i18n";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../../timestampFormat";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { requestConfirmDialog } from "../../confirmDialog";
import { webhookAddress } from "@t3tools/client-runtime/webhook-address";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowMinute } from "../../hooks/useNowMinute";
import {
  supportsScheduledTaskPlacement,
  useSetScheduledTaskPlacement,
} from "../../hooks/useSetScheduledTaskPlacement";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  useEnvironments,
  type EnvironmentPresentation,
} from "../../state/environments";
import { useProjects, useThreadShell } from "../../state/entities";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  pinnedTaskRunThreadId,
  resolveScheduledTaskPlacement,
  scheduledTaskPlacementOptions,
} from "@t3tools/client-runtime/scheduled-task-pins";
import {
  describeOneMachineLinkWarning,
  effectiveOneMachineOrder,
  mergeMachineOrder,
  moveMachine,
  newestProjectMachineOrder,
  oneMachineLinkWarnings,
  projectMachineOrderSubject,
  seedMachineOrder,
  sharedProjectReference,
  sharedSyncFailureKey,
  sharedUpsertField,
  toggleSharedExclusion,
  visibleMachineOrder,
} from "@t3tools/client-runtime/scheduled-task-sharing";
import {
  sharedScheduledTaskSnapshotsAtom,
  supportsSharedScheduledTasks,
  useSharedScheduledTaskFailures,
} from "../../state/sharedScheduledTasks";
import { buildThreadRouteParams } from "../../threadRoutes";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useInheritedDefaultModelSelection } from "../../state/inheritedDefaultModel";
import { threadFamilies } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ConnectionStatusDot, connectionPhaseDotClassName } from "../ConnectionStatusDot";
import {
  AuthOrchestrationOperateScope,
  clampManagedRuntimeMode,
  managedCapabilityDenial,
} from "@t3tools/contracts";
import { withAutoAccount } from "@t3tools/shared/model";
import { resolvePastedPath } from "@t3tools/shared/path";
import { autoModePick } from "@t3tools/shared/serverSettings";
import { useManagedPolicy } from "~/state/managedPolicy";
import { ManagedNotice } from "../ManagedPolicy";
import { readEnvironmentScope } from "~/state/session";
import { useSettingsScope } from "./SettingsScopeContext";
import { EnvironmentRow, useEnvironmentTransportLabel } from "./EnvironmentRow";
import { SettingsGroup } from "./SettingsGroup";
import { settingsScopeEnvironmentLabel, settingsScopeEnvironmentLabels } from "./settingsScopeAxis";
import {
  WEBHOOK_SIGNATURE_DEFAULTS,
  scheduleDraftErrors,
  toDateTimeLocalValue,
  webhookDeliveryLabel,
  defaultScheduledTaskProjectId,
  matchesScheduledTaskScope,
  scheduleFromDraft,
  scheduledTaskDefaultModel,
  taskToDraft,
  type DraftState,
  type ScheduleMode,
  type WorkspaceMode,
} from "./scheduledTasksSettings.logic";
import { Label } from "../ui/label";
import { ScheduledTaskPlacementRadioGroup } from "./ScheduledTaskPlacementRadioGroup";
import { ScheduledTaskRunsDialog } from "./ScheduledTaskRunsDialog";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../ui/menu";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from "../ui/empty";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
} from "./settingsLayout";

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_LABELS = [
  msg("Sun"),
  msg("Mon"),
  msg("Tue"),
  msg("Wed"),
  msg("Thu"),
  msg("Fri"),
  msg("Sat"),
] as const;
const WEEKDAY_SHORT = [
  msg("Su"),
  msg("Mo"),
  msg("Tu"),
  msg("We"),
  msg("Th"),
  msg("Fr"),
  msg("Sa"),
] as const;

const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, Message> = {
  worktree: msg("Create a new worktree"),
  root: msg("Use the project checkout"),
  existing_worktree: msg("Use a specific checkout"),
};

const IN_FILTER_EXAMPLE = "opened, reopened";
const EQUALS_FILTER_EXAMPLE = "opened";

const EMPTY_DRAFT: DraftState = {
  editingId: null,
  title: "",
  prompt: "",
  enabled: true,
  scheduleMode: "fixed",
  intervalMinutes: "15",
  timeOfDay: "09:00",
  runAt: "",
  savedRunAt: "",
  weekdays: new Set([1, 2, 3, 4, 5]),
  projectId: "",
  threadId: "",
  workspaceMode: "worktree",
  baseRef: "main",
  startFromOrigin: true,
  existingWorktreePath: "",
  modelKey: "",
  runtimeMode: "full-access",
  interactionMode: "default",
  baseModelSelection: null,
  followsDefaultModel: true,
  catchUpMissedRun: null,
  shared: false,
  sharedExcludedEnvironmentIds: [],
  sharedRunOn: "every",
  sharedMachineOrder: null,
  signatureEnabled: false,
  ...WEBHOOK_SIGNATURE_DEFAULTS,
  signatureSecret: "",
  maxDeliveryAgeMinutes: "",
  replayKey: "",
  coalesceKey: "",
  coalesceWindowSeconds: "",
  filters: [],
  savedFilters: [],
};

function WebhookFiltersField({
  filters,
  onChange,
}: {
  filters: ReadonlyArray<WebhookFilterDraft>;
  onChange: (filters: ReadonlyArray<WebhookFilterDraft>) => void;
}) {
  const update = (index: number, patch: Partial<WebhookFilterDraft>) =>
    onChange(filters.map((filter, at) => (at === index ? { ...filter, ...patch } : filter)));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <Label>{t("Filters")}</Label>
          <p className="text-sm text-muted-foreground">
            {t(
              "Run only when every filter matches. Other requests are logged as filtered. Separate “is one of” values with commas; a value can't contain a comma.",
            )}
          </p>
        </div>
        <Button
          className="shrink-0"
          variant="outline"
          size="sm"
          disabled={filters.length >= MAX_WEBHOOK_FILTERS}
          onClick={() => onChange([...filters, emptyWebhookFilterDraft()])}
        >
          <PlusIcon />
          {t("Add filter")}
        </Button>
      </div>
      {filters.map((filter, index) => (
        // Always stacked: the dialog stays narrow on wide windows, so a single line
        // would cut off typical paths and values. The grid wrappers size each control
        // without restyling it; a grid item stretches to its minmax(0, 1fr) track.
        <div key={filter.id} className="space-y-2 pt-1">
          <div className="flex items-center gap-2">
            <div className="grid min-w-0 flex-1 grid-cols-1">
              <Input
                aria-label={t("Filter {number} path", { number: index + 1 })}
                placeholder={"body.action"}
                value={filter.path}
                onChange={(event) => update(index, { path: event.target.value })}
              />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Remove filter {number}", { number: index + 1 })}
              onClick={() => onChange(removeWebhookFilterDraft(filters, filter.id))}
            >
              <Trash2Icon />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={filter.op}
              onValueChange={(op) => {
                const known = WEBHOOK_FILTER_OPS.find((option) => option.op === op);
                if (known) update(index, { op: known.op });
              }}
            >
              <div className="grid w-44 shrink-0 grid-cols-1">
                <SelectTrigger
                  size="sm"
                  aria-label={t("Filter {number} test", { number: index + 1 })}
                >
                  <SelectValue>
                    {WEBHOOK_FILTER_OPS.find((option) => option.op === filter.op)?.label}
                  </SelectValue>
                </SelectTrigger>
              </div>
              <SelectPopup>
                {WEBHOOK_FILTER_OPS.map((option) => (
                  <SelectItem key={option.op} value={option.op}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {filter.op === "exists" ? null : (
              <div className="grid min-w-0 flex-1 grid-cols-1">
                <Input
                  aria-label={t("Filter {number} value", { number: index + 1 })}
                  placeholder={filter.op === "in" ? IN_FILTER_EXAMPLE : EQUALS_FILTER_EXAMPLE}
                  value={filter.value}
                  onChange={(event) => update(index, { value: event.target.value })}
                />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? <span className="font-normal text-2xs text-muted-foreground">{hint}</span> : null}
      </Label>
      {children}
    </div>
  );
}

function splitModelKey(value: string): ModelSelection | null {
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) return null;
  return {
    instanceId: ProviderInstanceId.make(value.slice(0, index)),
    model: value.slice(index + 1),
  };
}

const formatOnce = (runAt: string) =>
  new Intl.DateTimeFormat(getFormattingLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(runAt));

export function scheduleLabel(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "webhook") return t("On webhook");
  if (schedule.type === "once") return t("Once, {when}", { when: formatOnce(schedule.runAt) });
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? t("Every {minutes} min", { minutes })
      : t("Every {seconds} sec", { seconds: Math.round(schedule.everyMs / 1000) });
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? t("Daily")
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? t("Weekdays")
        : weekdays.map((day) => t(WEEKDAY_LABELS[day]!)).join(", ");
  return t("{days} at {time}", { days, time: schedule.timeOfDay });
}

/** formatRelativeTime handles only the past; upcoming runs need future labels. */
function relativeLabel(value: string | null, nowMs: number): string {
  if (!value) return t("Not scheduled");
  const diffMs = new Date(value).getTime() - nowMs;
  if (diffMs <= 0) {
    const relative = formatRelativeTime(value, nowMs);
    if (!relative) return t("Not scheduled");
    return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
  }
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 2) return t("in under a minute");
  if (minutes < 60) return t("in {minutes}m", { minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("in {hours}h", { hours });
  return t("in {days}d", { days: Math.round(hours / 24) });
}

// Use the label's minute tick because the compiler caches render-time Date.now() on the timestamp.
export function ScheduledRelativeLabel(props: { value: string | null }) {
  const nowMinute = useNowMinute();
  return relativeLabel(props.value, Date.parse(`${nowMinute}:00.000Z`));
}

/** The schedule and what holds or comes next: the policy blocking it, the next run, or paused. */
export function ScheduledTaskScheduleLine(props: { task: ScheduledTask }) {
  const { task } = props;
  const schedule = scheduleLabel(task.schedule);
  if (task.blockedByPolicy !== undefined) {
    return t("{schedule} · {policy}", { schedule, policy: task.blockedByPolicy });
  }
  if (task.enabled && task.nextRunAt !== null) {
    return tx("{schedule} · next {when}", {
      schedule,
      when: <ScheduledRelativeLabel value={task.nextRunAt} />,
    });
  }
  return task.enabled ? schedule : t("{schedule} · paused", { schedule });
}

function deliveryOutcomeVariant(outcome: string) {
  if (outcome === "accepted") return "success";
  if (
    outcome === "duplicate" ||
    outcome === "coalesced" ||
    outcome === "disabled" ||
    outcome === "rate_limited" ||
    outcome === "expired"
  ) {
    return "warning";
  }
  if (outcome === "dispatch_failed" || outcome === "rejected_signature") return "error";
  return "outline";
}

function runStatusLabel(status: ScheduledTask["lastRunStatus"]) {
  switch (status) {
    case "failed":
      return t("failed");
    case "succeeded":
      return t("succeeded");
    case "running":
      return t("running");
    default:
      return status;
  }
}

function statusVariant(status: ScheduledTask["lastRunStatus"]) {
  if (status === "failed") return "error";
  if (status === "succeeded") return "success";
  if (status === "running") return "info";
  return "outline";
}

export function ScheduledTasksSettings(target: {
  readonly environmentId?: EnvironmentId | undefined;
  readonly taskId?: ScheduledTaskId | undefined;
}) {
  const { scope, environments, connectedEnvironments, environment } = useSettingsScope();
  const [editor, setEditor] = useState<{
    environmentId: EnvironmentId;
    task: ScheduledTask | null;
  } | null>(null);
  const openForEdit = (environmentId: EnvironmentId, task: ScheduledTask) => {
    setEditor({ environmentId, task });
  };
  const defaultEnvironment = environment ?? connectedEnvironments[0];
  const linkedEnvironmentId = target.environmentId ?? defaultEnvironment?.environmentId;
  const linkedEnvironmentConnected = environments.some(
    (entry) =>
      entry.environmentId === linkedEnvironmentId &&
      entry.connection.phase === "connected" &&
      entry.serverConfig !== null,
  );
  const linkedTasksQuery = useEnvironmentQuery(
    target.taskId !== undefined && linkedEnvironmentId !== undefined && linkedEnvironmentConnected
      ? serverEnvironment.scheduledTasksLive({ environmentId: linkedEnvironmentId, input: {} })
      : null,
  );
  const linkedTask = linkedTasksQuery.data?.tasks.find(
    (task) =>
      task.id === target.taskId &&
      linkedEnvironmentId !== undefined &&
      matchesScheduledTaskScope(scope, linkedEnvironmentId, task.projectId),
  );
  // A `taskId` link opens its editor once, the first time the task loads. The editor then owns
  // the session until close, so a disconnect that disables the query cannot drop unsaved edits.
  // An editor the user already opened wins: a late-loading link must not replace its draft.
  const [openedLinkTaskId, setOpenedLinkTaskId] = useState<ScheduledTaskId | undefined>();
  if (target.taskId === undefined && openedLinkTaskId !== undefined) {
    setOpenedLinkTaskId(undefined);
  }
  if (linkedTask && linkedEnvironmentId !== undefined && openedLinkTaskId !== target.taskId) {
    setOpenedLinkTaskId(target.taskId);
    if (editor === null) setEditor({ environmentId: linkedEnvironmentId, task: linkedTask });
  }
  const navigate = useNavigate({ from: "/scheduled-tasks" });
  const closeEditor = () => {
    setEditor(null);
    if (target.taskId === undefined) return;
    void navigate({
      to: "/scheduled-tasks",
      search: ({ taskId: _closed, ...rest }) => rest,
      replace: true,
    });
  };
  const createPermissions = useAtomValue(
    scheduledTaskCreatePermissionsAtom(
      environmentIdsKey(connectedEnvironments.map((entry) => entry.environmentId)),
    ),
  );
  const permittedEnvironments = connectedEnvironments.filter(
    (_entry, index) => createPermissions[index],
  );
  const creationEnvironment =
    permittedEnvironments.find(
      (entry) => entry.environmentId === defaultEnvironment?.environmentId,
    ) ?? permittedEnvironments[0];
  const startTask = creationEnvironment
    ? () => setEditor({ environmentId: creationEnvironment.environmentId, task: null })
    : undefined;
  return (
    <>
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <WorkspaceBreadcrumb ariaLabel={t("Scheduled tasks breadcrumb")}>
          <WorkspaceBreadcrumbItem current>
            <h1>{t("Scheduled tasks")}</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <div className="ms-auto flex shrink-0 items-center">
          <ShowAllTasksIn />
          <Button size="xs" variant="ghost" disabled={!startTask} onClick={startTask}>
            <PlusIcon className="size-3" />
            {t("New task")}
          </Button>
        </div>
      </WorkspacePageHeader>
      <SettingsPageContainer scopeLead={t("Showing tasks for")}>
        {scope.kind === "unavailable" ? (
          <SettingsSection title={t("Unavailable selection")}>
            <SettingsRow title={scope.message} />
          </SettingsSection>
        ) : environments.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Clock3Icon />
              </EmptyMedia>
              <EmptyTitle>{t("No environments available")}</EmptyTitle>
              <EmptyDescription>
                {t("Connect an environment to manage scheduled tasks.")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : environments.length > 1 ? (
          <ScheduledTaskEnvironmentList
            environmentId={linkedEnvironmentId}
            taskId={target.taskId}
            onEdit={openForEdit}
            onCreate={startTask}
          />
        ) : (
          <div className="space-y-8">
            {environments.map((entry) => (
              <ScheduledTaskEnvironmentSection
                key={entry.environmentId}
                environment={entry}
                taskId={linkedEnvironmentId === entry.environmentId ? target.taskId : undefined}
                onEdit={openForEdit}
                onCreate={startTask}
              />
            ))}
          </div>
        )}
      </SettingsPageContainer>
      {editor ? (
        <ScheduledTaskEditorDialog
          key={`${editor.environmentId}:${editor.task?.id ?? "new"}`}
          initialEnvironmentId={editor.environmentId}
          task={editor.task}
          onClose={closeEditor}
        />
      ) : null}
    </>
  );
}

const scheduledTaskCreatePermissionsAtom = environmentAtomList(
  "web-scheduled-task-create-permissions",
  serverEnvironment.upsertScheduledTask.permissionAtom,
);

export const scheduledTasksListAtom = environmentAtomList(
  "web-scheduled-tasks-list",
  (environmentId) => serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
);

const scheduledTaskPlacementPermissionsAtom = environmentAtomList(
  "web-scheduled-task-placement-permissions",
  serverEnvironment.setScheduledTaskPlacement.permissionAtom,
);

/** Moves every task listed on this page, so the choice reaches exactly what the user sees. */
function ShowAllTasksIn() {
  const { scope, environments } = useSettingsScope();
  const setPlacement = useSetScheduledTaskPlacement();
  const connectedIds = environments.flatMap((environment) =>
    environment.connection.phase === "connected" && environment.serverConfig !== null
      ? [environment.environmentId]
      : [],
  );
  const key = environmentIdsKey(connectedIds);
  const queries = useAtomValue(scheduledTasksListAtom(key));
  const permissions = useAtomValue(scheduledTaskPlacementPermissionsAtom(key));
  const movable = (placement: ScheduledTaskPlacement | null) =>
    connectedIds.flatMap((environmentId, index) => {
      if (!permissions[index]) return [];
      const tasks = (AsyncResult.getOrElse(queries[index]!, () => null)?.tasks ?? []).filter(
        (task) =>
          supportsScheduledTaskPlacement(task) &&
          matchesScheduledTaskScope(scope, environmentId, task.projectId) &&
          resolveScheduledTaskPlacement(task) !== placement,
      );
      return tasks.length > 0 ? [{ environmentId, tasks }] : [];
    });
  const choose = async (placement: ScheduledTaskPlacement, label: string) => {
    const groups = movable(placement);
    const count = groups.reduce((total, group) => total + group.tasks.length, 0);
    const message = tn(
      count,
      "Show {count} task in {label}?\nEach task you can see on this page moves. You can change any task again from its menu.",
      "Show {count} tasks in {label}?\nEach task you can see on this page moves. You can change any task again from its menu.",
      { label },
    );
    if (!((await requestConfirmDialog(message)) ?? window.confirm(message))) return;
    await Promise.all(
      groups.map((group) => setPlacement(group.environmentId, group.tasks, placement)),
    );
  };
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="xs" variant="ghost" disabled={movable(null).length === 0} />}
      >
        {t("Show all in")}
        <ChevronDownIcon className="size-3" />
      </MenuTrigger>
      <MenuPopup align="end">
        {scheduledTaskPlacementOptions().map((option) => (
          <MenuItem
            key={option.value}
            disabled={movable(option.value).length === 0}
            onClick={() => void choose(option.value, option.label)}
          >
            {option.label}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function ScheduledTaskEnvironmentList({
  environmentId,
  taskId,
  onEdit,
  onCreate,
}: {
  readonly environmentId: EnvironmentId | undefined;
  readonly taskId: ScheduledTaskId | undefined;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
  readonly onCreate: (() => void) | undefined;
}) {
  const { scope, environments } = useSettingsScope();
  const connectedIds = environments.flatMap((environment) =>
    environment.connection.phase === "connected" && environment.serverConfig !== null
      ? [environment.environmentId]
      : [],
  );
  const queries = useAtomValue(scheduledTasksListAtom(environmentIdsKey(connectedIds)));
  const registry = useContext(RegistryContext);
  const states = environments.map((environment) => {
    const index = connectedIds.indexOf(environment.environmentId);
    const query = index < 0 ? null : queries[index]!;
    const data = query === null ? null : AsyncResult.getOrElse(query, () => null);
    return {
      environment,
      connected: index >= 0,
      tasks: data?.tasks.filter((task) =>
        matchesScheduledTaskScope(scope, environment.environmentId, task.projectId),
      ),
      error: query?._tag === "Failure" ? formatEnvironmentQueryError(query.cause) : null,
    };
  });
  const linkedState = states.find((state) => state.environment.environmentId === environmentId);
  const linkedTask = linkedState?.tasks?.find((task) => task.id === taskId);

  const loaded = states.filter((state) => state.connected && state.error === null && state.tasks);
  const populated = loaded.filter((state) => state.tasks && state.tasks.length > 0);
  const notConnectedLabel = t("Not connected:");
  const loadingLabel = t("Loading scheduled tasks on");
  const noTasksLabel = t("No tasks on");
  const summaries: Record<string, string[]> = {
    [notConnectedLabel]: [],
    [loadingLabel]: [],
    [noTasksLabel]: [],
  };
  const failures: { environmentId: EnvironmentId; label: string; error: string }[] = [];
  for (const { environment, connected, tasks, error } of states) {
    const label = settingsScopeEnvironmentLabel(environment, environments);
    if (!connected) {
      summaries[notConnectedLabel]!.push(
        `${label} (${connectionStatusTitle(environment.connection)})`,
      );
    } else if (error !== null) {
      failures.push({ environmentId: environment.environmentId, label, error });
    } else if (!tasks) {
      summaries[loadingLabel]!.push(label);
    } else if (tasks.length === 0 && populated.length > 0) {
      summaries[noTasksLabel]!.push(label);
    }
  }

  return (
    <SettingsGroup>
      {populated.map(({ environment, tasks }) => {
        const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
        return (
          <div key={environment.environmentId} className="divide-y divide-border/50">
            <EnvironmentRow
              kind={resolveEnvironmentMachineKind(environment.serverConfig)}
              label={primary}
              subtitle={
                <ScheduledTaskEnvironmentSubtitle environment={environment} secondary={secondary} />
              }
            >
              <ConnectionStatusDot
                dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                tooltipText={connectionStatusTitle(environment.connection)}
              />
              <span className="text-xs text-muted-foreground">
                {connectionStatusTitle(environment.connection)}
              </span>
            </EnvironmentRow>
            {tasks?.map((task) => (
              <ScheduledTaskRow
                key={task.id}
                environmentId={environment.environmentId}
                task={task}
                onEdit={() => onEdit(environment.environmentId, task)}
              />
            ))}
          </div>
        );
      })}
      {taskId && linkedState?.tasks && linkedState.error === null && !linkedTask ? (
        <SettingsRow
          title={t("Task unavailable")}
          description={t(
            "This task was deleted or belongs to a different project. Check your project filter.",
          )}
          role="status"
        />
      ) : null}
      {/* Only once every machine answered: one still loading or failing may hold tasks. */}
      {populated.length === 0 && loaded.length > 0 && loaded.length === connectedIds.length ? (
        <ScheduledTasksEmptyRow
          onCreate={onCreate}
          everyMachineAnswered={loaded.length === environments.length}
        />
      ) : null}
      {failures.map(({ environmentId: failedId, label, error }) => (
        <div
          key={failedId}
          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 sm:px-4"
          role="status"
        >
          <p className="min-w-0 break-words text-xs text-muted-foreground">
            {t("Could not load scheduled tasks: {label}: {error}", { label, error })}
          </p>
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              registry.refresh(
                serverEnvironment.scheduledTasksLive({ environmentId: failedId, input: {} }),
              )
            }
          >
            {t("Retry")}
          </Button>
        </div>
      ))}
      {Object.entries(summaries).map(([label, entries]) => {
        if (entries.length === 0) return null;
        // Wraps instead of truncating: errors name the cause, and touch has no hover.
        return (
          <p
            key={label}
            className="break-words px-3 py-2.5 text-xs text-muted-foreground sm:px-4"
            role="status"
          >
            {label} {entries.join(", ")}
          </p>
        );
      })}
    </SettingsGroup>
  );
}

/**
 * No tasks to list. Names a project filter, which hides tasks; on a machine filter or with a
 * machine yet to answer, tasks may still exist elsewhere, so it never claims there are none.
 */
function ScheduledTasksEmptyRow({
  onCreate,
  everyMachineAnswered,
}: {
  readonly onCreate: (() => void) | undefined;
  readonly everyMachineAnswered: boolean;
}) {
  const { scope } = useSettingsScope();
  if (scope.kind === "project" || scope.kind === "checkout") {
    return (
      <SettingsRow
        title={t("No scheduled tasks")}
        description={t("No tasks in {name}.", { name: scope.label })}
      />
    );
  }
  return (
    <SettingsRow
      title={
        scope.kind === "environment"
          ? t("No scheduled tasks on {name}", { name: scope.label })
          : everyMachineAnswered
            ? t("No scheduled tasks yet")
            : t("No scheduled tasks found")
      }
      description={t(
        "A task starts a thread on a schedule, or when its webhook URL receives a request.",
      )}
      control={
        onCreate ? (
          <Button size="sm" variant="outline" onClick={onCreate}>
            <PlusIcon />
            {t("Create a task")}
          </Button>
        ) : undefined
      }
    />
  );
}

function ScheduledTaskEnvironmentSubtitle({
  environment,
  secondary,
}: {
  readonly environment: EnvironmentPresentation;
  readonly secondary: string;
}) {
  const transport = useEnvironmentTransportLabel(environment);
  return (
    <>
      {secondary && secondary !== transport ? (
        <span className="block truncate">{secondary}</span>
      ) : null}
      <span className="block truncate">{transport}</span>
    </>
  );
}

function ScheduledTaskEnvironmentSection({
  environment,
  taskId,
  onEdit,
  onCreate,
}: {
  readonly environment: EnvironmentPresentation;
  readonly taskId?: ScheduledTaskId | undefined;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
  readonly onCreate: (() => void) | undefined;
}) {
  const { scope } = useSettingsScope();
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const tasksQuery = useEnvironmentQuery(
    connected
      ? serverEnvironment.scheduledTasksLive({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  const tasks = tasksQuery.data?.tasks.filter((task) =>
    matchesScheduledTaskScope(scope, environment.environmentId, task.projectId),
  );
  const linkedTask = tasks?.find((task) => task.id === taskId);
  return (
    <SettingsSection
      title={environment.label}
      hideTitle
      icon={
        <EnvironmentMachineIcon
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          className="size-3.5"
        />
      }
    >
      {!connected ? (
        connectionMayStillAnswer(environment.connection.phase) ? (
          <SettingsRow
            title={t("Connecting to {name}…", { name: environment.label })}
            role="status"
          />
        ) : (
          <SettingsRow
            title={t("Environment disconnected")}
            description={t("Reconnect {name} to view its scheduled tasks.", {
              name: environment.label,
            })}
          />
        )
      ) : tasksQuery.error ? (
        <SettingsRow
          title={t("Could not load scheduled tasks")}
          description={tasksQuery.error}
          role="alert"
          control={
            <Button size="sm" variant="outline" onClick={tasksQuery.refresh}>
              {t("Retry")}
            </Button>
          }
        />
      ) : !tasks ? (
        <SettingsRow title={t("Loading scheduled tasks…")} role="status" />
      ) : (
        <>
          {taskId && !linkedTask ? (
            <SettingsRow
              title={t("Task unavailable")}
              description={t(
                "This task was deleted or belongs to a different project. Check your project filter.",
              )}
              role="status"
            />
          ) : null}
          {tasks.length === 0 ? (
            <ScheduledTasksEmptyRow onCreate={onCreate} everyMachineAnswered />
          ) : (
            tasks.map((task) => (
              <ScheduledTaskRow
                key={task.id}
                environmentId={environment.environmentId}
                task={task}
                onEdit={() => onEdit(environment.environmentId, task)}
              />
            ))
          )}
        </>
      )}
    </SettingsSection>
  );
}

function SharedTaskBadge({
  task,
  environmentId,
}: {
  readonly task: ScheduledTask;
  readonly environmentId: EnvironmentId;
}) {
  const nowMinute = useNowMinute();
  const { environments } = useEnvironments();
  const failures = useSharedScheduledTaskFailures();
  const sharingIds = environments
    .filter(
      (entry) => entry.connection.phase === "connected" && supportsSharedScheduledTasks(entry),
    )
    .map((entry) => entry.environmentId);
  const snapshots = useAtomValue(sharedScheduledTaskSnapshotsAtom(environmentIdsKey(sharingIds)));
  const labelOf = (environmentId: EnvironmentId) => {
    const entry = environments.find((candidate) => candidate.environmentId === environmentId);
    return entry ? settingsScopeEnvironmentLabel(entry, environments) : environmentId;
  };
  const shared = task.shared;
  const oneMachine = shared?.runOn === "one";
  const orderSubject = shared
    ? projectMachineOrderSubject(scheduledTaskSharedProjectKey(shared.project))
    : null;
  const notSynced = [...failures.values()].filter(
    (failure) => failure.subject === task.id || failure.subject === orderSubject,
  );
  const leftOut = (shared?.excludedEnvironmentIds ?? []).map(labelOf);
  const order =
    oneMachine && shared
      ? effectiveOneMachineOrder(
          newestProjectMachineOrder(snapshots, shared.project)?.order ?? [],
          shared.excludedEnvironmentIds,
          sharingIds,
        )
      : [];
  const linkWarnings = oneMachineLinkWarnings(
    snapshots,
    order,
    Date.parse(`${nowMinute}:00.000Z`),
  ).map((warning) => describeOneMachineLinkWarning(warning, labelOf));
  const decision = oneMachine ? task.lastOneMachineDecision : null;
  const unchecked = decision?.unchecked ?? [];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant={
              notSynced.length > 0 || unchecked.length > 0 || linkWarnings.length > 0
                ? "warning"
                : "info"
            }
            tabIndex={0}
          />
        }
      >
        {oneMachine ? t("One machine") : t("Every machine")}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="space-y-1">
          <p>
            {oneMachine
              ? t(
                  "Each run happens on one machine: the first in the order that is online and finishes it.",
                )
              : t("Runs on every machine, each on its own schedule.")}
          </p>
          {order.length > 0 ? (
            <p>{t("Order: {machines}", { machines: order.map(labelOf).join(" → ") })}</p>
          ) : null}
          {leftOut.length > 0 ? (
            <p>{t("Not on: {machines}", { machines: leftOut.join(", ") })}</p>
          ) : null}
          {decision ? (
            <p>
              {decision.ranOn === null
                ? t("Last run here at {time}", {
                    time: new Date(decision.at).toLocaleString(getFormattingLocale()),
                  })
                : t("Skipped {time}: {machine} ran it", {
                    time: new Date(decision.at).toLocaleString(getFormattingLocale()),
                    machine: labelOf(decision.ranOn),
                  })}
            </p>
          ) : null}
          {unchecked.map((entry) => (
            <p key={entry.environmentId}>
              {t("Couldn't check {machine}: {reason}", {
                machine: labelOf(entry.environmentId),
                reason: entry.reason,
              })}
            </p>
          ))}
          {linkWarnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          {task.modelUnavailableHere ? (
            <p>
              {t("Runs the default model on {machine}: its own model isn't set up here.", {
                machine: labelOf(environmentId),
              })}
            </p>
          ) : null}
          {notSynced.map((failure) => (
            <p key={sharedSyncFailureKey(failure.environmentId, failure.subject)}>
              {t("Not synced to {machine}: {error}", {
                machine: labelOf(failure.environmentId),
                error: failure.error,
              })}
            </p>
          ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function ScheduledTaskRow({
  environmentId,
  task,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly onEdit: () => void;
}) {
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [deliveriesOpen, setDeliveriesOpen] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  const [errorExpanded, setErrorExpanded] = useState(false);
  const isWebhook = task.schedule.type === "webhook";
  const offersRunHistory =
    useEnvironment(environmentId)?.serverConfig?.environment.capabilities
      .scheduledTaskRunHistory === true;
  const toggle = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
  });
  const run = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run now",
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
  });
  const setPlacement = useSetScheduledTaskPlacement();
  const navigate = useNavigate();
  const failToast = (title: string, description: string) =>
    toastManager.add(stackedThreadToast({ type: "error", title, description }));
  /** Runs one task command while the row is busy; a failure toasts under the action's own title. */
  const perform = async <A, E>(
    failureTitle: string,
    command: () => Promise<AtomCommandResult<A, E>>,
  ): Promise<A | null> => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return null;
    setBusy(true);
    const result = await command();
    setBusy(false);
    if (result._tag === "Success") return result.value;
    if (!isAtomCommandInterrupted(result)) {
      failToast(failureTitle, String(squashAtomCommandFailure(result)));
    }
    return null;
  };
  const toggleEnabled = () =>
    perform(task.enabled ? t("Could not pause task") : t("Could not resume task"), () =>
      toggle({ environmentId, input: { id: task.id, enabled: !task.enabled } }),
    );
  const runNow = async () => {
    const ran = (
      await perform(t("Could not run task"), () => run({ environmentId, input: { id: task.id } }))
    )?.task;
    if (!ran) return;
    // A run whose thread could not start still succeeds as a call and records why.
    if (ran.lastRunStatus === "failed") {
      failToast(t("Could not run task"), ran.lastRunError ?? t("The run did not start."));
      return;
    }
    const threadId = pinnedTaskRunThreadId(ran);
    const id = toastManager.add(
      stackedThreadToast({
        type: "success",
        title: t("Started {name}", { name: task.title }),
        ...(threadId
          ? {
              actionProps: {
                children: t("Open thread"),
                onClick: () => {
                  toastManager.close(id);
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
                  });
                },
              },
            }
          : {}),
      }),
    );
  };
  const deleteTask = async () => {
    if (busy) return;
    const confirmed =
      (await requestConfirmDialog(
        t('Delete "{name}"?\nThis cannot be undone.', { name: task.title }),
        { variant: "destructive" },
      )) ?? window.confirm(t('Delete "{name}"? This cannot be undone.', { name: task.title }));
    if (confirmed) {
      await perform(t("Could not delete task"), () =>
        remove({ environmentId, input: { id: task.id } }),
      );
    }
  };
  return (
    <SettingsRow
      title={task.title}
      description={<span className="line-clamp-2">{task.prompt}</span>}
      status={
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {tx("{schedule} · {status}", {
              schedule: scheduleLabel(task.schedule),
              status:
                task.blockedByPolicy !== undefined
                  ? task.blockedByPolicy
                  : !task.enabled
                    ? t("Paused")
                    : isWebhook
                      ? t("Listening")
                      : task.nextRunAt
                        ? tx("Next run {when}", {
                            when: <ScheduledRelativeLabel value={task.nextRunAt} />,
                          })
                        : t("Not scheduled"),
            })}
          </span>
          {task.lastRunStatus !== "never" ? (
            <Badge variant={statusVariant(task.lastRunStatus)}>
              {runStatusLabel(task.lastRunStatus)}
            </Badge>
          ) : null}
          {task.shared ? <SharedTaskBadge task={task} environmentId={environmentId} /> : null}
          {task.lastRunAt && task.lastRunStatus !== "running" ? (
            <span>
              {tx("Last run {when}", { when: <ScheduledRelativeLabel value={task.lastRunAt} /> })}
            </span>
          ) : null}
          {task.lastRunError ? (
            // Run errors are full cause traces, so the row keeps two lines until asked for more.
            <span className="flex basis-full flex-col items-start gap-1">
              <span
                className={cn(
                  "whitespace-pre-wrap break-words text-destructive",
                  !errorExpanded && "line-clamp-2",
                )}
              >
                {task.lastRunError}
              </span>
              {task.lastRunError.length > 160 || task.lastRunError.includes("\n") ? (
                <Button
                  size="xs"
                  variant="ghost"
                  aria-expanded={errorExpanded}
                  onClick={() => setErrorExpanded((expanded) => !expanded)}
                >
                  {errorExpanded ? t("Show less") : t("Show full error")}
                </Button>
              ) : null}
            </span>
          ) : null}
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          <Switch
            checked={task.enabled}
            disabled={busy || !canOperate}
            aria-label={
              task.shared
                ? t("Enable {name} on every machine", { name: task.title })
                : t("Enable {name}", { name: task.title })
            }
            onCheckedChange={() => void toggleEnabled()}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy || !canOperate}
                  aria-label={t("Actions for {name}", { name: task.title })}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={onEdit}>
                <PencilIcon />
                {t("Edit")}
              </MenuItem>
              {isWebhook ? (
                <MenuItem onClick={() => setDeliveriesOpen(true)}>
                  <InboxIcon />
                  {t("Deliveries")}
                </MenuItem>
              ) : (
                <MenuItem onClick={() => void runNow()}>
                  <PlayIcon />
                  {t("Run now")}
                </MenuItem>
              )}
              {offersRunHistory ? (
                <MenuItem onClick={() => setRunsOpen(true)}>
                  <HistoryIcon />
                  {t("Run history")}
                </MenuItem>
              ) : null}
              {supportsScheduledTaskPlacement(task) ? (
                <MenuSub>
                  <MenuSubTrigger>
                    <PinIcon />
                    {t("Show in")}
                  </MenuSubTrigger>
                  <MenuSubPopup>
                    <ScheduledTaskPlacementRadioGroup
                      task={task}
                      onChange={(placement) => void setPlacement(environmentId, [task], placement)}
                    />
                  </MenuSubPopup>
                </MenuSub>
              ) : null}
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={() => void deleteTask()}>
                <Trash2Icon />
                {t("Delete")}
              </MenuItem>
            </MenuPopup>
          </Menu>
          {runsOpen ? (
            <ScheduledTaskRunsDialog
              environmentId={environmentId}
              task={task}
              onClose={() => setRunsOpen(false)}
            />
          ) : null}
          {deliveriesOpen ? (
            <WebhookDeliveriesDialog
              environmentId={environmentId}
              task={task}
              onClose={() => setDeliveriesOpen(false)}
            />
          ) : null}
        </div>
      }
    />
  );
}

function WebhookDeliveriesDialog({
  environmentId,
  task,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly onClose: () => void;
}) {
  const deliveriesQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTaskWebhookDeliveries({
      environmentId,
      input: { id: task.id, acceptAnyOutcome: true },
    }),
  );
  const [selectedId, setSelectedId] = useState<ScheduledTaskWebhookDeliverySummary["id"] | null>(
    null,
  );
  const selectedQuery = useEnvironmentQuery(
    selectedId === null
      ? null
      : serverEnvironment.scheduledTaskWebhookDelivery({
          environmentId,
          input: { id: task.id, deliveryId: selectedId, acceptAnyOutcome: true },
        }),
  );
  const deliveries = deliveriesQuery.data?.deliveries ?? null;
  const selected = selectedQuery.data?.delivery ?? null;
  const error = selectedId === null ? deliveriesQuery.error : selectedQuery.error;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("Deliveries · {name}", { name: task.title })}</DialogTitle>
          <DialogDescription>{t("Recent requests to this task's webhook URL.")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {selectedId !== null && selected === null && selectedQuery.error === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              {t("Loading delivery…")}
            </p>
          ) : selected ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge
                  variant={deliveryOutcomeVariant(
                    selected.pendingWindow ? "coalesced" : selected.outcome,
                  )}
                >
                  {webhookDeliveryLabel(selected)}
                </Badge>
                <span>
                  {selected.method} · <ScheduledRelativeLabel value={selected.receivedAt} />
                </span>
                {selected.signatureVerified ? (
                  <span className="text-muted-foreground">{t("Signature verified")}</span>
                ) : null}
              </div>
              {selected.error ? (
                <p
                  className={
                    selected.outcome === "filtered"
                      ? "text-sm text-muted-foreground"
                      : "text-sm text-destructive"
                  }
                >
                  {selected.error}
                </p>
              ) : null}
              <DeliveryBlock
                title={selected.pendingWindow ? t("Scheduled run") : t("Prompt sent to the agent")}
              >
                {selected.renderedPrompt ??
                  (selected.pendingWindow
                    ? t("Run scheduled when the window closes; no run started yet.")
                    : t("No run was started for this request."))}
              </DeliveryBlock>
              {selected.missingFields.length > 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("Empty placeholders: {names}", { names: selected.missingFields.join(", ") })}
                </p>
              ) : null}
              <DeliveryBlock title={t("Headers")}>
                {Object.entries(selected.headers)
                  .map(([name, value]) => `${name}: ${value}`)
                  .join("\n")}
              </DeliveryBlock>
              {selected.query ? (
                <DeliveryBlock title={t("Query")}>{selected.query}</DeliveryBlock>
              ) : null}
              <DeliveryBlock title={selected.bodyTruncated ? t("Body (truncated)") : t("Body")}>
                {selected.body || t("(empty)")}
              </DeliveryBlock>
            </div>
          ) : selectedId !== null ? null : deliveries === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              {t("Loading deliveries…")}
            </p>
          ) : deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("No requests yet.")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {deliveries.map((delivery) => (
                <li key={delivery.id}>
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center gap-2 py-2 text-left text-sm hover:bg-accent/40"
                    onClick={() => setSelectedId(delivery.id)}
                  >
                    <Badge
                      variant={deliveryOutcomeVariant(
                        delivery.pendingWindow ? "coalesced" : delivery.outcome,
                      )}
                    >
                      {webhookDeliveryLabel(delivery)}
                    </Badge>
                    <span>{delivery.method}</span>
                    <span className="text-muted-foreground">
                      <ScheduledRelativeLabel value={delivery.receivedAt} />
                    </span>
                    {delivery.outcome === "filtered" && delivery.error ? (
                      <span className="text-muted-foreground">{delivery.error}</span>
                    ) : null}
                    {delivery.missingFields.length > 0 ? (
                      <span className="text-muted-foreground">
                        {tn(
                          delivery.missingFields.length,
                          "{count} empty placeholder",
                          "{count} empty placeholders",
                        )}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          {selectedId !== null ? (
            <Button variant="outline" size="sm" onClick={() => setSelectedId(null)}>
              {t("Back")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={deliveriesQuery.isPending}
              onClick={deliveriesQuery.refresh}
            >
              {t("Refresh")}
            </Button>
          )}
          <DialogClose render={<Button size="sm" />}>{t("Done")}</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DeliveryBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{title}</Label>
      <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-all">
        {children}
      </pre>
    </div>
  );
}

function WebhookEndpointField({
  environmentId,
  task,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
}) {
  const canRotate = useAtomValue(
    serverEnvironment.rotateScheduledTaskWebhookToken.permissionAtom(environmentId),
  );
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: t("webhook URL") });
  const rotate = useAtomCommand(serverEnvironment.rotateScheduledTaskWebhookToken, {
    label: "scheduled task rotate webhook token",
  });
  const [rotating, setRotating] = useState(false);
  const endpoint = task?.webhook;
  if (!task || !endpoint) {
    return <p className="text-sm text-muted-foreground">{t("The URL appears after you save.")}</p>;
  }
  const { address: url, copyable, note } = webhookAddress(endpoint, httpBaseUrl);
  const rotateUrl = async () => {
    const confirmed =
      (await requestConfirmDialog(t("Rotate this webhook URL?\nThe current URL stops working."), {
        variant: "destructive",
      })) ?? window.confirm(t("Rotate this webhook URL? The current URL stops working."));
    if (!confirmed) return;
    setRotating(true);
    const result = await rotate({ environmentId, input: { id: task.id } });
    setRotating(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Could not rotate webhook URL"),
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Input
          readOnly
          aria-label={t("Webhook URL")}
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={!copyable}
          onClick={() => copyToClipboard(url, undefined)}
        >
          <CopyIcon />
          {isCopied ? t("Copied") : t("Copy")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={rotating || !canRotate}
          onClick={() => void rotateUrl()}
        >
          {t("Rotate")}
        </Button>
      </div>
      {note !== null ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {endpoint.url !== null ? <WebhookDeliveryMode environmentId={environmentId} /> : null}
    </div>
  );
}

function WebhookDeliveryMode({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const cloudLink = usePrimaryCloudLinkState();
  if (cloudLink.target?.environmentId !== environmentId || cloudLink.data === null) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {cloudLink.data.holdWebhooksWhileOffline
        ? t("Held for up to 24 hours while this environment is offline.")
        : t("Forwarded live. Requests fail while this environment is offline.")}{" "}
      <Link to="/settings/connections" className="underline underline-offset-2">
        {t("Change in Machines & access")}
      </Link>
    </p>
  );
}

function ScheduledTaskEditorDialog({
  initialEnvironmentId,
  task,
  onClose,
}: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [shown, setShown] = useState({ environmentId: initialEnvironmentId, task, created: false });
  const [edited, setEdited] = useState(false);
  const requestClose = async () => {
    if (saving) return;
    const discard =
      !edited ||
      ((await requestConfirmDialog(t("Discard changes?\nYour unsaved changes will be lost."), {
        variant: "destructive",
      })) ??
        window.confirm(t("Discard changes? Your unsaved changes will be lost.")));
    if (discard) onClose();
  };
  return (
    <Dialog
      open
      // A stray click outside would drop a long prompt; Escape and Cancel ask first.
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) void requestClose();
      }}
    >
      {/* The form owns the draft so a keystroke re-renders it, not the dialog chrome. */}
      <DialogPopup className="max-w-xl">
        <ScheduledTaskEditorForm
          key={shown.task?.id ?? "new"}
          initialEnvironmentId={shown.environmentId}
          task={shown.task}
          justCreated={shown.created}
          saving={saving}
          onSavingChange={setSaving}
          onEdited={() => setEdited(true)}
          onClose={onClose}
          // A new webhook task's URL only exists once saved, so the form reopens on it.
          onCreatedWebhook={(environmentId, created) => {
            setEdited(false);
            setShown({ environmentId, task: created, created: true });
          }}
        />
      </DialogPopup>
    </Dialog>
  );
}

function ScheduledTaskDestination({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
}) {
  const ref = threadId === null ? null : scopeThreadRef(environmentId, threadId);
  const shell = useThreadShell(ref);
  // The shell can omit older settled threads; their family read still carries the title.
  const family = useEnvironmentQuery(
    ref !== null && shell === null ? threadFamilies.familyAtom(environmentId, ref.threadId) : null,
  );
  const thread = shell ?? family.data?.threads.find((row) => row.id === threadId);
  return (
    <Field label={t("Destination")}>
      {ref === null ? (
        <p className="text-sm text-muted-foreground">
          {t("Each run starts a new thread with the workspace and model below.")}
        </p>
      ) : (
        <div className="space-y-1 text-sm">
          <p className="wrap-anywhere">
            {thread?.title.trim() || t("Thread {id}", { id: ref.threadId })}
          </p>
          <p className="text-muted-foreground">
            {t(
              "Each run continues this conversation, in its workspace and with its current model.",
            )}
          </p>
        </div>
      )}
    </Field>
  );
}

function ScheduledTaskEditorForm({
  initialEnvironmentId,
  task,
  justCreated,
  saving,
  onSavingChange: setSaving,
  onEdited,
  onClose,
  onCreatedWebhook,
}: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  /** The save answered with this task, which the live list may not include yet. */
  readonly justCreated: boolean;
  readonly saving: boolean;
  readonly onSavingChange: (saving: boolean) => void;
  /** Every draft change comes from the user, so the first one marks the form as edited. */
  readonly onEdited: () => void;
  readonly onClose: () => void;
  readonly onCreatedWebhook: (environmentId: EnvironmentId, task: ScheduledTask) => void;
}) {
  const { scope, connectedEnvironments } = useSettingsScope();
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentId);
  const environment = useEnvironment(environmentId);
  // Older servers reject one-time schedules, so offer Once only where it can save.
  const offersOnce =
    environment?.serverConfig?.environment.capabilities.oneTimeSchedules === true ||
    task?.schedule.type === "once";
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const tasksQuery = useEnvironmentQuery(
    connected ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  const allProjects = useProjects();
  const projectsOn = (id: EnvironmentId) =>
    allProjects.filter(
      (project) => project.environmentId === id && matchesScheduledTaskScope(scope, id, project.id),
    );
  const scopedProjects = projectsOn(environmentId);
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const upsertTask = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
  });
  const webhookDenial = managedCapabilityDenial(useManagedPolicy(environmentId), "webhookTasks");
  const [draft, setDraftState] = useState<DraftState>(() =>
    task
      ? taskToDraft(task)
      : {
          ...EMPTY_DRAFT,
          projectId: defaultScheduledTaskProjectId(scopedProjects, scope),
        },
  );
  const setDraft: typeof setDraftState = (update) => {
    onEdited();
    setDraftState(update);
  };
  // Pinned first. The chosen project stays listed after it is archived.
  const projects = scopedProjects
    .filter(
      (project) =>
        project.archivedAt == null ||
        project.id === draft.projectId ||
        project.id === task?.projectId,
    )
    .sort((left, right) => Number(right.pinnedAt != null) - Number(left.pinnedAt != null));
  const submissionPending = useRef(false);
  const listedTask = tasksQuery.data?.tasks.find((entry) => entry.id === draft.editingId) ?? null;
  // Until the live list catches up with a save, the task it answered with stands in for it.
  const [awaitingList, setAwaitingList] = useState(justCreated);
  if (awaitingList && listedTask !== null) setAwaitingList(false);
  const editingTaskMissing =
    draft.editingId !== null && tasksQuery.data !== null && listedTask === null && !awaitingList;
  const liveTask = tasksQuery.data ? (listedTask ?? (awaitingList ? task : null)) : task;
  const selectedProjectId = draft.projectId || projects[0]?.id || "";
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const instanceEntries = providerInstanceEntriesFor(
    providers,
    settings,
    selectedProject?.id ?? null,
  );

  const inheritedDefaultModel = useInheritedDefaultModelSelection(
    environmentId,
    selectedProject?.id ?? null,
  );
  const firstInstance = instanceEntries[0];
  const draftSelection = draft.modelKey ? splitModelKey(draft.modelKey) : null;
  const defaultSelection = scheduledTaskDefaultModel(
    settings,
    selectedProject ?? null,
    instanceEntries,
    inheritedDefaultModel,
  );
  // A task bound to a thread runs that thread's model, so the default does not apply to it.
  const offersShared = supportsSharedScheduledTasks(environment);
  const sharing = offersShared && draft.shared;
  const sharedMachines = connectedEnvironments.filter(supportsSharedScheduledTasks);
  const sharedMachineIds = sharedMachines.map((entry) => entry.environmentId);
  const sharedSnapshots = useAtomValue(
    sharedScheduledTaskSnapshotsAtom(environmentIdsKey(sharedMachineIds)),
  );
  const editedShared = (liveTask ?? task)?.shared;
  const sharedProject = sharedProjectReference({
    editedShared,
    editedProjectId: (liveTask ?? task)?.projectId,
    project: selectedProject,
  });
  const storedMachineOrder =
    sharedProject === null ? null : newestProjectMachineOrder(sharedSnapshots, sharedProject);
  const machineOrder = visibleMachineOrder(
    draft.sharedMachineOrder ??
      seedMachineOrder(storedMachineOrder, sharedMachineIds, environmentId),
    sharedMachineIds,
  );
  const editorNowMinute = useNowMinute();
  const editorLinkWarnings = oneMachineLinkWarnings(
    sharedSnapshots,
    effectiveOneMachineOrder(machineOrder, draft.sharedExcludedEnvironmentIds, sharedMachineIds),
    Date.parse(`${editorNowMinute}:00.000Z`),
  ).map((warning) =>
    describeOneMachineLinkWarning(
      warning,
      (id) => sharedMachines.find((entry) => entry.environmentId === id)?.label ?? id,
    ),
  );
  const offersDefaultModel =
    environment?.serverConfig?.environment.capabilities.scheduledTaskDefaultModel === true &&
    (sharing || !draft.threadId);
  const followsDefaultModel = offersDefaultModel && draft.followsDefaultModel;
  const offersCatchUp =
    environment?.serverConfig?.environment.capabilities.scheduledTaskRunHistory === true;
  const catchUpMissedRun =
    draft.catchUpMissedRun ??
    defaultCatchUpMissedRun({
      type: "fixed_time",
      timeOfDay: draft.timeOfDay || "09:00",
      weekdays: [...draft.weekdays],
    });
  const ownSelection =
    draftSelection &&
    instanceEntries.some((entry) => entry.instanceId === draftSelection.instanceId && entry.enabled)
      ? draftSelection
      : defaultSelection;
  const activeSelection = followsDefaultModel ? defaultSelection : ownSelection;
  // The source selection keeps its options and Auto while the picker leaves instanceId:model as is.
  const chosenSelection =
    followsDefaultModel ||
    activeSelection === null ||
    draft.baseModelSelection === null ||
    draft.baseModelSelection.instanceId !== activeSelection.instanceId ||
    draft.baseModelSelection.model !== activeSelection.model
      ? activeSelection
      : draft.baseModelSelection;
  const autoPick = autoModePick({ settings, accounts: providers, lockedDriver: null });
  const activeInstanceId =
    activeSelection?.instanceId ?? firstInstance?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = activeSelection?.model ?? "";
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId,
    activeModel,
  );

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const submit = async () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      submissionPending.current ||
      saving ||
      editingTaskMissing ||
      !connected ||
      tasksQuery.data === null
    )
      return;
    const selection = chosenSelection;
    const missing = [
      { missing: !draft.title.trim(), label: "name", fieldId: "scheduled-task-title" },
      {
        missing: !projects.some((project) => project.id === selectedProjectId),
        label: "project",
        fieldId: "scheduled-task-project",
      },
      { missing: !draft.prompt.trim(), label: "prompt", fieldId: "scheduled-task-prompt" },
      { missing: selection === null, label: "model", fieldId: null },
    ].filter((field) => field.missing);
    if (missing.length > 0 || selection === null) {
      const missingNames = new Set(missing.map((field) => field.label));
      const fieldName = (name: string) => missingNames.has(name);
      const parts = [
        fieldName("name") ? t("a name") : null,
        fieldName("project") ? t("a project") : null,
        fieldName("prompt") ? t("a prompt") : null,
        fieldName("model") ? t("a model") : null,
      ].filter((part) => part !== null);
      reportFailure(
        t("Scheduled task is incomplete"),
        t("Add {fields}.", {
          fields: new Intl.ListFormat(getFormattingLocale(), {
            style: "long",
            type: "conjunction",
          }).format(parts),
        }),
      );
      const firstFieldId = missing.find((field) => field.fieldId !== null)?.fieldId;
      if (firstFieldId) document.getElementById(firstFieldId)?.focus();
      return;
    }
    const parsedFilters = parseWebhookFilterDrafts(draft.filters);
    if (draft.scheduleMode === "webhook" && "error" in parsedFilters) {
      reportFailure(t("Invalid filter"), parsedFilters.error);
      return;
    }
    const schedule = scheduleFromDraft(draft);
    if (schedule === null) {
      for (const error of scheduleDraftErrors(draft)) reportFailure(error.title, error.description);
      return;
    }
    if (
      schedule.type === "webhook" &&
      schedule.signature &&
      (!schedule.signature.header ||
        (!schedule.signature.secret &&
          !(liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret)))
    ) {
      reportFailure(t("Signing secret is required"), t("Enter the signature header and secret."));
      return;
    }
    if (
      schedule.type === "interval" &&
      (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS)
    ) {
      reportFailure(t("Invalid interval"), t("Enter an interval of at least one minute."));
      return;
    }
    if (schedule.type === "once" && !offersOnce) {
      reportFailure(
        t("Once is not available here"),
        t(
          "This environment runs an older T3.CodeShip. Update it to schedule a one-time task, or pick another schedule.",
        ),
      );
      return;
    }
    if (draft.workspaceMode === "existing_worktree" && !draft.existingWorktreePath.trim()) {
      reportFailure(t("Checkout path is required"), t("Enter the path of the checkout to run in."));
      return;
    }
    const workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy =
      draft.workspaceMode === "root"
        ? { type: "root" }
        : draft.workspaceMode === "existing_worktree"
          ? { type: "existing_worktree", worktreePath: draft.existingWorktreePath.trim() }
          : {
              type: "worktree",
              baseRef: draft.baseRef.trim() || "main",
              startFromOrigin: draft.startFromOrigin,
            };
    const input: ScheduledTaskUpsertInput = {
      ...(draft.editingId ? { id: draft.editingId as ScheduledTaskId, requireExisting: true } : {}),
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      enabled: draft.enabled,
      schedule,
      projectId: selectedProjectId as ProjectId,
      threadId: draft.threadId && !sharing ? (draft.threadId as ThreadId) : null,
      workspaceStrategy,
      modelSelection: selection,
      ...(offersDefaultModel ? { followsDefaultModel } : {}),
      // Untouched on a new task, the server applies the schedule's default.
      ...(offersCatchUp && draft.scheduleMode === "fixed" && draft.catchUpMissedRun !== null
        ? { catchUpMissedRun: draft.catchUpMissedRun }
        : {}),
      // Tasks have no mode picker; a mode above the administrator's ceiling would fail every run.
      runtimeMode:
        clampManagedRuntimeMode(environment?.serverConfig?.managedPolicy, draft.runtimeMode) ??
        draft.runtimeMode,
      interactionMode: draft.interactionMode,
      creationSource: "web",
      ...sharedUpsertField({
        supported: offersShared,
        shared: draft.shared,
        wasShared: (liveTask ?? task)?.shared != null,
        excludedEnvironmentIds: draft.sharedExcludedEnvironmentIds,
        runOn: draft.sharedRunOn,
        ...(draft.sharedMachineOrder !== null ||
        (sharedProject !== null && storedMachineOrder === null)
          ? { machineOrder: mergeMachineOrder(machineOrder, storedMachineOrder?.order ?? []) }
          : {}),
      }),
    };
    // Lock before React renders, and keep successful creates locked until the form closes.
    submissionPending.current = true;
    setSaving(true);
    const result = await upsertTask({ environmentId, input });
    setSaving(false);
    if (result._tag === "Failure") {
      submissionPending.current = false;
      if (!isAtomCommandInterrupted(result)) {
        reportFailure(t("Could not save scheduled task"), squashAtomCommandFailure(result));
      }
      return;
    }
    if (task === null && result.value.task.schedule.type === "webhook") {
      onCreatedWebhook(environmentId, result.value.task);
      return;
    }
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{draft.editingId ? t("Edit task") : t("New task")}</DialogTitle>
        <DialogDescription>
          {t(
            "Run a prompt automatically on an interval, at a fixed time, once at a set date, or when a webhook is called.",
          )}
        </DialogDescription>
      </DialogHeader>

      <DialogPanel>
        {/* Fieldsets default to min-width: min-content, which lets one wide control widen the form past the dialog. */}
        <fieldset disabled={saving} className="min-w-0 space-y-5">
          {!connected ? (
            <p className="text-sm text-destructive">
              {t("Reconnect this environment before saving.")}
            </p>
          ) : null}
          <Field label={t("Runs on")} htmlFor="scheduled-task-environment">
            <Select
              value={environmentId}
              disabled={task !== null || saving}
              onValueChange={(id) => {
                const next = connectedEnvironments.find((entry) => entry.environmentId === id);
                if (!next) return;
                setEnvironmentId(next.environmentId);
                setDraft((current) => ({
                  ...current,
                  projectId: defaultScheduledTaskProjectId(projectsOn(next.environmentId), scope),
                  modelKey: "",
                  baseModelSelection: null,
                  baseRef: "main",
                  startFromOrigin: true,
                  existingWorktreePath: "",
                }));
              }}
            >
              <SelectTrigger id="scheduled-task-environment" size="sm">
                <SelectValue>
                  <span className="flex items-center gap-2">
                    <EnvironmentMachineIcon
                      kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
                      className="size-4"
                    />
                    {environment?.label ?? t("Unavailable environment")}
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {connectedEnvironments.map((entry) => {
                  const { secondary } = settingsScopeEnvironmentLabels(
                    entry,
                    connectedEnvironments,
                  );
                  return (
                    <SelectItem
                      key={entry.environmentId}
                      value={entry.environmentId}
                      label={entry.label}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <EnvironmentMachineIcon
                          kind={resolveEnvironmentMachineKind(entry.serverConfig)}
                          className="size-4"
                        />
                        <span className="min-w-0">
                          <span className="block truncate">{entry.label}</span>
                          {secondary ? (
                            <span className="block max-w-72 truncate text-xs text-muted-foreground">
                              {secondary}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectPopup>
            </Select>
          </Field>
          {offersShared ? (
            <div className="space-y-3">
              <Field label={t("Runs")}>
                <ToggleGroup
                  aria-label={t("Which machines run this task")}
                  value={[draft.shared ? draft.sharedRunOn : "this"]}
                  disabled={saving || !connected}
                  onValueChange={(values) => {
                    const choice = values[0] as "this" | "every" | "one" | undefined;
                    if (choice === undefined) return;
                    setDraft((current) => ({
                      ...current,
                      shared: choice !== "this",
                      sharedRunOn: choice === "one" ? "one" : "every",
                      // Shared tasks never use a webhook, so a webhook draft falls back to a time.
                      scheduleMode:
                        choice !== "this" && current.scheduleMode === "webhook"
                          ? "fixed"
                          : current.scheduleMode,
                    }));
                  }}
                >
                  <Toggle value="this">{t("This machine")}</Toggle>
                  <Toggle value="every">{t("Every machine")}</Toggle>
                  <Toggle value="one">{t("One machine")}</Toggle>
                </ToggleGroup>
              </Field>
              {draft.shared ? (
                <p className="text-sm text-muted-foreground">
                  {draft.sharedRunOn === "one"
                    ? t(
                        "Order for {project}, used by all its one-machine tasks. The first machine that's online runs each run; the next one runs it if the first is offline or its run fails.",
                        { project: selectedProject?.title ?? t("this project") },
                      )
                    : t(
                        "Keeps a copy on each machine, in sync. Each machine runs it on its own schedule.",
                      )}
                </p>
              ) : null}
              {draft.shared ? (
                <ol aria-label={t("Machines")} className="space-y-1.5">
                  {(draft.sharedRunOn === "one" ? machineOrder : sharedMachineIds).flatMap(
                    (machineId, index, ids) => {
                      const entry = sharedMachines.find((item) => item.environmentId === machineId);
                      if (!entry) return [];
                      return [
                        <li key={machineId} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            aria-label={t("Run on {machine}", { machine: entry.label })}
                            checked={!draft.sharedExcludedEnvironmentIds.includes(machineId)}
                            disabled={saving}
                            onCheckedChange={(checked) =>
                              setDraft((current) => ({
                                ...current,
                                sharedExcludedEnvironmentIds: toggleSharedExclusion(
                                  current.sharedExcludedEnvironmentIds,
                                  machineId,
                                  checked === true,
                                ),
                              }))
                            }
                          />
                          <EnvironmentMachineIcon
                            kind={resolveEnvironmentMachineKind(entry.serverConfig)}
                            className="size-4"
                          />
                          <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                          {draft.sharedRunOn === "one" ? (
                            <>
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                aria-label={t("Move {machine} up", { machine: entry.label })}
                                disabled={saving || index === 0}
                                onClick={() =>
                                  setDraft((current) => ({
                                    ...current,
                                    sharedMachineOrder: moveMachine(ids, machineId, -1),
                                  }))
                                }
                              >
                                <ChevronUpIcon className="size-3.5" />
                              </Button>
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                aria-label={t("Move {machine} down", { machine: entry.label })}
                                disabled={saving || index === ids.length - 1}
                                onClick={() =>
                                  setDraft((current) => ({
                                    ...current,
                                    sharedMachineOrder: moveMachine(ids, machineId, 1),
                                  }))
                                }
                              >
                                <ChevronDownIcon className="size-3.5" />
                              </Button>
                            </>
                          ) : null}
                        </li>,
                      ];
                    },
                  )}
                </ol>
              ) : null}
              {draft.shared && draft.sharedRunOn === "one" ? (
                <div className="space-y-1 text-sm text-warning-foreground" role="status">
                  {editorLinkWarnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                  {editorLinkWarnings.length > 0 ? (
                    <p className="text-muted-foreground">
                      {t("A machine that can't check the ones ahead of it runs the task anyway.")}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {tasksQuery.error ? (
            <p className="text-sm text-destructive" role="status">
              {tasksQuery.error}
            </p>
          ) : null}
          {editingTaskMissing ? (
            <p className="text-xs text-destructive" role="status">
              {t("This scheduled task no longer exists.")}
            </p>
          ) : null}
          <Field label={t("Name")} htmlFor="scheduled-task-title">
            <Input
              id="scheduled-task-title"
              placeholder={t("e.g. Check for Sentry issues")}
              value={draft.title}
              onChange={(event) =>
                setDraft((current) => ({ ...current, title: event.target.value }))
              }
            />
          </Field>

          {sharing ? null : (
            <ScheduledTaskDestination
              environmentId={environmentId}
              threadId={draft.threadId ? (draft.threadId as ThreadId) : null}
            />
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("Project")} htmlFor="scheduled-task-project">
              <Select
                value={selectedProjectId}
                onValueChange={(projectId) =>
                  setDraft((current) => ({ ...current, projectId: projectId ?? "" }))
                }
              >
                <SelectTrigger size="sm" id="scheduled-task-project">
                  <SelectValue placeholder={t("Select a project")}>
                    {selectedProject?.title}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id} label={project.title}>
                      <span className="block truncate">{project.title}</span>
                      {allProjects.some(
                        (other) =>
                          other.title === project.title &&
                          (other.environmentId !== project.environmentId ||
                            other.id !== project.id),
                      ) ? (
                        <span className="block max-w-72 truncate text-xs text-muted-foreground">
                          {project.workspaceRoot}
                        </span>
                      ) : null}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>

            <Field label={t("Workspace")} htmlFor="scheduled-task-workspace">
              <Select
                value={draft.workspaceMode}
                onValueChange={(value) =>
                  setDraft((current) => ({ ...current, workspaceMode: value as WorkspaceMode }))
                }
              >
                <SelectTrigger size="sm" id="scheduled-task-workspace">
                  <SelectValue>{t(WORKSPACE_MODE_LABELS[draft.workspaceMode])}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="worktree">{t("Create a new worktree")}</SelectItem>
                  <SelectItem value="root">{t("Use the project checkout")}</SelectItem>
                  <SelectItem value="existing_worktree">{t("Use a specific checkout")}</SelectItem>
                </SelectPopup>
              </Select>
            </Field>
          </div>

          {draft.workspaceMode === "worktree" ? (
            <Field label={t("Base branch")} htmlFor="scheduled-task-base-ref">
              <WorktreeBaseBranchPicker
                key={`${environmentId}:${selectedProjectId}`}
                id="scheduled-task-base-ref"
                environmentId={environmentId}
                cwd={selectedProject?.workspaceRoot ?? null}
                value={draft.baseRef}
                onValueChange={(baseRef) => setDraft((current) => ({ ...current, baseRef }))}
                startFromOrigin={draft.startFromOrigin}
                onStartFromOriginChange={(startFromOrigin) =>
                  setDraft((current) => ({ ...current, startFromOrigin }))
                }
                disabled={saving || !connected}
              />
            </Field>
          ) : null}
          {draft.workspaceMode === "existing_worktree" ? (
            <Field label={t("Checkout path")} htmlFor="scheduled-task-checkout">
              <Input
                id="scheduled-task-checkout"
                value={draft.existingWorktreePath}
                placeholder={"/path/to/checkout"}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    existingWorktreePath: resolvePastedPath(
                      current.existingWorktreePath,
                      event.target.value,
                    ),
                  }))
                }
              />
            </Field>
          ) : null}

          <Field label={t("Prompt")} htmlFor="scheduled-task-prompt">
            <Textarea
              id="scheduled-task-prompt"
              className="max-h-64 overflow-y-auto"
              placeholder={t("What should the agent do each time this runs?")}
              value={draft.prompt}
              onChange={(event) =>
                setDraft((current) => ({ ...current, prompt: event.target.value }))
              }
            />
          </Field>

          <Field label={t("Model")}>
            <div className="space-y-3">
              {offersDefaultModel ? (
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor="scheduled-task-default-model">{t("Use default model")}</Label>
                    <p
                      id="scheduled-task-default-model-description"
                      className="text-sm text-muted-foreground"
                    >
                      {t(
                        "Runs the scheduled tasks model from Settings › Threads, and follows it when it changes.",
                      )}
                    </p>
                  </div>
                  <Switch
                    id="scheduled-task-default-model"
                    aria-describedby="scheduled-task-default-model-description"
                    checked={draft.followsDefaultModel}
                    disabled={saving || !connected}
                    onCheckedChange={(checked) =>
                      setDraft((current) => ({ ...current, followsDefaultModel: checked }))
                    }
                  />
                </div>
              ) : null}
              <ProviderModelPicker
                environmentId={environmentId}
                disabled={saving || !connected || followsDefaultModel}
                activeInstanceId={activeInstanceId}
                model={activeModel}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                isComposerOwned={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onInstanceModelChange={(instanceId, model) =>
                  setDraft((current) => ({
                    ...current,
                    modelKey: `${instanceId}:${model}`,
                    // A model picked by name runs as named, even the one Auto ran.
                    baseModelSelection:
                      current.baseModelSelection &&
                      withAutoAccount(current.baseModelSelection, false),
                  }))
                }
                auto={{
                  pick: autoPick,
                  checked: chosenSelection?.autoAccount === true,
                  onSelect: () => {
                    if (autoPick === null) return;
                    setDraft((current) => ({
                      ...current,
                      modelKey: `${autoPick.instanceId}:${autoPick.model}`,
                      baseModelSelection: autoPick,
                    }));
                  },
                }}
              />
            </div>
          </Field>

          <div className="space-y-3">
            {task?.schedule.type === "interval" &&
            task.schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS ? (
              <p className="text-sm text-muted-foreground" role="status">
                {t(
                  "This task uses a legacy interval below one minute. Saving updates it to at least one minute.",
                )}
              </p>
            ) : null}
            {/* Wraps the toggle below the label when both don't fit, as on phones. */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>{t("Schedule")}</Label>
              {/* Four options outgrow the narrowest phones, so they scroll instead of the dialog. */}
              <div className="max-w-full overflow-x-auto">
                <ToggleGroup
                  aria-label={t("Schedule type")}
                  value={[draft.scheduleMode]}
                  onValueChange={(values) => {
                    const mode = values[0] as ScheduleMode | undefined;
                    if (
                      mode === "fixed" ||
                      mode === "once" ||
                      mode === "interval" ||
                      mode === "webhook"
                    )
                      setDraft((current) => {
                        const suggested =
                          mode === "once" && !current.runAt
                            ? new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000)
                            : null;
                        return {
                          ...current,
                          scheduleMode: mode,
                          // Keep the instant too, so an hour that repeats when clocks go back stays exact.
                          ...(suggested === null
                            ? {}
                            : {
                                runAt: toDateTimeLocalValue(suggested),
                                savedRunAt: suggested.toISOString(),
                              }),
                          prompt:
                            mode === "webhook" && !current.prompt.trim()
                              ? DEFAULT_WEBHOOK_PROMPT
                              : current.prompt,
                        };
                      });
                  }}
                >
                  <Toggle value="fixed">{t("At a time")}</Toggle>
                  {offersOnce || draft.scheduleMode === "once" ? (
                    <Toggle value="once">{t("Once")}</Toggle>
                  ) : null}
                  <Toggle value="interval">{t("Every interval")}</Toggle>
                  <Toggle
                    value="webhook"
                    disabled={
                      sharing || (webhookDenial !== undefined && draft.scheduleMode !== "webhook")
                    }
                  >
                    {t("On webhook")}
                  </Toggle>
                </ToggleGroup>
              </div>
            </div>

            {webhookDenial !== undefined ? (
              <ManagedNotice>
                {draft.scheduleMode === "webhook"
                  ? t(
                      "{reason} Switch this task to a time or an interval, or turn it off, to save it.",
                      {
                        reason: webhookDenial,
                      },
                    )
                  : webhookDenial}
              </ManagedNotice>
            ) : null}
            {/* A disabled task still saves, so keep its fields reachable for fixing. */}
            {draft.scheduleMode === "webhook" &&
            webhookDenial !== undefined &&
            draft.enabled ? null : draft.scheduleMode === "webhook" ? (
              <div className="space-y-4">
                <WebhookEndpointField environmentId={environmentId} task={liveTask} />
                <p className="text-xs text-muted-foreground">
                  {t(
                    "Each request runs the prompt. Use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} or {{request}} in the prompt; only what it names reaches the agent.",
                  )}
                </p>
                <Field
                  label={t("Skip requests older than")}
                  hint={t("minutes, optional")}
                  htmlFor="scheduled-task-max-age"
                >
                  <Input
                    id="scheduled-task-max-age"
                    type="number"
                    nativeInput
                    min={1}
                    max={MAX_WEBHOOK_DELIVERY_AGE_MINUTES}
                    placeholder={t("Run every request")}
                    value={draft.maxDeliveryAgeMinutes}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        maxDeliveryAgeMinutes: event.target.value,
                      }))
                    }
                  />
                </Field>
                <WebhookFiltersField
                  filters={draft.filters}
                  onChange={(filters) => setDraft((current) => ({ ...current, filters }))}
                />
                <Field
                  label={t("Duplicate request key")}
                  hint={t("template, optional")}
                  htmlFor="scheduled-task-replay-key"
                >
                  <Input
                    id="scheduled-task-replay-key"
                    placeholder={"{{headers.delivery-id}}"}
                    value={draft.replayKey}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, replayKey: event.target.value }))
                    }
                  />
                </Field>
                <p className="text-xs text-muted-foreground">
                  {t("Requests with the same key run only once within 7 days.")}
                </p>
                <Field
                  label={t("Coalesce key")}
                  hint={t("template, optional")}
                  htmlFor="scheduled-task-coalesce-key"
                >
                  <Input
                    id="scheduled-task-coalesce-key"
                    placeholder={"{{body.id}}"}
                    value={draft.coalesceKey}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, coalesceKey: event.target.value }))
                    }
                  />
                </Field>
                <Field
                  label={t("Coalesce window")}
                  hint={t("seconds, 10–3600")}
                  htmlFor="scheduled-task-coalesce-window"
                >
                  <Input
                    id="scheduled-task-coalesce-window"
                    type="number"
                    nativeInput
                    min={10}
                    max={3600}
                    placeholder="120"
                    value={draft.coalesceWindowSeconds}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        coalesceWindowSeconds: event.target.value,
                      }))
                    }
                  />
                </Field>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "Coalescing runs the latest payload once when the window from the first delivery closes. Empty keys run normally.",
                  )}
                </p>
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor="scheduled-task-signature">{t("Require signature")}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t("Reject requests without a valid HMAC-SHA256 signature of the body.")}
                    </p>
                  </div>
                  <Switch
                    id="scheduled-task-signature"
                    checked={draft.signatureEnabled}
                    onCheckedChange={(signatureEnabled) =>
                      setDraft((current) => ({ ...current, signatureEnabled }))
                    }
                  />
                </div>
                {draft.signatureEnabled ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t("Header")} htmlFor="scheduled-task-signature-header">
                      <Input
                        id="scheduled-task-signature-header"
                        value={draft.signatureHeader}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            signatureHeader: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    <Field label={t("Prefix")} htmlFor="scheduled-task-signature-prefix">
                      <Input
                        id="scheduled-task-signature-prefix"
                        value={draft.signaturePrefix}
                        placeholder={t("None")}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            signaturePrefix: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    <Field label={t("Encoding")} htmlFor="scheduled-task-signature-encoding">
                      <Select
                        value={draft.signatureEncoding}
                        onValueChange={(value) =>
                          setDraft((current) => ({
                            ...current,
                            signatureEncoding: value === "base64" ? "base64" : "hex",
                          }))
                        }
                      >
                        <SelectTrigger size="sm" id="scheduled-task-signature-encoding">
                          <SelectValue>{draft.signatureEncoding}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value="hex">{"hex"}</SelectItem>
                          <SelectItem value="base64">{"base64"}</SelectItem>
                        </SelectPopup>
                      </Select>
                    </Field>
                    <Field label={t("Secret")} htmlFor="scheduled-task-signature-secret">
                      <Input
                        id="scheduled-task-signature-secret"
                        type="password"
                        autoComplete="off"
                        value={draft.signatureSecret}
                        placeholder={
                          liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret
                            ? t("Unchanged")
                            : t("Shared secret")
                        }
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            signatureSecret: event.target.value,
                          }))
                        }
                      />
                    </Field>
                  </div>
                ) : null}
              </div>
            ) : draft.scheduleMode === "once" ? (
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="scheduled-task-run-at">{t("Run on")}</Label>
                <Input
                  type="datetime-local"
                  id="scheduled-task-run-at"
                  nativeInput
                  className="w-56"
                  value={draft.runAt}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, runAt: event.target.value }))
                  }
                />
              </div>
            ) : draft.scheduleMode === "fixed" ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="scheduled-task-time">{t("Run at")}</Label>
                    <Input
                      type="time"
                      id="scheduled-task-time"
                      nativeInput
                      className="w-32"
                      value={draft.timeOfDay}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, timeOfDay: event.target.value }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">{t("on")}</span>
                  </div>
                  <ToggleGroup
                    multiple
                    variant="outline"
                    size="sm"
                    aria-label={t("Days to run")}
                    value={[...draft.weekdays].map(String)}
                    onValueChange={(values) => {
                      if (values.length === 0) return;
                      setDraft((current) => ({
                        ...current,
                        weekdays: new Set(values.map(Number)),
                      }));
                    }}
                  >
                    {WEEKDAY_ORDER.map((day) => (
                      <Toggle key={day} value={String(day)} aria-label={t(WEEKDAY_LABELS[day])}>
                        {t(WEEKDAY_SHORT[day])}
                      </Toggle>
                    ))}
                  </ToggleGroup>
                </div>
                {/* The server reads the time in its own zone, which a remote machine may not share. */}
                <p className="text-xs text-muted-foreground">
                  {t("Uses the clock on {name}.", {
                    name: environment?.label ?? t("the machine that runs it"),
                  })}
                </p>
                {offersCatchUp ? (
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor="scheduled-task-catch-up">{t("Catch up a missed run")}</Label>
                      <p
                        id="scheduled-task-catch-up-description"
                        className="text-xs text-muted-foreground"
                      >
                        {t(
                          "If the machine was off or asleep at the time, run once when it is back, unless the next run comes sooner.",
                        )}
                      </p>
                    </div>
                    <Switch
                      id="scheduled-task-catch-up"
                      aria-describedby="scheduled-task-catch-up-description"
                      checked={catchUpMissedRun}
                      disabled={saving || !connected}
                      onCheckedChange={(checked) =>
                        setDraft((current) => ({ ...current, catchUpMissedRun: checked }))
                      }
                    />
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Label htmlFor="scheduled-task-interval">{t("Run every")}</Label>
                <Input
                  type="number"
                  id="scheduled-task-interval"
                  nativeInput
                  min={1}
                  step="any"
                  className="w-24"
                  value={draft.intervalMinutes}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, intervalMinutes: event.target.value }))
                  }
                />
                <span className="text-xs text-muted-foreground">{t("minutes")}</span>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="scheduled-task-enabled">{t("Enabled")}</Label>
              <p id="scheduled-task-enabled-description" className="text-sm text-muted-foreground">
                {t("Disabled tasks stay saved but do not run.")}
              </p>
            </div>
            <Switch
              id="scheduled-task-enabled"
              aria-describedby="scheduled-task-enabled-description"
              checked={draft.enabled}
              onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
            />
          </div>
        </fieldset>
      </DialogPanel>

      <DialogFooter>
        <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
          {t("Cancel")}
        </DialogClose>
        <Button
          size="sm"
          disabled={
            !canOperate ||
            saving ||
            editingTaskMissing ||
            !connected ||
            !tasksQuery.data ||
            (draft.enabled && draft.scheduleMode === "webhook" && webhookDenial !== undefined)
          }
          onClick={() => void submit()}
        >
          {draft.editingId ? t("Save task") : t("Create task")}
        </Button>
      </DialogFooter>
    </>
  );
}
