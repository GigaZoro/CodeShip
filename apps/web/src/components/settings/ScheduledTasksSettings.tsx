import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  connectionMayStillAnswer,
  connectionStatusTitle,
} from "@t3tools/client-runtime/connection";
import { AsyncResult } from "effect/reactivity";
import {
  ArrowRightLeftIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  Clock3Icon,
  CopyIcon,
  CopyPlusIcon,
  FolderIcon,
  HistoryIcon,
  InboxIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useContext, useRef, useState } from "react";
import type {
  EnvironmentId,
  EnvironmentMachineKind,
  LinkedScheduledTask,
  LinkedScheduledTaskMachine,
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskNoWorkSkip,
  ScheduledTaskPlacement,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertInput,
  ScheduledTaskWebhookDeliverySummary,
  ThreadId,
} from "@t3tools/contracts";
import { MAX_RUN_CONDITION_TIMEOUT_SECONDS } from "@t3tools/contracts";
import {
  DEFAULT_WEBHOOK_PROMPT,
  emptyWebhookFilterDraft,
  parseWebhookFilterDrafts,
  removeWebhookFilterDraft,
  WEBHOOK_FILTER_OPS,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import {
  runConditionDraft,
  runConditionHelpText,
  runConditionInput,
  runConditionInvalidText,
  shownNoWorkSkip,
} from "@t3tools/client-runtime/scheduled-task-run-condition";
import {
  defaultCatchUpMissedRun,
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  MAX_SCHEDULED_TASK_GROUP_LENGTH,
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
import { formatRelativeTime, formatUpcomingTimestamp } from "../../timestampFormat";
import { useClientSettings, useEnvironmentSettings } from "../../hooks/useSettings";
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
import { supportsScheduledTaskGroups } from "../../state/scheduledTaskStats";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  pinnedTaskRunThreadId,
  resolveScheduledTaskPlacement,
  scheduledTaskPlacementOptions,
} from "@t3tools/client-runtime/scheduled-task-pins";
import {
  scheduledTaskGroupLabels,
  scheduledTaskGroupUpsertField,
  type ScheduledTaskListItem,
} from "@t3tools/client-runtime/scheduled-task-groups";
import {
  describeOneMachineLinkWarning,
  effectiveOneMachineOrder,
  groupSharedScheduledTasks,
  mergeMachineOrder,
  moveMachine,
  newestProjectMachineOrder,
  oneMachineLinkWarnings,
  projectMachineOrderSubject,
  seedMachineOrder,
  sharedProjectReference,
  sharedUpsertField,
  toggleSharedExclusion,
  visibleMachineOrder,
  type SharedScheduledTaskGroup,
} from "@t3tools/client-runtime/scheduled-task-sharing";
import {
  linkedProjectName,
  pickLinkedMachineTasks,
  type LinkedMachineTasks,
} from "@t3tools/client-runtime/linked-scheduled-tasks";
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
  copyTaskDraft,
  matchingProjectId,
  scheduleDraftErrors,
  toDateTimeLocalValue,
  webhookDeliveryLabel,
  defaultScheduledTaskProjectId,
  matchesScheduledTaskScope,
  runConditionLostOnTarget,
  scheduleFromDraft,
  scheduledTaskDefaultModel,
  taskToDraft,
  type DraftState,
  type ScheduleMode,
  type WorkspaceMode,
} from "./scheduledTasksSettings.logic";
import {
  effectivePromptSource,
  promptFileDraftProblem,
  promptFileLostOnTarget,
  promptFileReadFor,
  promptUpsertFields,
  type PromptSource,
} from "@t3tools/client-runtime/scheduled-task-prompt-file";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../ui/autocomplete";
import { Label } from "../ui/label";
import { hasScheduledTaskGroups, ScheduledTaskGroupSections } from "./ScheduledTaskGroups";
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
  promptSource: "text",
  promptFile: "",
  savedPromptFile: null,
  promptLastRead: null,
  enabled: true,
  group: "",
  savedGroup: "",
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
  runCondition: runConditionDraft(null),
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

function UpcomingTime(props: { value: string }) {
  const nowMinute = useNowMinute();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  return (
    <time dateTime={props.value}>
      {formatUpcomingTimestamp(props.value, timestampFormat, Date.parse(`${nowMinute}:00.000Z`))}
    </time>
  );
}

/** What holds or comes next for a task on its machine. */
function TaskNextRun({
  task,
}: {
  readonly task: Pick<ScheduledTask, "blockedByPolicy" | "enabled" | "schedule" | "nextRunAt">;
}) {
  if (task.blockedByPolicy !== undefined) return task.blockedByPolicy;
  if (!task.enabled) return t("Paused");
  if (task.schedule.type === "webhook") return t("Listening");
  if (!task.nextRunAt) return t("Not scheduled");
  return tx("Next run {when} ({time})", {
    when: <ScheduledRelativeLabel value={task.nextRunAt} />,
    time: <UpcomingTime value={task.nextRunAt} />,
  });
}

/** The last run, linked to its thread on the machine that ran it. */
function TaskLastRun({
  environmentId,
  task,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
}) {
  if (!task.lastRunAt || task.lastRunStatus === "running") return null;
  const label = tx("Last run {when}", { when: <ScheduledRelativeLabel value={task.lastRunAt} /> });
  // A run that failed before it had a thread leaves an older run's thread recorded.
  const threadId = task.lastRunStatus === "succeeded" ? pinnedTaskRunThreadId(task) : null;
  if (threadId === null) return <span>{label}</span>;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(scopeThreadRef(environmentId, threadId))}
      className="underline underline-offset-2 hover:text-foreground"
    >
      {label}
    </Link>
  );
}

/** The sentence for an occurrence a task's check skipped, without a tooltip of its own. */
export function NoWorkSkipSentence({ skip }: { readonly skip: ScheduledTaskNoWorkSkip }) {
  const reason = skip.reason?.trim() ?? "";
  const when = <ScheduledRelativeLabel value={skip.at} />;
  return reason === ""
    ? tx("Skipped {when}", { when })
    : tx("Skipped {when}: {reason}", { when, reason });
}

/** The occurrence a task's check skipped. There is no chat to open, so it is never a link. */
function TaskNoWorkSkip({
  task,
  className = "min-w-0 max-w-full truncate",
}: {
  readonly task: Pick<ScheduledTask, "lastNoWorkSkip" | "lastRunAt">;
  readonly className?: string;
}) {
  const skip = shownNoWorkSkip(task);
  if (skip === null) return null;
  const text = <NoWorkSkipSentence skip={skip} />;
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className={className} />}>{text}</TooltipTrigger>
      <TooltipPopup side="top">{text}</TooltipPopup>
    </Tooltip>
  );
}

