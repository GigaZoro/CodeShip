import { getClientSettings } from "../../hooks/useSettings";
import { msg, t } from "~/i18n";
import { isListedThreadLineage, isWebhookDedupeTemplate } from "@t3tools/contracts";
import {
  EnvironmentId,
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  type ProjectId,
  type ProviderDriverKind,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskSharedRunOn,
  type ScheduledTaskSchedule,
  type ScheduledTaskThreadMode,
  type ScheduledTaskUpsertSchedule,
  scheduledTaskThreadMode,
  type ScheduledTaskWebhookSignatureScheme,
  type ModelSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
  type RepositoryKeyed,
  repositoryMatchRank,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  parseMaxDeliveryAge,
  parseWebhookFilterDrafts,
  webhookFilterDrafts,
  webhookFilterDraftsChanged,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import {
  promptFileDraft,
  type PromptFileDraft,
} from "@t3tools/client-runtime/scheduled-task-prompt-file";
import {
  liveRunLimitDraft,
  runConditionDraft,
  type RunConditionDraft,
} from "@t3tools/client-runtime/scheduled-task-run-condition";
import { scheduleTimeZoneLabel } from "@t3tools/client-runtime/scheduled-task-time-zone";
import type { TimestampFormat } from "@t3tools/contracts/settings";

import {
  resolveScheduledTaskDefaultModelSelection,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import { formatDateTimeTimestamp, formatTimeOfDay } from "../../timestampFormat";

import type { ResolvedSettingsScope } from "./settingsScope";
import { validateSettingsRouteSearch } from "./settingsScopeNavigation";

export const WEEKDAY_LABELS = [
  msg("Sun"),
  msg("Mon"),
  msg("Tue"),
  msg("Wed"),
  msg("Thu"),
  msg("Fri"),
  msg("Sat"),
] as const;

export function scheduleLabel(
  schedule: ScheduledTaskSchedule,
  timestampFormat: TimestampFormat = getClientSettings().timestampFormat,
  timeZone?: string,
  runAt?: string | null,
): string {
  if (schedule.type === "webhook") return t("On webhook");
  if (schedule.type === "once") {
    return t("Once, {time}", { time: formatDateTimeTimestamp(schedule.runAt, timestampFormat) });
  }
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
  const time = formatTimeOfDay(schedule.timeOfDay, timestampFormat);
  const zone = scheduleTimeZoneLabel(timeZone, runAt);
  const label = t("{days} at {time}", { days, time });
  return zone === undefined ? label : `${label} ${zone}`;
}

export function matchesScheduledTaskScope(
  scope: ResolvedSettingsScope,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): boolean {
  if (scope.kind === "unavailable" || !scope.environmentIds.includes(environmentId)) return false;
  if (scope.kind === "project" || scope.kind === "checkout") {
    return scope.members.some(
      (member) => member.environmentId === environmentId && member.id === projectId,
    );
  }
  return true;
}

/**
 * The automations a thread shows: those bound to it, and those whose runs started it or sent it a
 * prompt. A task that starts a fresh thread each run names only its newest one, so the loaded
 * prompts find it in older threads.
 */
export function threadScheduledTasks(
  tasks: ReadonlyArray<ScheduledTask>,
  threadId: ThreadId,
  turnItems: ReadonlyArray<{
    readonly type: string;
    readonly scheduledTaskId?: ScheduledTaskId | undefined;
  }>,
): ReadonlyArray<ScheduledTask> {
  const promptedBy = new Set(
    turnItems.flatMap((item) =>
      item.type === "user_message" && item.scheduledTaskId !== undefined
        ? [item.scheduledTaskId]
        : [],
    ),
  );
  return tasks.filter(
    (task) =>
      task.threadId === threadId || task.lastRunThreadId === threadId || promptedBy.has(task.id),
  );
}

export function validateScheduledTasksSearch(raw: Record<string, unknown>) {
  return {
    ...validateSettingsRouteSearch(raw),
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.taskId === "string" && raw.taskId.trim()
      ? { taskId: ScheduledTaskId.make(raw.taskId) }
      : {}),
  };
}

export type ScheduleMode = "fixed" | "once" | "interval" | "webhook";
export type WorkspaceMode = "root" | "worktree" | "existing_worktree";

export interface DraftState extends PromptFileDraft {
  readonly editingId: string | null;
  readonly title: string;
  readonly description: string;
  readonly savedDescription: string;
  readonly prompt: string;
  readonly enabled: boolean;
  /** Free text; empty means no group. */
  readonly group: string;
  /** The group the task had when the form opened, so clearing it can be told from never setting one. */
  readonly savedGroup: string;
  readonly scheduleMode: ScheduleMode;
  readonly intervalMinutes: string;
  readonly timeOfDay: string;
  /** Local date and time as a `datetime-local` input value, such as 2026-11-02T15:00. */
  readonly runAt: string;
  /** The stored ISO run time, sent back unchanged when the field was not edited. */
  readonly savedRunAt: string;
  readonly weekdays: ReadonlySet<number>;
  readonly projectId: string;
  readonly threadId: string;
  /** The thread the form opened with, so a save can tell a cleared destination from an unbound one. */
  readonly savedThreadId: string;
  readonly threadMode: ScheduledTaskThreadMode;
  readonly workspaceMode: WorkspaceMode;
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  readonly existingWorktreePath: string;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** Runs the scheduled tasks default model instead of the one picked here. */
  readonly followsDefaultModel: boolean;
  /** Null follows the schedule's default until the user picks. */
  readonly catchUpMissedRun: boolean | null;
  /** An empty command means the task has no run condition. */
  readonly runCondition: RunConditionDraft;
  readonly delegateProviders: ReadonlyArray<ProviderDriverKind>;
  readonly maxLiveRuns: string;
  /** Kept on every machine and synced. Exclusions of machines not connected right now stay stored. */
  readonly shared: boolean;
  readonly sharedExcludedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly sharedRunOn: ScheduledTaskSharedRunOn;
  /** The project's machine order as edited here; null until the user moves a machine. */
  readonly sharedMachineOrder: ReadonlyArray<EnvironmentId> | null;
  readonly signatureEnabled: boolean;
  readonly signatureScheme: ScheduledTaskWebhookSignatureScheme;
  readonly signatureHeader: string;
  readonly signatureEncoding: "hex" | "base64";
  readonly signaturePrefix: string;
  /** Write-only: empty keeps the secret already stored on the server. */
  readonly signatureSecret: string;
  readonly maxDeliveryAgeMinutes: string;
  readonly replayKey: string;
  readonly coalesceKey: string;
  readonly coalesceWindowSeconds: string;
  readonly filters: ReadonlyArray<WebhookFilterDraft>;
  /** The filter rows the form opened with. */
  readonly savedFilters: ReadonlyArray<WebhookFilterDraft>;
}

/**
 * The target cannot store a check this draft carries, so saving there would silently drop it.
 * An unknown target (`null`: its config has not arrived) is not an older one, so it gets no verdict.
 */
export function runConditionLostOnTarget(input: {
  readonly targetSupportsRunConditions: boolean | null;
  readonly draft: Pick<DraftState, "scheduleMode" | "runCondition">;
}): boolean {
  return (
    input.targetSupportsRunConditions === false &&
    input.draft.scheduleMode !== "webhook" &&
    input.draft.runCondition.command.trim() !== ""
  );
}

export const WEBHOOK_SIGNATURE_DEFAULTS = {
  signatureScheme: "hmac-sha256",
  signatureHeader: "x-hub-signature-256",
  signatureEncoding: "hex",
  signaturePrefix: "sha256=",
} as const;

/** Formats a date as a `datetime-local` input value in the browser's time zone. */
export function toDateTimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function scheduleDraftErrors(draft: DraftState) {
  if (draft.scheduleMode === "once") {
    const runAt = new Date(draft.runAt);
    if (Number.isNaN(runAt.getTime()))
      return [{ title: t("Invalid run time"), description: t("Pick a date and time.") }];
    // A time skipped by a daylight saving change parses to a different clock time.
    if (toDateTimeLocalValue(runAt) !== draft.runAt)
      return [
        {
          title: t("Invalid run time"),
          description: t("That time does not exist in your time zone."),
        },
      ];
    return [];
  }
  if (draft.scheduleMode === "fixed" && !draft.timeOfDay)
    return [{ title: t("Invalid run time"), description: t("Pick a time.") }];
  if (draft.scheduleMode !== "webhook") return [];
  if (parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes) === undefined)
    return [
      {
        title: t("Invalid age limit"),
        description: t("Enter whole minutes from 1 to {max}, or leave it blank.", {
          max: MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
        }),
      },
    ];
  const errors: Array<{ title: string; description: string }> = [];
  for (const [description, value] of [
    [t("Duplicate request key must contain a valid request placeholder."), draft.replayKey],
    [t("Coalesce key must contain a valid request placeholder."), draft.coalesceKey],
  ] as const) {
    if (value.trim() && !isWebhookDedupeTemplate(value.trim()))
      errors.push({ title: t("Invalid webhook settings"), description });
  }
  const window = draft.coalesceWindowSeconds.trim();
  if (window && (!Number.isInteger(Number(window)) || Number(window) < 10 || Number(window) > 3600))
    errors.push({
      title: t("Invalid webhook settings"),
      description: t("Coalesce window must be whole seconds from 10 to 3600."),
    });
  return errors;
}

export function webhookDeliveryLabel(delivery: {
  readonly outcome: string;
  readonly pendingWindow?: boolean | undefined;
}) {
  if (delivery.outcome === "accepted")
    return delivery.pendingWindow ? t("Opened window") : t("Ran");
  const labels: Record<string, string> = {
    dispatch_failed: t("Run failed"),
    duplicate: t("Duplicate"),
    coalesced: t("Coalesced"),
    filtered: t("Filtered"),
    rejected_signature: t("Bad signature"),
    disabled: t("Task paused"),
    rate_limited: t("Rate limited"),
    expired: t("Too old"),
  };
  return labels[delivery.outcome] ?? delivery.outcome.replaceAll("_", " ");
}

export function scheduleFromDraft(draft: DraftState): ScheduledTaskUpsertSchedule | null {
  if (scheduleDraftErrors(draft).length > 0) return null;
  if (draft.scheduleMode === "once") {
    const saved = draft.savedRunAt ? new Date(draft.savedRunAt) : null;
    if (saved !== null && toDateTimeLocalValue(saved) === draft.runAt)
      return { type: "once", runAt: draft.savedRunAt };
    // A `datetime-local` value has no offset. In an hour that repeats when clocks go
    // back, keep the saved time's offset; otherwise Date reads it as local time.
    const withSavedOffset =
      saved === null
        ? null
        : new Date(Date.parse(`${draft.runAt}Z`) + saved.getTimezoneOffset() * 60_000);
    return {
      type: "once",
      runAt:
        withSavedOffset !== null && toDateTimeLocalValue(withSavedOffset) === draft.runAt
          ? withSavedOffset.toISOString()
          : new Date(draft.runAt).toISOString(),
    };
  }
  if (draft.scheduleMode === "webhook") {
    const maxDeliveryAgeMinutes = parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes);
    const replayKey = draft.replayKey.trim();
    const coalesceKey = draft.coalesceKey.trim();
    const coalesceWindowSeconds = draft.coalesceWindowSeconds.trim()
      ? Number(draft.coalesceWindowSeconds)
      : undefined;
    if (maxDeliveryAgeMinutes === undefined) return null;
    const parsedFilters = parseWebhookFilterDrafts(draft.filters);
    if (!("filters" in parsedFilters)) return null;
    const secret = draft.signatureSecret.trim();
    return {
      type: "webhook",
      signature: !draft.signatureEnabled
        ? null
        : draft.signatureScheme === "standard-webhooks"
          ? { scheme: "standard-webhooks", ...(secret ? { secret } : {}) }
          : {
              header: draft.signatureHeader.trim(),
              encoding: draft.signatureEncoding,
              prefix: draft.signaturePrefix,
              ...(secret ? { secret } : {}),
            },
      maxDeliveryAgeMinutes,
      ...(replayKey || coalesceKey || coalesceWindowSeconds !== undefined
        ? {
            dedupe: {
              ...(replayKey ? { replayKey } : {}),
              ...(coalesceKey ? { coalesceKey } : {}),
              ...(coalesceWindowSeconds === undefined ? {} : { coalesceWindowSeconds }),
            },
          }
        : { dedupe: {} }),
      // Only edited filters are sent; the server keeps the stored ones otherwise.
      ...(webhookFilterDraftsChanged(draft.savedFilters, draft.filters)
        ? { filters: parsedFilters.filters }
        : {}),
    };
  }
  if (draft.scheduleMode === "interval") {
    const everyMs = Math.round(Number(draft.intervalMinutes) * 60_000);
    return { type: "interval", everyMs };
  }
  const selectedEveryDay = draft.weekdays.size === 0 || draft.weekdays.size === 7;
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay,
    ...(selectedEveryDay ? {} : { weekdays: [...draft.weekdays].toSorted() }),
  };
}