function RunStatusBadge({ task }: { readonly task: Pick<ScheduledTask, "lastRunStatus"> }) {
  if (task.lastRunStatus === "never") return null;
  return (
    <Badge variant={statusVariant(task.lastRunStatus)}>{runStatusLabel(task.lastRunStatus)}</Badge>
  );
}

/** Run errors are full cause traces, so they keep two lines until asked for more. */
function RunError({ error }: { readonly error: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <span className="flex basis-full flex-col items-start gap-1">
      <span
        className={cn(
          "whitespace-pre-wrap break-words text-destructive-foreground",
          !expanded && "line-clamp-2",
        )}
      >
        {error}
      </span>
      {error.length > 160 || error.includes("\n") ? (
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? t("Show less") : t("Show full error")}
        </Button>
      ) : null}
    </span>
  );
}

function TaskWarnings({ warnings }: { readonly warnings: ReadonlyArray<string> }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="flex basis-full flex-col gap-0.5 text-warning-foreground">
      {warnings.map((warning) => (
        <li key={warning} className="flex items-start gap-1.5">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 break-words">{warning}</span>
        </li>
      ))}
    </ul>
  );
}

/** The schedule and what holds or comes next: the policy blocking it, the next run, or paused. */
export function ScheduledTaskScheduleLine(props: { task: ScheduledTask }) {
  const { task } = props;
  const schedule = scheduleLabel(task.schedule);
  if (task.blockedByPolicy !== undefined) {
    return t("{schedule} · {policy}", { schedule, policy: task.blockedByPolicy });
  }
  if (task.enabled && task.nextRunAt !== null) {
    return tx("{schedule} · next {when} ({time})", {
      schedule,
      when: <ScheduledRelativeLabel value={task.nextRunAt} />,
      time: <UpcomingTime value={task.nextRunAt} />,
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
    source?: EditorSource;
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
  const moveTargetIds = permittedEnvironments.map((entry) => entry.environmentId);
  const actions: ScheduledTaskActions = {
    onEdit: openForEdit,
    onDuplicate: creationEnvironment
      ? (environmentId, task) =>
          setEditor({
            environmentId: moveTargetIds.includes(environmentId)
              ? environmentId
              : creationEnvironment.environmentId,
            task: null,
            source: { kind: "duplicate", environmentId, task },
          })
      : undefined,
    onMove: (environmentId, task) => {
      const destination = moveTargetIds.find((id) => id !== environmentId);
      if (destination === undefined) return;
      setEditor({
        environmentId: destination,
        task: null,
        source: { kind: "move", environmentId, task },
      });
    },
    moveTargetIds,
  };
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
            actions={actions}
            onCreate={startTask}
          />
        ) : (
          <div className="space-y-8">
            {environments.map((entry) => (
              <ScheduledTaskEnvironmentSection
                key={entry.environmentId}
                environment={entry}
                taskId={linkedEnvironmentId === entry.environmentId ? target.taskId : undefined}
                actions={actions}
                onCreate={startTask}
              />
            ))}
          </div>
        )}
        <LinkedMachineTaskSections />
      </SettingsPageContainer>
      {editor ? (
        <ScheduledTaskEditorDialog
          key={`${editor.environmentId}:${editor.task?.id ?? "new"}:${editor.source?.kind ?? ""}:${editor.source?.task.id ?? ""}`}
          initialEnvironmentId={editor.environmentId}
          task={editor.task}
          source={editor.source}
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
  actions,
  onCreate,
}: {
  readonly environmentId: EnvironmentId | undefined;
  readonly taskId: ScheduledTaskId | undefined;
  readonly actions: ScheduledTaskActions;
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
  const { shared: sharedGroups, local } = groupSharedScheduledTasks(
    loaded.map((state) => ({
      environmentId: state.environment.environmentId,
      tasks: state.tasks ?? [],
    })),
  );
  const localTasksOn = (id: EnvironmentId) =>
    local.find((list) => list.environmentId === id)?.tasks ?? [];
  const populated = loaded.filter(
    (state) => localTasksOn(state.environment.environmentId).length > 0,
  );
  const holdsShared = (id: EnvironmentId) =>
    sharedGroups.some((group) => group.copies.some((copy) => copy.environmentId === id));
  // Their stored tasks show under Linked machines, which also says they are offline.
  const shownAsLinked = new Set(
    useLinkedMachineTasks().map(({ machine }) => machine.environmentId),
  );
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
      if (shownAsLinked.has(environment.environmentId)) continue;
      summaries[notConnectedLabel]!.push(
        `${label} (${connectionStatusTitle(environment.connection)})`,
      );
    } else if (error !== null) {
      failures.push({ environmentId: environment.environmentId, label, error });
    } else if (!tasks) {
      summaries[loadingLabel]!.push(label);
    } else if (
      tasks.length === 0 &&
      !holdsShared(environment.environmentId) &&
      (populated.length > 0 || sharedGroups.length > 0)
    ) {
      summaries[noTasksLabel]!.push(label);
    }
  }

  const listItems: ReadonlyArray<ScheduledTaskListItem> = [
    ...sharedGroups.map((group) => ({ kind: "shared" as const, group })),
    ...populated.flatMap(({ environment }) =>
      localTasksOn(environment.environmentId).map((task) => ({
        kind: "local" as const,
        environmentId: environment.environmentId,
        task,
      })),
    ),
  ];
  const grouped = hasScheduledTaskGroups(listItems);

  return (
    <SettingsGroup>
      {grouped ? (
        <ScheduledTaskGroupSections
          items={listItems}
          renderItem={(item) =>
            item.kind === "shared" ? (
              <SharedScheduledTaskRow group={item.group} actions={actions} />
            ) : (
              <ScheduledTaskRow
                environmentId={item.environmentId}
                task={item.task}
                actions={actions}
              />
            )
          }
        />
      ) : null}
      {!grouped && sharedGroups.length > 0 ? (
        <div className="divide-y divide-border/50">
          <p className="px-3 py-2.5 text-sm font-medium text-foreground sm:px-4">
            {t("On more than one machine")}
          </p>
          {sharedGroups.map((group) => (
            <SharedScheduledTaskRow key={group.primary.task.id} group={group} actions={actions} />
          ))}
        </div>
      ) : null}
      {(grouped ? [] : populated).map(({ environment }) => {
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
            {localTasksOn(environment.environmentId).map((task) => (
              <ScheduledTaskRow
                key={task.id}
                environmentId={environment.environmentId}
                task={task}
                actions={actions}
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
      {populated.length === 0 &&
      sharedGroups.length === 0 &&
      loaded.length > 0 &&
      loaded.length === connectedIds.length ? (
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

const linkedScheduledTasksListAtom = environmentAtomList(
  "web-linked-scheduled-tasks-list",
  (environmentId) => serverEnvironment.linkedScheduledTasksLive({ environmentId, input: {} }),
);

/**
 * Machines the connected ones link to that this app can't read live, each with the task list
 * heard most recently. Those lists outlast the machine going offline.
 */
function useLinkedMachineTasks(): ReadonlyArray<LinkedMachineTasks> {
  const { environments } = useEnvironments();
  const live = environments.filter(
    (entry) => entry.connection.phase === "connected" && entry.serverConfig !== null,
  );
  const servingIds = live.flatMap((entry) =>
    entry.serverConfig?.environment.capabilities.linkedScheduledTasks === true
      ? [entry.environmentId]
      : [],
  );
  const queries = useAtomValue(linkedScheduledTasksListAtom(environmentIdsKey(servingIds)));
  return pickLinkedMachineTasks({
    lists: servingIds.map((environmentId, index) => ({
      environmentId,
      machines: AsyncResult.getOrElse(queries[index]!, () => null)?.machines ?? [],
    })),
    readsLive: (id) => live.some((entry) => entry.environmentId === id),
  });
}

/**
 * Machines the connected ones link to that this app can't read live, with the tasks each last
 * reported. Read-only: changing a task needs a connection to its machine.
 */
function LinkedMachineTaskSections() {
  const { scope } = useSettingsScope();
  const { environments } = useEnvironments();
  const linked = useLinkedMachineTasks().filter(
    ({ machine }) =>
      scope.kind === "all" ||
      (scope.kind === "environment" && scope.environmentIds.includes(machine.environmentId)),
  );
  if (linked.length === 0) return null;
  return (
    <SettingsSection title={t("Linked machines")}>
      {linked.map(({ machine, via }) => (
        <LinkedMachineSection
          key={machine.environmentId}
          machine={machine}
          via={environments.find((entry) => entry.environmentId === via)?.label ?? via}
        />
      ))}
    </SettingsSection>
  );
}

function LinkedMachineSection({
  machine,
  via,
}: {
  readonly machine: LinkedScheduledTaskMachine;
  readonly via: string;
}) {
  // Present when this app has the machine saved but cannot reach it now.
  const environment = useEnvironment(machine.environmentId);
  const kind = resolveEnvironmentMachineKind(environment?.serverConfig ?? null);
  const offline = machine.error !== null;
  return (
    <div className="divide-y divide-border/50">
      <EnvironmentRow
        kind={kind}
        label={machine.label}
        dimmed={offline}
        subtitle={
          <>
            <span className="block">
              {t("Read-only: the tasks it last reported to {machine}.", { machine: via })}
            </span>
            {offline ? <span className="block break-words">{machine.error}</span> : null}
          </>
        }
      >
        <ConnectionStatusDot
          dotClassName={connectionPhaseDotClassName(offline ? "offline" : "connected")}
          tooltipText={offline ? t("Offline") : t("Online")}
        />
        <span className="text-xs text-muted-foreground">
          {!offline
            ? tx("Online · checked {when}", {
                when: <ScheduledRelativeLabel value={machine.checkedAt} />,
              })
            : machine.seenAt !== null
              ? tx("Offline · last seen {when}", {
                  when: <ScheduledRelativeLabel value={machine.seenAt} />,
                })
              : t("Offline · not reached yet")}
        </span>
        {environment === null ? (
          <Button size="xs" variant="outline" render={<Link to="/settings/connections" />}>
            {t("Add environment")}
          </Button>
        ) : null}
      </EnvironmentRow>
      {machine.tasks.length === 0 ? (
        <SettingsRow title={t("No scheduled tasks")} />
      ) : (
        machine.tasks.map((task) => (
          <LinkedScheduledTaskRow
            key={task.id}
            kind={kind}
            machine={machine.label}
            task={task}
            offline={offline}
          />
        ))
      )}
    </div>
  );
}

/** A task as its machine last reported it. Nothing here changes it. */
function LinkedScheduledTaskRow({
  kind,
  machine,
  task,
  offline,
}: {
  readonly kind: EnvironmentMachineKind;
  readonly machine: string;
  readonly task: LinkedScheduledTask;
  readonly offline: boolean;
}) {
  const schedule = scheduleLabel(task.schedule);
  const project = linkedProjectName(task.projectTitle);
  return (
    <SettingsRow
      title={task.title}
      description={<span className="line-clamp-2">{task.prompt}</span>}
      status={
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex min-w-0 max-w-full items-center gap-2">
            <TaskMachineLabel kind={kind} label={machine} />
            {project !== null ? <TaskProjectLabel name={project} /> : null}
          </span>
          <span>
            {/* An offline machine runs nothing, so its reported next run would mislead. */}
            {offline
              ? task.enabled
                ? schedule
                : t("{schedule} · paused", { schedule })
              : tx("{schedule} · {status}", { schedule, status: <TaskNextRun task={task} /> })}
          </span>
          <RunStatusBadge task={task} />
          {task.lastRunAt !== null && task.lastRunStatus !== "running" ? (
            <span>
              {tx("Last run {when}", { when: <ScheduledRelativeLabel value={task.lastRunAt} /> })}
            </span>
          ) : null}
          <TaskNoWorkSkip task={task} />
        </div>
      }
      control={
        <Switch
          checked={task.enabled}
          disabled
          aria-label={t("Enable {name}", { name: task.title })}
        />
      }
    />
  );
}

function TaskMachineLabel({
  kind,
  label,
}: {
  readonly kind: EnvironmentMachineKind;
  readonly label: string;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 font-medium text-foreground">
      <EnvironmentMachineIcon aria-hidden kind={kind} className="size-3.5 shrink-0" />
      <span className="sr-only">{t("Runs on {machine}", { machine: label })}</span>
      <span aria-hidden className="truncate">
        {label}
      </span>
    </span>
  );
}

function TaskProjectLabel({ name }: { readonly name: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <FolderIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="sr-only">{t("Project: {value}", { value: name })}</span>
      <span aria-hidden className="truncate">
        {name}
      </span>
    </span>
  );
}

/** Where a task runs: its machine, then the project its threads start in. */
function ScheduledTaskPlace({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const { environments } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-2">
      <TaskMachineLabel
        kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
        label={
          environment ? settingsScopeEnvironmentLabel(environment, environments) : environmentId
        }
      />
      <ScheduledTaskProject environmentId={environmentId} projectId={projectId} />
    </span>
  );
}

/** The task's project, named as the "Showing tasks for" picker names it. */
function ScheduledTaskProject({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const { groups } = useSettingsScope();
  for (const group of groups) {
    const member = group.memberProjects.find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
    );
    if (member === undefined) continue;
    return <TaskProjectLabel name={member.isScratch ? t("No project") : group.displayName} />;
  }
  return null;
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
  actions,
  onCreate,
}: {
  readonly environment: EnvironmentPresentation;
  readonly taskId?: ScheduledTaskId | undefined;
  readonly actions: ScheduledTaskActions;
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
  const listItems = (list: ReadonlyArray<ScheduledTask>): ReadonlyArray<ScheduledTaskListItem> =>
    list.map((task) => ({ kind: "local", environmentId: environment.environmentId, task }));
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
          ) : hasScheduledTaskGroups(listItems(tasks)) ? (
            <ScheduledTaskGroupSections
              items={listItems(tasks)}
              renderItem={(item) =>
                item.kind === "local" ? (
                  <ScheduledTaskRow
                    environmentId={item.environmentId}
                    task={item.task}
                    actions={actions}
                  />
                ) : null
              }
            />
          ) : (
            tasks.map((task) => (
              <ScheduledTaskRow
                key={task.id}
                environmentId={environment.environmentId}
                task={task}
                actions={actions}
              />
            ))
          )}
        </>
      )}
    </SettingsSection>
  );
}

/** What every client knows about a shared task across the machines it can reach. */
function useSharedTaskView(task: ScheduledTask) {
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
  const order =
    oneMachine && shared
      ? effectiveOneMachineOrder(
          newestProjectMachineOrder(snapshots, shared.project)?.order ?? [],
          shared.excludedEnvironmentIds,
          sharingIds,
        )
      : [];
  return {
    labelOf,
    oneMachine,
    order,
    sharingIds,
    excluded: shared?.excludedEnvironmentIds ?? [],
    holders: snapshots.flatMap((snapshot) =>
      snapshot.tasks.some((candidate) => candidate.id === task.id && candidate.shared)
        ? [snapshot.environmentId]
        : [],
    ),
    linkWarnings: oneMachineLinkWarnings(snapshots, order, Date.parse(`${nowMinute}:00.000Z`)).map(
      (warning) => describeOneMachineLinkWarning(warning, labelOf),
    ),
    notSyncedIds: [...new Set(notSynced.map((failure) => failure.environmentId))],
    /** Every failed sync of the task, or only those to one machine. */
    syncWarnings: (environmentId?: EnvironmentId) =>
      notSynced
        .filter((failure) => environmentId === undefined || failure.environmentId === environmentId)
        .map((failure) =>
          t("Not synced to {machine}: {error}", {
            machine: labelOf(failure.environmentId),
            error: failure.error,
          }),
        ),
  };
}

type SharedTaskView = ReturnType<typeof useSharedTaskView>;

function copyWarnings(view: SharedTaskView, environmentId: EnvironmentId, task: ScheduledTask) {
  const unchecked = view.oneMachine ? (task.lastOneMachineDecision?.unchecked ?? []) : [];
  return [
    ...unchecked.map((entry) =>
      t("{machine} couldn't check {other}: {reason}", {
        machine: view.labelOf(environmentId),
        other: view.labelOf(entry.environmentId),
        reason: entry.reason,
      }),
    ),
    ...(task.modelUnavailableHere
      ? [
          t("Runs the default model on {machine}: the task's own model isn't set up there.", {
            machine: view.labelOf(environmentId),
          }),
        ]
      : []),
  ];
}

function lastOneMachineDecisionLabel(
  view: SharedTaskView,
  environmentId: EnvironmentId,
  task: ScheduledTask,
) {
  const decision = view.oneMachine ? task.lastOneMachineDecision : null;
  if (!decision) return null;
  const time = new Date(decision.at).toLocaleString(getFormattingLocale());
  return decision.ranOn === null
    ? t("{machine} ran it last, at {time}", { machine: view.labelOf(environmentId), time })
    : t("Skipped {time}: {machine} ran it", { time, machine: view.labelOf(decision.ranOn) });
}

/** How the task is shared; warnings stay on the row, where they show without hovering. */
function SharedTaskBadge({
  view,
  warn,
  children,
}: {
  readonly view: SharedTaskView;
  readonly warn: boolean;
  readonly children?: ReactNode;
}) {
  const leftOut = view.excluded.map(view.labelOf);
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant={warn ? "warning" : "info"} tabIndex={0} />}>
        {view.oneMachine ? t("One machine") : t("Every machine")}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="space-y-1">
          <p>
            {view.oneMachine
              ? t(
                  "Each run happens on one machine: the first in the order that is online and finishes it.",
                )
              : t("Runs on every machine, each on its own schedule.")}
          </p>
          {view.order.length > 0 ? (
            <p>{t("Order: {machines}", { machines: view.order.map(view.labelOf).join(" → ") })}</p>
          ) : null}
          {leftOut.length > 0 ? (
            <p>{t("Not on: {machines}", { machines: leftOut.join(", ") })}</p>
          ) : null}
          {children}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function SharedTaskStatus({
  environmentId,
  task,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
}) {
  const view = useSharedTaskView(task);
  const warnings = [
    ...view.linkWarnings,
    ...copyWarnings(view, environmentId, task),
    ...view.syncWarnings(),
  ];
  const decision = lastOneMachineDecisionLabel(view, environmentId, task);
  return (
    <>
      <SharedTaskBadge view={view} warn={warnings.length > 0}>
        {decision ? <p>{decision}</p> : null}
      </SharedTaskBadge>
      <TaskWarnings warnings={warnings} />
    </>
  );
}

/** A task the editor starts from: Duplicate saves a copy; Move saves it elsewhere, then deletes this one. */
interface EditorSource {
  readonly kind: "duplicate" | "move";
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
}

interface ScheduledTaskActions {
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
  /** Undefined when no machine lets this client create a task. */
  readonly onDuplicate: ((environmentId: EnvironmentId, task: ScheduledTask) => void) | undefined;
  readonly onMove: (environmentId: EnvironmentId, task: ScheduledTask) => void;
  /** Machines this client can create a task on. */
  readonly moveTargetIds: ReadonlyArray<EnvironmentId>;
}

/**
 * A shared task's copies follow one machine's edits, so it has one place to move from: a task of
 * its own, not bound to a thread there, and without a webhook URL that would change on the way.
 */
function canMoveTask(
  actions: ScheduledTaskActions,
  environmentId: EnvironmentId,
  task: ScheduledTask,
) {
  return (
    !task.shared &&
    task.schedule.type !== "webhook" &&
    task.threadId === null &&
    actions.moveTargetIds.some((id) => id !== environmentId)
  );
}

function deleteConfirmation(task: ScheduledTask, machines: ReadonlyArray<string>) {
  if (!task.shared) return t('Delete "{name}"?\nThis cannot be undone.', { name: task.title });
  return t(
    'Delete "{name}" on every machine?\nIt\'s shared, so this deletes it on {machines} and on any other machine with a copy. To remove it from one machine only, edit it and untick that machine. This cannot be undone.',
    {
      name: task.title,
      machines: new Intl.ListFormat(getFormattingLocale(), {
        style: "long",
        type: "conjunction",
      }).format(machines),
    },
  );
}

/** Row commands, one at a time per row; a failure toasts under the action's own title. */
function useScheduledTaskCommands() {
  const [busy, setBusy] = useState(false);
  const toggle = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
  });
  const run = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run now",
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
  });
  const navigate = useNavigate();
  const failToast = (title: string, description: string) =>
    toastManager.add(stackedThreadToast({ type: "error", title, description }));
  const perform = async <A, E>(
    environmentId: EnvironmentId,
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
  const toggleEnabled = (environmentId: EnvironmentId, task: ScheduledTask) =>
    perform(
      environmentId,
      task.enabled ? t("Could not pause task") : t("Could not resume task"),
      () => toggle({ environmentId, input: { id: task.id, enabled: !task.enabled } }),
    );
  const runNow = async (environmentId: EnvironmentId, task: ScheduledTask) => {
    const ran = (
      await perform(environmentId, t("Could not run task"), () =>
        run({ environmentId, input: { id: task.id } }),
      )
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
  /** `machines` names the machines known to hold a shared task's copies. */
  const deleteTask = async (
    environmentId: EnvironmentId,
    task: ScheduledTask,
    machines: ReadonlyArray<string>,
  ) => {
    if (busy) return;
    const message = deleteConfirmation(task, machines);
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ??
      window.confirm(message.replace("\n", " "));
    if (confirmed) {
      await perform(environmentId, t("Could not delete task"), () =>
        remove({ environmentId, input: { id: task.id } }),
      );
    }
  };
  return { busy, toggleEnabled, runNow, deleteTask };
}

function ScheduledTaskRow({
  environmentId,
  task,
  actions,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly actions: ScheduledTaskActions;
}) {
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const { environments } = useEnvironments();
  const commands = useScheduledTaskCommands();
  const busy = commands.busy;
  const [deliveriesOpen, setDeliveriesOpen] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  const isWebhook = task.schedule.type === "webhook";
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const offersRunHistory =
    environment?.serverConfig?.environment.capabilities.scheduledTaskRunHistory === true;
  const setPlacement = useSetScheduledTaskPlacement();
  const sharedHolders = useAtomValue(
    sharedScheduledTaskSnapshotsAtom(
      environmentIdsKey(
        task.shared
          ? environments
              .filter(
                (entry) =>
                  entry.connection.phase === "connected" && supportsSharedScheduledTasks(entry),
              )
              .map((entry) => entry.environmentId)
          : [],
      ),
    ),
  ).flatMap((snapshot) =>
    snapshot.tasks.some((candidate) => candidate.id === task.id) ? [snapshot.environmentId] : [],
  );
  const labelOf = (id: EnvironmentId) => {
    const entry = environments.find((candidate) => candidate.environmentId === id);
    return entry ? settingsScopeEnvironmentLabel(entry, environments) : id;
  };
  return (
    <SettingsRow
      title={task.title}
      description={<span className="line-clamp-2">{task.prompt}</span>}
      status={
        <div className="flex flex-wrap items-center gap-2">
          <ScheduledTaskPlace environmentId={environmentId} projectId={task.projectId} />
          <span>
            {tx("{schedule} · {status}", {
              schedule: scheduleLabel(task.schedule),
              status: <TaskNextRun task={task} />,
            })}
          </span>
          <RunStatusBadge task={task} />
          <TaskLastRun environmentId={environmentId} task={task} />
          <TaskNoWorkSkip task={task} />
          {task.shared ? <SharedTaskStatus environmentId={environmentId} task={task} /> : null}
          {task.lastRunError ? <RunError error={task.lastRunError} /> : null}
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
            onCheckedChange={() => void commands.toggleEnabled(environmentId, task)}
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
              <MenuItem onClick={() => actions.onEdit(environmentId, task)}>
                <PencilIcon />
                {t("Edit")}
              </MenuItem>
              {actions.onDuplicate ? (
                <MenuItem onClick={() => actions.onDuplicate?.(environmentId, task)}>
                  <CopyPlusIcon />
                  {t("Duplicate")}
                </MenuItem>
              ) : null}
              {canMoveTask(actions, environmentId, task) ? (
                <MenuItem onClick={() => actions.onMove(environmentId, task)}>
                  <ArrowRightLeftIcon />
                  {t("Move to another machine")}
                </MenuItem>
              ) : null}
              {isWebhook ? (
                <MenuItem onClick={() => setDeliveriesOpen(true)}>
                  <InboxIcon />
                  {t("Deliveries")}
                </MenuItem>
              ) : (
                <MenuItem onClick={() => void commands.runNow(environmentId, task)}>
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
              <MenuItem
                variant="destructive"
                onClick={() =>
                  void commands.deleteTask(
                    environmentId,
                    task,
                    [...new Set([environmentId, ...sharedHolders])].map(labelOf),
                  )
                }
              >
                <Trash2Icon />
                {task.shared ? t("Delete on every machine") : t("Delete")}
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

/** One machine's copy of a shared task: when it runs there, how its last run went, and why not. */
function SharedTaskCopyLine({
  view,
  environmentId,
  task,
}: {
  readonly view: SharedTaskView;
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
}) {
  const environment = useEnvironment(environmentId);
  const decision = lastOneMachineDecisionLabel(view, environmentId, task);
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <EnvironmentMachineIcon
        aria-hidden
        kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
        className="size-3.5 shrink-0"
      />
      <span className="font-medium text-foreground">{view.labelOf(environmentId)}</span>
      <ScheduledTaskProject environmentId={environmentId} projectId={task.projectId} />
      <span>
        <TaskNextRun task={task} />
      </span>
      <RunStatusBadge task={task} />
      <TaskLastRun environmentId={environmentId} task={task} />
      <TaskNoWorkSkip task={task} />
      {decision ? <span>{decision}</span> : null}
      {task.lastRunError ? <RunError error={task.lastRunError} /> : null}
      <TaskWarnings
        warnings={[...copyWarnings(view, environmentId, task), ...view.syncWarnings(environmentId)]}
      />
    </li>
  );
}

/**
 * A shared task once, however many machines hold it. Edits, pausing and deleting go to the
 * newest copy and reach the others by sync; running and history are per machine.
 */
function SharedScheduledTaskRow({
  group,
  actions,
}: {
  readonly group: SharedScheduledTaskGroup;
  readonly actions: ScheduledTaskActions;
}) {
  const { environmentId, task } = group.primary;
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const { environments } = useEnvironments();
  const view = useSharedTaskView(task);
  const commands = useScheduledTaskCommands();
  const busy = commands.busy;
  const setPlacement = useSetScheduledTaskPlacement();
  const [runsOpen, setRunsOpen] = useState(false);
  const rank = (id: EnvironmentId) => {
    const index = view.order.indexOf(id);
    return index < 0 ? view.order.length : index;
  };
  const copies = view.oneMachine
    ? group.copies.toSorted((left, right) => rank(left.environmentId) - rank(right.environmentId))
    : group.copies;
  const unsynced = view.sharingIds.filter(
    (id) => !view.excluded.includes(id) && !copies.some((copy) => copy.environmentId === id),
  );
  const historyIds = copies.flatMap((copy) =>
    environments.find((entry) => entry.environmentId === copy.environmentId)?.serverConfig
      ?.environment.capabilities.scheduledTaskRunHistory === true
      ? [copy.environmentId]
      : [],
  );
  const placeable = copies.filter((copy) => supportsScheduledTaskPlacement(copy.task));
  return (
    <SettingsRow
      title={task.title}
      description={<span className="line-clamp-2">{task.prompt}</span>}
      status={
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span>
              {task.enabled
                ? scheduleLabel(task.schedule)
                : t("{schedule} · paused", { schedule: scheduleLabel(task.schedule) })}
            </span>
            <SharedTaskBadge
              view={view}
              warn={
                view.linkWarnings.length > 0 ||
                view.notSyncedIds.length > 0 ||
                copies.some((copy) => copyWarnings(view, copy.environmentId, copy.task).length > 0)
              }
            />
          </div>
          <ul aria-label={t("Machines")} className="space-y-1">
            {copies.map((copy) => (
              <SharedTaskCopyLine
                key={copy.environmentId}
                view={view}
                environmentId={copy.environmentId}
                task={copy.task}
              />
            ))}
            {unsynced.map((id) => (
              <li key={id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium text-foreground">{view.labelOf(id)}</span>
                <span>{t("Not synced yet")}</span>
                <TaskWarnings warnings={view.syncWarnings(id)} />
              </li>
            ))}
          </ul>
          <TaskWarnings
            warnings={[
              ...view.linkWarnings,
              ...view.notSyncedIds
                .filter(
                  (id) =>
                    !unsynced.includes(id) && !copies.some((copy) => copy.environmentId === id),
                )
                .flatMap((id) => view.syncWarnings(id)),
            ]}
          />
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          <Switch
            checked={task.enabled}
            disabled={busy || !canOperate}
            aria-label={t("Enable {name} on every machine", { name: task.title })}
            onCheckedChange={() => void commands.toggleEnabled(environmentId, task)}
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
              <MenuItem onClick={() => actions.onEdit(environmentId, task)}>
                <PencilIcon />
                {t("Edit")}
              </MenuItem>
              {actions.onDuplicate ? (
                <MenuItem onClick={() => actions.onDuplicate?.(environmentId, task)}>
                  <CopyPlusIcon />
                  {t("Duplicate")}
                </MenuItem>
              ) : null}
              {copies.length === 1 ? (
                <MenuItem onClick={() => void commands.runNow(environmentId, task)}>
                  <PlayIcon />
                  {t("Run now")}
                </MenuItem>
              ) : (
                <MenuSub>
                  <MenuSubTrigger>
                    <PlayIcon />
                    {t("Run now on")}
                  </MenuSubTrigger>
                  <MenuSubPopup>
                    {copies.map((copy) => (
                      <MenuItem
                        key={copy.environmentId}
                        onClick={() => void commands.runNow(copy.environmentId, copy.task)}
                      >
                        {view.labelOf(copy.environmentId)}
                      </MenuItem>
                    ))}
                  </MenuSubPopup>
                </MenuSub>
              )}
              {historyIds.length > 0 ? (
                <MenuItem onClick={() => setRunsOpen(true)}>
                  <HistoryIcon />
                  {t("Run history")}
                </MenuItem>
              ) : null}
              {placeable.length > 0 ? (
                <MenuSub>
                  <MenuSubTrigger>
                    <PinIcon />
                    {t("Show in")}
                  </MenuSubTrigger>
                  <MenuSubPopup>
                    <ScheduledTaskPlacementRadioGroup
                      task={placeable[0]!.task}
                      onChange={(placement) =>
                        void Promise.all(
                          placeable.map((copy) =>
                            setPlacement(copy.environmentId, [copy.task], placement),
                          ),
                        )
                      }
                    />
                  </MenuSubPopup>
                </MenuSub>
              ) : null}
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                onClick={() =>
                  void commands.deleteTask(
                    environmentId,
                    task,
                    [
                      ...new Set([...copies.map((copy) => copy.environmentId), ...view.holders]),
                    ].map(view.labelOf),
                  )
                }
              >
                <Trash2Icon />
                {t("Delete on every machine")}
              </MenuItem>
            </MenuPopup>
          </Menu>
          {runsOpen ? (
            <ScheduledTaskRunsDialog
              environmentId={environmentId}
              environmentIds={historyIds}
              task={task}
              onClose={() => setRunsOpen(false)}
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
          {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
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
                      : "text-sm text-destructive-foreground"
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
  source,
  onClose,
}: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly source: EditorSource | undefined;
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
          source={shown.task === null ? source : undefined}
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
  source,
  justCreated,
  saving,
  onSavingChange: setSaving,
  onEdited,
  onClose,
  onCreatedWebhook,
}: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly source: EditorSource | undefined;
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
  const moving = source?.kind === "move";
  const sourceLabel = useEnvironment(source?.environmentId ?? initialEnvironmentId)?.label;
  // A move never lands back where it started.
  const targetEnvironments = connectedEnvironments.filter(
    (entry) => !moving || entry.environmentId !== source.environmentId,
  );
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
  const deleteSource = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
  });
  const webhookDenial = managedCapabilityDenial(useManagedPolicy(environmentId), "webhookTasks");
  const projectOnTarget = (
    from: (typeof allProjects)[number] | undefined,
    candidates: typeof allProjects,
  ) =>
    (from ? matchingProjectId(from, candidates) : "") ||
    defaultScheduledTaskProjectId(candidates, scope);
  const [draft, setDraftState] = useState<DraftState>(() => {
    if (task) return taskToDraft(task);
    if (!source) {
      return { ...EMPTY_DRAFT, projectId: defaultScheduledTaskProjectId(scopedProjects, scope) };
    }
    const copy = copyTaskDraft(
      source.task,
      source.kind === "duplicate"
        ? t("{name} (copy)", { name: source.task.title })
        : source.task.title,
    );
    if (source.environmentId === initialEnvironmentId) return copy;
    // Projects and threads are per machine; the run settings carry over.
    return {
      ...copy,
      threadId: "",
      projectId: projectOnTarget(
        allProjects.find(
          (project) =>
            project.environmentId === source.environmentId && project.id === source.task.projectId,
        ),
        scopedProjects,
      ),
    };
  });
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
  const targetSupportsRunConditions =
    environment?.serverConfig?.environment.capabilities.scheduledTaskRunConditions === true;
  const offersRunCondition = targetSupportsRunConditions && draft.scheduleMode !== "webhook";
  const runConditionLost = runConditionLostOnTarget({ targetSupportsRunConditions, draft });
  const supportsPromptFiles =
    environment?.serverConfig?.environment.capabilities.scheduledTaskPromptFiles === true;
  const promptSource = effectivePromptSource({ supportsPromptFiles, draft });
  const promptFileLost = promptFileLostOnTarget({
    supportsPromptFiles,
    isWebhook: draft.scheduleMode === "webhook",
    draft,
  });
  const promptFileRead = promptFileReadFor(draft);
  const offersGroups = supportsScheduledTaskGroups(environment);
  const groupQueries = useAtomValue(
    scheduledTasksListAtom(
      environmentIdsKey(connectedEnvironments.map((entry) => entry.environmentId)),
    ),
  );
  const groupSuggestions = scheduledTaskGroupLabels(
    groupQueries.flatMap(
      (query) => AsyncResult.getOrElse(query, () => null)?.tasks.map((entry) => entry.group) ?? [],
    ),
  );
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
      promptSource === "file"
        ? {
            missing: !draft.promptFile.trim(),
            label: "promptFile",
            fieldId: "scheduled-task-prompt-file",
          }
        : { missing: !draft.prompt.trim(), label: "prompt", fieldId: "scheduled-task-prompt" },
      { missing: selection === null, label: "model", fieldId: null },
    ].filter((field) => field.missing);
    if (missing.length > 0 || selection === null) {
      const missingNames = new Set(missing.map((field) => field.label));
      const fieldName = (name: string) => missingNames.has(name);
      const parts = [
        fieldName("name") ? t("a name") : null,
        fieldName("project") ? t("a project") : null,
        fieldName("prompt") ? t("a prompt") : null,
        fieldName("promptFile") ? t("a prompt file") : null,
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
    if (promptSource === "file") {
      const problem = promptFileDraftProblem({
        promptFile: draft.promptFile,
        isWebhook: draft.scheduleMode === "webhook",
      });
      if (problem !== undefined) {
        reportFailure(t("Invalid prompt file"), problem);
        document.getElementById("scheduled-task-prompt-file")?.focus();
        return;
      }
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
    if (runConditionLost) {
      reportFailure(
        t("Check would be dropped"),
        t("{machine} cannot run checks. Remove the check or pick another machine.", {
          machine: environment?.label ?? environmentId,
        }),
      );
      return;
    }
    if (promptFileLost) {
      reportFailure(
        t("Prompt file would be dropped"),
        t(
          "{machine} cannot read prompts from files. Use the text instead or pick another machine.",
          { machine: environment?.label ?? environmentId },
        ),
      );
      return;
    }
    const runCondition = offersRunCondition ? runConditionInput(draft.runCondition) : undefined;
    if (offersRunCondition && runCondition === undefined) {
      reportFailure(t("Invalid check"), runConditionInvalidText());
      document.getElementById("scheduled-task-check-command")?.focus();
      return;
    }
    const input: ScheduledTaskUpsertInput = {
      ...(draft.editingId ? { id: draft.editingId as ScheduledTaskId, requireExisting: true } : {}),
      title: draft.title.trim(),
      ...promptUpsertFields({ supportsPromptFiles, draft }),
      enabled: draft.enabled,
      ...scheduledTaskGroupUpsertField({
        supported: offersGroups,
        group: draft.group,
        hadGroup: draft.savedGroup.trim() !== "",
      }),
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
      ...(runCondition === undefined ? {} : { runCondition }),
      // Tasks have no mode picker; a mode above the administrator's ceiling would fail every run.
      runtimeMode:
        clampManagedRuntimeMode(environment?.serverConfig?.managedPolicy, draft.runtimeMode) ??
        draft.runtimeMode,
      interactionMode: draft.interactionMode,
      ...(source?.task.placement === undefined ? {} : { placement: source.task.placement }),
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
    if (moving) {
      await finishMove();
      return;
    }
    if (task === null && result.value.task.schedule.type === "webhook") {
      onCreatedWebhook(environmentId, result.value.task);
      return;
    }
    onClose();
  };

  // The copy is saved before the original goes, so a failure leaves the task on both machines.
  const finishMove = async () => {
    if (!source) return;
    const removed = await deleteSource({
      environmentId: source.environmentId,
      input: { id: source.task.id },
    });
    const machine = sourceLabel ?? source.environmentId;
    if (removed._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Copied, but {name} is still on {machine}", {
            name: source.task.title,
            machine,
          }),
          description: isAtomCommandInterrupted(removed)
            ? t("Delete it there to finish the move.")
            : t("{error} Delete it there to finish the move.", {
                error: String(squashAtomCommandFailure(removed)),
              }),
        }),
      );
    } else {
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: t("Moved {name} to {machine}", {
            name: draft.title.trim(),
            machine: environment?.label ?? environmentId,
          }),
        }),
      );
    }
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {draft.editingId
            ? t("Edit task")
            : moving
              ? t("Move task")
              : source
                ? t("Duplicate task")
                : t("New task")}
        </DialogTitle>
        <DialogDescription>
          {moving
            ? t(
                "Saves it on the machine you pick, then deletes it from {machine}. Its run history isn't moved.",
                { machine: sourceLabel ?? source.environmentId },
              )
            : t(
                "Run a prompt automatically on an interval, at a fixed time, once at a set date, or when a webhook is called.",
              )}
        </DialogDescription>
      </DialogHeader>

      <DialogPanel>
        {/* Fieldsets default to min-width: min-content, which lets one wide control widen the form past the dialog. */}
        <fieldset disabled={saving} className="min-w-0 space-y-5">
          {!connected ? (
            <p className="text-sm text-destructive-foreground">
              {t("Reconnect this environment before saving.")}
            </p>
          ) : null}
          <Field label={t("Runs on")} htmlFor="scheduled-task-environment">
            <Select
              value={environmentId}
              disabled={task !== null || saving}
              onValueChange={(id) => {
                const next = targetEnvironments.find((entry) => entry.environmentId === id);
                if (!next) return;
                setEnvironmentId(next.environmentId);
                setDraft((current) => ({
                  ...current,
                  projectId: projectOnTarget(selectedProject, projectsOn(next.environmentId)),
                  threadId: "",
                  // A copy keeps its source's settings; a model the machine lacks falls back to its default.
                  ...(source
                    ? {}
                    : {
                        modelKey: "",
                        baseModelSelection: null,
                        baseRef: "main",
                        startFromOrigin: true,
                        existingWorktreePath: "",
                      }),
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
                {targetEnvironments.map((entry) => {
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
                  <Toggle value="this">
                    <span className="max-w-40 truncate">
                      {t("Only {machine}", {
                        machine: environment?.label ?? t("the machine it runs on"),
                      })}
                    </span>
                  </Toggle>
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
            <p className="text-sm text-destructive-foreground" role="status">
              {tasksQuery.error}
            </p>
          ) : null}
          {editingTaskMissing ? (
            <p className="text-xs text-destructive-foreground" role="status">
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

          {offersGroups ? (
            <Field label={t("Group")} htmlFor="scheduled-task-group">
              <Autocomplete
                items={groupSuggestions}
                value={draft.group}
                onValueChange={(group) => setDraft((current) => ({ ...current, group }))}
              >
                <AutocompleteInput
                  id="scheduled-task-group"
                  aria-describedby="scheduled-task-group-description"
                  maxLength={MAX_SCHEDULED_TASK_GROUP_LENGTH}
                  placeholder={t("No group")}
                  spellCheck={false}
                />
                {groupSuggestions.length > 0 ? (
                  <AutocompletePopup>
                    <AutocompleteList>
                      {(label: string) => (
                        <AutocompleteItem key={label} value={label}>
                          {label}
                        </AutocompleteItem>
                      )}
                    </AutocompleteList>
                  </AutocompletePopup>
                ) : null}
              </Autocomplete>
              <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
                <p id="scheduled-task-group-description">
                  {t("Tasks with the same group are listed and paused together.")}
                </p>
                <span className="shrink-0 tabular-nums">
                  {`${draft.group.length} / ${MAX_SCHEDULED_TASK_GROUP_LENGTH}`}
                </span>
              </div>
            </Field>
          ) : null}

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

          <div className="space-y-2">
            <Label
              htmlFor={
                promptSource === "file" ? "scheduled-task-prompt-file" : "scheduled-task-prompt"
              }
            >
              {t("Prompt")}
            </Label>
            {supportsPromptFiles ? (
              <ToggleGroup
                aria-label={t("Where the prompt comes from")}
                value={[promptSource]}
                disabled={saving}
                onValueChange={(values) => {
                  const choice = values[0] as PromptSource | undefined;
                  if (choice === undefined) return;
                  setDraft((current) => ({ ...current, promptSource: choice }));
                }}
              >
                <Toggle value="text">{t("Write it here")}</Toggle>
                <Toggle value="file" disabled={draft.scheduleMode === "webhook"}>
                  {t("Read from a file")}
                </Toggle>
              </ToggleGroup>
            ) : null}
            {supportsPromptFiles && draft.scheduleMode === "webhook" ? (
              <p className="text-sm text-muted-foreground">
                {t("A webhook task fills its prompt from each request.")}
              </p>
            ) : null}
            {promptSource === "file" ? (
              <div className="space-y-2">
                <Input
                  id="scheduled-task-prompt-file"
                  placeholder={"automations/daily.md"}
                  aria-describedby="scheduled-task-prompt-file-help"
                  value={draft.promptFile}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, promptFile: event.target.value }))
                  }
                />
                <p id="scheduled-task-prompt-file-help" className="text-sm text-muted-foreground">
                  {t(
                    "A path from the root of the project's repository. Each run reads it from the remote's default branch, so a push changes the next run.",
                  )}
                </p>
                {promptFileRead ? (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      {t("Read from {ref} at {commit} on {date}", {
                        ref: promptFileRead.ref,
                        commit: promptFileRead.commit.slice(0, 7),
                        date: new Intl.DateTimeFormat(getFormattingLocale(), {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(promptFileRead.at)),
                      })}
                    </p>
                    <Textarea
                      aria-label={t("Text it read")}
                      className="max-h-64 overflow-y-auto"
                      readOnly
                      value={draft.prompt}
                    />
                  </div>
                ) : draft.editingId && draft.savedPromptFile === draft.promptFile.trim() ? (
                  <p className="text-sm text-muted-foreground">
                    {t("Not read on this machine yet. Saving or the next run reads it.")}
                  </p>
                ) : null}
              </div>
            ) : (
              <Textarea
                id="scheduled-task-prompt"
                className="max-h-64 overflow-y-auto"
                placeholder={t("What should the agent do each time this runs?")}
                value={draft.prompt}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, prompt: event.target.value }))
                }
              />
            )}
            {promptFileLost ? (
              <Alert variant="warning">
                <TriangleAlertIcon />
                <AlertTitle>{t("Prompt file")}</AlertTitle>
                <AlertDescription>
                  {t(
                    "{machine} runs an older T3.CodeShip that cannot read prompts from files. Saving there would replace {path} with the text above.",
                    { machine: environment?.label ?? environmentId, path: draft.promptFile.trim() },
                  )}
                </AlertDescription>
                <AlertAction>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setDraft((current) => ({ ...current, promptSource: "text" }))}
                  >
                    {t("Use the text")}
                  </Button>
                </AlertAction>
              </Alert>
            ) : null}
          </div>

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
                {/* Each server reads the time in its own zone, which a remote machine may not share. */}
                <p className="text-xs text-muted-foreground">
                  {sharing
                    ? t("Each machine runs it at this time by its own clock.")
                    : t("Uses the clock on {name}.", {
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

          {offersRunCondition ? (
            <Field label={t("Check before running")} htmlFor="scheduled-task-check-command">
              <div className="space-y-2">
                <Input
                  id="scheduled-task-check-command"
                  aria-describedby="scheduled-task-check-description"
                  placeholder={"node ~/scripts/has-work.mjs"}
                  value={draft.runCondition.command}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      runCondition: { ...current.runCondition, command: event.target.value },
                    }))
                  }
                />
                <div className="flex items-center gap-2">
                  <Label htmlFor="scheduled-task-check-timeout">{t("Time limit")}</Label>
                  <Input
                    type="number"
                    id="scheduled-task-check-timeout"
                    nativeInput
                    min={1}
                    max={MAX_RUN_CONDITION_TIMEOUT_SECONDS}
                    className="w-24"
                    disabled={draft.runCondition.command.trim() === ""}
                    value={draft.runCondition.timeoutSeconds}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        runCondition: {
                          ...current.runCondition,
                          timeoutSeconds: event.target.value,
                        },
                      }))
                    }
                  />
                  <span className="text-xs text-muted-foreground">{t("seconds")}</span>
                </div>
                <p id="scheduled-task-check-description" className="text-xs text-muted-foreground">
                  {runConditionHelpText()}
                </p>
              </div>
            </Field>
          ) : null}

          {runConditionLost ? (
            <Alert variant="warning">
              <TriangleAlertIcon />
              <AlertTitle>{t("Check before running")}</AlertTitle>
              <AlertDescription>
                {t(
                  "{machine} runs an older T3.CodeShip that cannot run checks. Saving there would drop this task's check.",
                  { machine: environment?.label ?? environmentId },
                )}
              </AlertDescription>
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      runCondition: { ...current.runCondition, command: "" },
                    }))
                  }
                >
                  {t("Remove check")}
                </Button>
              </AlertAction>
            </Alert>
          ) : null}

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
          {draft.editingId ? t("Save task") : moving ? t("Move task") : t("Create task")}
        </Button>
      </DialogFooter>
    </>
  );
}