export function taskToDraft(task: ScheduledTask): DraftState {
  const schedule = task.schedule;
  const filters = webhookFilterDrafts(schedule.type === "webhook" ? schedule.filters : undefined);
  const weekdays =
    schedule.type === "fixed_time" && schedule.weekdays && schedule.weekdays.length > 0
      ? new Set(schedule.weekdays)
      : new Set([0, 1, 2, 3, 4, 5, 6]);
  return {
    editingId: task.id,
    title: task.title,
    description: task.description ?? "",
    savedDescription: task.description ?? "",
    prompt: task.prompt,
    ...promptFileDraft(task),
    enabled: task.enabled,
    group: task.group ?? "",
    savedGroup: task.group ?? "",
    scheduleMode: schedule.type === "fixed_time" ? "fixed" : schedule.type,
    intervalMinutes:
      schedule.type === "interval" ? String(Math.max(1, schedule.everyMs / 60_000)) : "15",
    // A time input shows nothing for an unpadded hour such as 9:05, which agents may save.
    timeOfDay: schedule.type === "fixed_time" ? schedule.timeOfDay.padStart(5, "0") : "09:00",
    runAt: schedule.type === "once" ? toDateTimeLocalValue(new Date(schedule.runAt)) : "",
    savedRunAt: schedule.type === "once" ? schedule.runAt : "",
    weekdays,
    projectId: task.projectId,
    threadId: task.threadId ?? "",
    savedThreadId: task.threadId ?? "",
    threadMode: scheduledTaskThreadMode(task),
    workspaceMode: task.workspaceStrategy.type,
    baseRef: task.workspaceStrategy.type === "worktree" ? task.workspaceStrategy.baseRef : "",
    startFromOrigin:
      task.workspaceStrategy.type === "worktree"
        ? (task.workspaceStrategy.startFromOrigin ?? false)
        : true,
    existingWorktreePath:
      task.workspaceStrategy.type === "existing_worktree"
        ? task.workspaceStrategy.worktreePath
        : "",
    modelSelection: task.modelSelection,
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
    followsDefaultModel: task.followsDefaultModel === true,
    catchUpMissedRun: task.catchUpMissedRun ?? null,
    runCondition: runConditionDraft(task),
    delegateProviders: task.delegateProviders ?? [],
    maxLiveRuns: liveRunLimitDraft(task),
    shared: task.shared != null,
    sharedExcludedEnvironmentIds: task.shared?.excludedEnvironmentIds ?? [],
    sharedRunOn: task.shared?.runOn ?? "every",
    sharedMachineOrder: null,
    ...(schedule.type !== "webhook" || schedule.signature === null
      ? { signatureEnabled: false, ...WEBHOOK_SIGNATURE_DEFAULTS }
      : "scheme" in schedule.signature
        ? {
            ...WEBHOOK_SIGNATURE_DEFAULTS,
            signatureEnabled: true,
            signatureScheme: schedule.signature.scheme,
          }
        : {
            signatureEnabled: true,
            signatureScheme: "hmac-sha256",
            signatureHeader: schedule.signature.header,
            signatureEncoding: schedule.signature.encoding,
            signaturePrefix: schedule.signature.prefix,
          }),
    signatureSecret: "",
    replayKey: schedule.type === "webhook" ? (schedule.dedupe?.replayKey ?? "") : "",
    coalesceKey: schedule.type === "webhook" ? (schedule.dedupe?.coalesceKey ?? "") : "",
    coalesceWindowSeconds:
      schedule.type === "webhook" && schedule.dedupe?.coalesceWindowSeconds !== undefined
        ? String(schedule.dedupe.coalesceWindowSeconds)
        : "",
    maxDeliveryAgeMinutes:
      schedule.type === "webhook" && schedule.maxDeliveryAgeMinutes != null
        ? String(schedule.maxDeliveryAgeMinutes)
        : "",
    filters,
    savedFilters: filters,
  };
}

/** A new task's draft from an existing one. The new task stores nothing yet, so every field is sent. */
export function copyTaskDraft(task: ScheduledTask, title: string): DraftState {
  return {
    ...taskToDraft(task),
    editingId: null,
    title,
    savedDescription: "",
    savedFilters: [],
    savedPromptFile: null,
    promptLastRead: null,
    savedGroup: "",
  };
}

/**
 * Projects are per machine: another machine's copy has the same repository, its origin before its
 * upstream, else the same name.
 */
export function matchingProjectId(
  source: {
    readonly title: string;
    readonly repositoryIdentity?: RepositoryKeyed | null | undefined;
  },
  candidates: ReadonlyArray<{
    readonly id: ProjectId;
    readonly title: string;
    readonly repositoryIdentity?: RepositoryKeyed | null | undefined;
    readonly archivedAt?: string | null | undefined;
  }>,
): ProjectId | "" {
  const open = candidates.filter((project) => project.archivedAt == null);
  const identity = source.repositoryIdentity;
  let closest: { readonly id: ProjectId; readonly rank: number } | undefined;
  for (const project of open) {
    const rank = identity ? repositoryMatchRank(identity, project.repositoryIdentity) : -1;
    if (rank !== -1 && (closest === undefined || rank < closest.rank)) {
      closest = { id: project.id, rank };
    }
  }
  return closest?.id ?? open.find((project) => project.title === source.title)?.id ?? "";
}

export function moveDraftToThread(
  draft: DraftState,
  thread: { readonly id: ThreadId; readonly projectId: ProjectId },
): DraftState {
  return {
    ...draft,
    threadId: thread.id,
    projectId: thread.projectId,
    threadMode: draft.threadMode === "new_thread" ? "continue" : draft.threadMode,
  };
}

/** Leaves the thread but keeps the mode. Matches MCP: new threads stay out of the shared checkout. */
export function unbindDraftFromThread(draft: DraftState): DraftState {
  if (!draft.threadId) return draft;
  return {
    ...draft,
    threadId: "",
    ...(draft.workspaceMode === "root"
      ? { workspaceMode: "worktree" as const, startFromOrigin: true }
      : {}),
  };
}

export function changeDraftProject(draft: DraftState, projectId: string): DraftState {
  if (projectId === draft.projectId) return draft;
  return { ...unbindDraftFromThread(draft), projectId };
}

/** Threads a task can move to. The current one is left out; the picker always shows it. */
export function scheduledTaskDestinationThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  target: {
    readonly environmentId: EnvironmentId;
    readonly projectId: string;
    readonly currentThreadId: ThreadId | null;
    readonly query: string;
  },
): ReadonlyArray<EnvironmentThreadShell> {
  const search = target.query.trim().toLocaleLowerCase();
  return threads
    .filter(
      (thread) =>
        thread.environmentId === target.environmentId &&
        thread.projectId === target.projectId &&
        thread.id !== target.currentThreadId &&
        thread.archivedAt === null &&
        isListedThreadLineage(thread.lineage) &&
        thread.title.toLocaleLowerCase().includes(search),
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function scheduledTaskDefaultModel(
  settings: ServerSettings,
  project: (LegacyProjectSettingsFields & { readonly id: ProjectId }) | null,
  entries: readonly ProviderInstanceEntry[],
  inherited: ModelSelection | null,
): ModelSelection | null {
  const configured =
    resolveScheduledTaskDefaultModelSelection(settings, project?.id ?? null, project) ?? inherited;
  if (configured) return configured;
  const available = entries.filter(isProviderInstancePickerReady);
  const models = available.flatMap((entry) =>
    entry.models
      .filter((model) => !model.isLegacy)
      .map((model) => ({ instanceId: entry.instanceId, model })),
  );
  const fallback = models.find(({ model }) => model.isDefault) ?? models[0];
  return fallback ? { instanceId: fallback.instanceId, model: fallback.model.slug } : null;
}

/**
 * A new task's project: a pinned open project, then any open one. An archived
 * project only when Settings is scoped to it, so that scope can still save.
 */
export function defaultScheduledTaskProjectId<
  TProject extends {
    readonly id: ProjectId;
    readonly pinnedAt?: string | null | undefined;
    readonly archivedAt?: string | null | undefined;
  },
>(scopedProjects: ReadonlyArray<TProject>, scope: ResolvedSettingsScope): ProjectId | "" {
  const open = scopedProjects.filter((project) => project.archivedAt == null);
  const scopedToProject = scope.kind === "project" || scope.kind === "checkout";
  return (
    (
      open.find((project) => project.pinnedAt != null) ??
      open[0] ??
      (scopedToProject ? scopedProjects[0] : undefined)
    )?.id ?? ""
  );
}
