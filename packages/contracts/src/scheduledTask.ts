import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  ForwardCompatibleArray,
  IsoDateTime,
  ProjectId,
  ScheduledTaskId,
  SecretRef,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

const TimeOfDay = TrimmedNonEmptyString.check(
  Schema.isPattern(/^([01]?\d|2[0-3]):([0-5]\d)$/),
).annotate({ description: "Local time as HH:MM, such as 09:30." });

export const ScheduledTaskPlacement = Schema.Literals(["none", "chat", "pinned"]);
export type ScheduledTaskPlacement = typeof ScheduledTaskPlacement.Type;

export const MIN_SCHEDULED_TASK_INTERVAL_MS = 60_000;

const ScheduledTaskIntervalMs = Schema.Int.check(Schema.isGreaterThan(0));

const ScheduledTaskIntervalSchedule = Schema.Struct({
  type: Schema.Literal("interval"),
  everyMs: ScheduledTaskIntervalMs,
});

const ScheduledTaskFixedTimeSchedule = Schema.Struct({
  type: Schema.Literal("fixed_time"),
  timeOfDay: TimeOfDay,
  weekdays: Schema.optional(
    Schema.Array(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })).annotate({
        description: "Weekday. 0 is Sunday, 6 is Saturday.",
      }),
    ).annotate({
      description: "Default: every day.",
    }),
  ),
});

const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const YEAR_0000 = Date.parse("0000-01-01T00:00:00Z");
const YEAR_10000 = Date.parse("+010000-01-01T00:00:00Z");

/** Date.parse rolls impossible days like Feb 30 into the next month, so check the day too. */
function isIsoWithOffset(value: string): boolean {
  const match = ISO_WITH_OFFSET.exec(value);
  // The server stores UTC, which must stay a four-digit year to decode again.
  const time = Date.parse(value);
  if (!match || !(time >= YEAR_0000 && time < YEAR_10000)) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return days !== undefined && day >= 1 && day <= days;
}

// Checked by filter, not pattern, to keep the MCP tool schema small.
const ScheduledTaskOnceSchedule = Schema.Struct({
  type: Schema.Literal("once"),
  runAt: TrimmedNonEmptyString.check(
    Schema.makeFilter(
      (value) => isIsoWithOffset(value) || "Expected an ISO date and time with an offset.",
    ),
  ),
});

const ScheduledTaskWebhookSignatureFields = {
  header: TrimmedNonEmptyString.annotate({
    description: "Header with the signature, such as x-hub-signature-256.",
  }),
  encoding: Schema.Literals(["hex", "base64"]),
  prefix: Schema.String.annotate({
    description: "Text before the digest, such as 'sha256='. Empty for none.",
  }),
};

export const ScheduledTaskWebhookSignature = Schema.Struct(
  ScheduledTaskWebhookSignatureFields,
).annotate({ description: "HMAC-SHA256 check on the raw body." });
export type ScheduledTaskWebhookSignature = typeof ScheduledTaskWebhookSignature.Type;

/** Matches how long the relay holds a request for an offline environment. */
export const MAX_WEBHOOK_DELIVERY_AGE_MINUTES = 24 * 60;

const WebhookMaxDeliveryAgeMinutes = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_WEBHOOK_DELIVERY_AGE_MINUTES }),
).annotate({
  description: "Skip requests held offline over this many minutes. Omit to run all.",
});

export function isWebhookDedupeTemplate(template: string): boolean {
  const placeholders = /\{\{\s*(?:(?:body|headers|query)(?:\.[^{}.\s]+)*|request)\s*\}\}/g;
  const matches = [...template.matchAll(placeholders)];
  const remainder = template.replace(placeholders, "");
  return matches.length > 0 && !remainder.includes("{{") && !remainder.includes("}}");
}

const WebhookDedupeTemplate = Schema.String.check(Schema.makeFilter(isWebhookDedupeTemplate));

const ScheduledTaskWebhookDedupe = Schema.Struct({
  replayKey: Schema.optional(WebhookDedupeTemplate),
  coalesceKey: Schema.optional(WebhookDedupeTemplate),
  coalesceWindowSeconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 3600 })),
  ),
}).annotate({
  description: "Replay and coalesce key templates. Window in seconds, default 120.",
});

export const MAX_WEBHOOK_FILTERS = 16;

const WebhookFilterPath = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(body|headers|query)(\.|$)/),
);

/**
 * Forms edit an `in` list as comma-separated text, so a value that has no
 * comma and no surrounding whitespace survives that round trip unchanged.
 */
const WebhookFilterListValue = Schema.String.check(
  Schema.isPattern(/^[^,\s](?:[^,]*[^,\s])?$/),
).annotate({ description: "Non-empty, without commas or surrounding whitespace." });

export const ScheduledTaskWebhookFilter = Schema.Union([
  Schema.Struct({
    path: WebhookFilterPath,
    op: Schema.Literals(["equals", "notEquals", "startsWith"]),
    value: Schema.String,
  }),
  Schema.Struct({
    path: WebhookFilterPath,
    op: Schema.Literal("in"),
    value: Schema.Array(WebhookFilterListValue).check(Schema.isMinLength(1)),
  }),
  Schema.Struct({ path: WebhookFilterPath, op: Schema.Literal("exists") }),
]).annotate({
  description:
    "Path: `headers.x-event` or `body.action`. String compare. Objects pass only 'exists'. A `[]` segment matches any array item. `notEquals` passes only if no item equals.",
});
export type ScheduledTaskWebhookFilter = typeof ScheduledTaskWebhookFilter.Type;
export type ScheduledTaskWebhookFilterOp = ScheduledTaskWebhookFilter["op"];

const ScheduledTaskWebhookFilters = Schema.Array(ScheduledTaskWebhookFilter)
  .check(Schema.isMaxLength(MAX_WEBHOOK_FILTERS))
  .annotate({
    description: "All must match. Max 16. Omitted: keep stored. [] clears.",
  });

const ScheduledTaskWebhookSchedule = Schema.Struct({
  type: Schema.Literal("webhook"),
  signature: Schema.NullOr(ScheduledTaskWebhookSignature),
  maxDeliveryAgeMinutes: Schema.optional(Schema.NullOr(WebhookMaxDeliveryAgeMinutes)),
  dedupe: Schema.optional(ScheduledTaskWebhookDedupe),
  filters: Schema.optional(ScheduledTaskWebhookFilters),
}).annotate({
  description: "Run on each webhook request.",
});

const ScheduledTaskUpsertWebhookSchedule = Schema.Struct({
  type: Schema.Literal("webhook"),
  signature: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        ...ScheduledTaskWebhookSignatureFields,
        secret: Schema.optional(TrimmedNonEmptyString).annotate({
          description: "Default: stored secret.",
        }),
        secretRef: Schema.optional(SecretRef).annotate({
          description: "From `request_secret`. Instead of `secret`. Spent by this save.",
        }),
      }),
    ),
  ).annotate({
    description: "Omit for URL token only.",
  }),
  maxDeliveryAgeMinutes: Schema.optional(Schema.NullOr(WebhookMaxDeliveryAgeMinutes)),
  dedupe: Schema.optional(ScheduledTaskWebhookDedupe),
  filters: Schema.optional(ScheduledTaskWebhookFilters),
}).annotate({
  description:
    "Run per webhook request. Prompt can use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}}, {{request}}.",
});

/** Accept legacy sub-minute schedules so users can still manage them. */
export const ScheduledTaskSchedule = Schema.Union([
  ScheduledTaskIntervalSchedule,
  ScheduledTaskFixedTimeSchedule,
  ScheduledTaskOnceSchedule,
  ScheduledTaskWebhookSchedule,
]);
export type ScheduledTaskSchedule = typeof ScheduledTaskSchedule.Type;

export const ScheduledTaskUpsertSchedule = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("interval"),
    everyMs: ScheduledTaskIntervalMs.check(
      Schema.isGreaterThanOrEqualTo(MIN_SCHEDULED_TASK_INTERVAL_MS),
    ).annotate({
      description: "Min 60000.",
    }),
  }),
  ScheduledTaskFixedTimeSchedule,
  ScheduledTaskOnceSchedule,
  ScheduledTaskUpsertWebhookSchedule,
]);
export type ScheduledTaskUpsertSchedule = typeof ScheduledTaskUpsertSchedule.Type;

export const ScheduledTaskRunStatus = Schema.Literals(["never", "running", "succeeded", "failed"]);
export type ScheduledTaskRunStatus = typeof ScheduledTaskRunStatus.Type;

/** A daily fixed-time task catches up a run it missed while the app was off, unless set otherwise. */
export function defaultCatchUpMissedRun(schedule: ScheduledTaskSchedule): boolean {
  if (schedule.type !== "fixed_time") return false;
  const weekdays = new Set(schedule.weekdays ?? []);
  return weekdays.size === 0 || weekdays.size === 7;
}

export const ScheduledTaskRunTrigger = Schema.Literals([
  "scheduled",
  "catch_up",
  "manual",
  "webhook",
]);
export type ScheduledTaskRunTrigger = typeof ScheduledTaskRunTrigger.Type;

export const ScheduledTaskRunOutcome = Schema.Literals([
  "running",
  "succeeded",
  "failed",
  "skipped",
]);
export type ScheduledTaskRunOutcome = typeof ScheduledTaskRunOutcome.Type;

/**
 * `missed`: the app was off or asleep at the time and catching up is off.
 * `next_run_sooner`: it was missed, and the next run is nearer than the missed one.
 * `ran_elsewhere`: a one-machine task another machine ran.
 * `no_work`: the task's run condition found nothing to do.
 */
export const ScheduledTaskRunSkipReason = Schema.Literals([
  "missed",
  "next_run_sooner",
  "ran_elsewhere",
  "no_work",
]);
export type ScheduledTaskRunSkipReason = typeof ScheduledTaskRunSkipReason.Type;

export const DEFAULT_RUN_CONDITION_TIMEOUT_SECONDS = 60;
export const MAX_RUN_CONDITION_TIMEOUT_SECONDS = 600;
export const MAX_RUN_CONDITION_COMMAND_LENGTH = 2000;
/** The exit code of a run condition that found nothing to do. Zero starts the chat. */
export const RUN_CONDITION_SKIP_EXIT_CODE = 10;

const RunConditionCommand = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_RUN_CONDITION_COMMAND_LENGTH),
);
const RunConditionTimeoutSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_RUN_CONDITION_TIMEOUT_SECONDS }),
);

/**
 * A command the server runs before a scheduled occurrence starts a chat, in the project's folder
 * on the machine that would run it. It is one program with arguments and no shell, so the same
 * text works on every system; a word that starts with `~/` is under the home folder.
 */
export const ScheduledTaskRunCondition = Schema.Struct({
  command: RunConditionCommand,
  timeoutSeconds: RunConditionTimeoutSeconds,
});
export type ScheduledTaskRunCondition = typeof ScheduledTaskRunCondition.Type;

/** A run condition as a save sends it: the timeout defaults to 60 seconds. */
export const ScheduledTaskRunConditionInput = Schema.Struct({
  command: RunConditionCommand,
  timeoutSeconds: Schema.optional(RunConditionTimeoutSeconds),
});
export type ScheduledTaskRunConditionInput = typeof ScheduledTaskRunConditionInput.Type;

/** `run`: it found work. `skip`: it found none, so nothing started. `failed`: it broke, so the chat started anyway. */
export const ScheduledTaskRunCheckOutcome = Schema.Literals(["run", "skip", "failed"]);
export type ScheduledTaskRunCheckOutcome = typeof ScheduledTaskRunCheckOutcome.Type;

/**
 * `exit_code`: neither 0 nor 10. `timeout`: no answer in time. `not_started`: the program could
 * not start. `invalid_command`: the text could not be read as a command. `policy`: a managed
 * policy forbids running commands without approval.
 */
export const ScheduledTaskRunCheckFailure = Schema.Literals([
  "exit_code",
  "timeout",
  "not_started",
  "invalid_command",
  "policy",
]);
export type ScheduledTaskRunCheckFailure = typeof ScheduledTaskRunCheckFailure.Type;

/** What a task's run condition answered for one occurrence. */
export const ScheduledTaskRunCheck = Schema.Struct({
  // Any string, so a value added later doesn't break a client's whole list.
  outcome: Schema.Union([ScheduledTaskRunCheckOutcome, Schema.String]),
  failure: Schema.NullOr(Schema.Union([ScheduledTaskRunCheckFailure, Schema.String])),
  exitCode: Schema.NullOr(Schema.Int),
  /** From the command's output: its JSON `reason`, else its last line. Why, for one that could not start. */
  detail: Schema.NullOr(Schema.String),
});
export type ScheduledTaskRunCheck = typeof ScheduledTaskRunCheck.Type;

/** One time a task fired, including fires that failed before a thread existed or were skipped. */
export const ScheduledTaskRunRecord = Schema.Struct({
  id: TrimmedNonEmptyString,
  // Any string, so a value added later doesn't break a client's whole list.
  trigger: Schema.Union([ScheduledTaskRunTrigger, Schema.String]),
  /** The scheduled time this run served; null for runs started by hand or by a webhook. */
  scheduledFor: Schema.NullOr(IsoDateTime),
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  outcome: Schema.Union([ScheduledTaskRunOutcome, Schema.String]),
  threadId: Schema.NullOr(ThreadId),
  error: Schema.NullOr(Schema.String),
  skipReason: Schema.NullOr(Schema.Union([ScheduledTaskRunSkipReason, Schema.String])),
  /** The machine that ran a one-machine occurrence this one skipped. */
  ranOn: Schema.NullOr(EnvironmentId),
  /** Set when the run started on another account because the task's own was out of usage. */
  failover: Schema.NullOr(Schema.Struct({ from: ProviderInstanceId, to: ProviderInstanceId })),
  /** Null when the task had no run condition, or the run ignored it. Absent from servers without run conditions. */
  check: Schema.optional(Schema.NullOr(ScheduledTaskRunCheck)),
});
export type ScheduledTaskRunRecord = typeof ScheduledTaskRunRecord.Type;

/** The latest occurrence a task's run condition skipped. */
export const ScheduledTaskNoWorkSkip = Schema.Struct({
  at: IsoDateTime,
  /** The scheduled time it skipped. */
  scheduledFor: Schema.NullOr(IsoDateTime),
  /** From the command's output: its JSON `reason`, else its last line. */
  reason: Schema.NullOr(Schema.String),
});
export type ScheduledTaskNoWorkSkip = typeof ScheduledTaskNoWorkSkip.Type;

export const ScheduledTaskWebhookEndpoint = Schema.Struct({
  path: TrimmedNonEmptyString,
  url: Schema.NullOr(TrimmedNonEmptyString),
  hasSecret: Schema.Boolean,
});
export type ScheduledTaskWebhookEndpoint = typeof ScheduledTaskWebhookEndpoint.Type;

/**
 * Orders edits to a shared task across machines: the later `at` wins, then the
 * higher environment id. Each machine stamps its own edits and keeps a stamp it
 * receives as-is, so every machine settles on the same winner.
 */
export const ScheduledTaskSharedRevision = Schema.Struct({
  at: IsoDateTime,
  environmentId: EnvironmentId,
});
export type ScheduledTaskSharedRevision = typeof ScheduledTaskSharedRevision.Type;

export function compareScheduledTaskSharedRevisions(
  left: ScheduledTaskSharedRevision,
  right: ScheduledTaskSharedRevision,
): number {
  const byTime = Date.parse(left.at) - Date.parse(right.at);
  if (byTime !== 0) return Math.sign(byTime);
  return left.environmentId < right.environmentId
    ? -1
    : left.environmentId > right.environmentId
      ? 1
      : 0;
}

/** Where a shared task runs on each machine: its No project, or its project with this repository. */
export const ScheduledTaskSharedProject = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({
    type: Schema.Literal("repository"),
    canonicalKey: TrimmedNonEmptyString,
    title: TrimmedNonEmptyString,
  }),
]);
export type ScheduledTaskSharedProject = typeof ScheduledTaskSharedProject.Type;

export function scheduledTaskSharedProjectKey(project: ScheduledTaskSharedProject): string {
  return project.type === "none" ? "none" : `repository:${project.canonicalKey}`;
}

/** `every`: each machine runs every occurrence. `one`: one machine runs each, in the project's machine order. */
export const ScheduledTaskSharedRunOn = Schema.Literals(["every", "one"]);
export type ScheduledTaskSharedRunOn = typeof ScheduledTaskSharedRunOn.Type;

/** A task with the same id on every machine. */
export const ScheduledTaskSharing = Schema.Struct({
  revision: ScheduledTaskSharedRevision,
  project: ScheduledTaskSharedProject,
  /** Machines that keep no copy. New machines get the task. */
  excludedEnvironmentIds: Schema.Array(EnvironmentId),
  /** Absent means `every`. */
  runOn: Schema.optional(ScheduledTaskSharedRunOn),
});
export type ScheduledTaskSharing = typeof ScheduledTaskSharing.Type;

/**
 * The machines a project's one-machine tasks try, first to last. Synced like a
 * shared task; a machine holding a copy but missing here comes after the list.
 */
export const ScheduledTaskProjectMachineOrder = Schema.Struct({
  project: ScheduledTaskSharedProject,
  order: Schema.Array(EnvironmentId),
  revision: ScheduledTaskSharedRevision,
});
export type ScheduledTaskProjectMachineOrder = typeof ScheduledTaskProjectMachineOrder.Type;

/** How this machine last settled an occurrence of a one-machine task. */
export const ScheduledTaskOneMachineDecision = Schema.Struct({
  at: IsoDateTime,
  /** The machine that already ran or is running it, when this one skipped; null when this one ran it. */
  ranOn: Schema.NullOr(EnvironmentId),
  /** Machines this one could not ask, and why. It ran the task anyway. */
  unchecked: Schema.Array(Schema.Struct({ environmentId: EnvironmentId, reason: Schema.String })),
});
export type ScheduledTaskOneMachineDecision = typeof ScheduledTaskOneMachineDecision.Type;

/** Kept after a shared task is deleted or unshared, so a stale copy elsewhere is removed rather than restored. */
export const ScheduledTaskSharedDeletion = Schema.Struct({
  id: ScheduledTaskId,
  revision: ScheduledTaskSharedRevision,
});
export type ScheduledTaskSharedDeletion = typeof ScheduledTaskSharedDeletion.Type;

export const MAX_PROMPT_FILE_PATH_LENGTH = 512;

export type PromptFilePathProblem =
  | "too_long"
  | "backslash"
  | "absolute"
  | "control_character"
  | "empty_or_dot_part";

/** Why a prompt file path is refused, or undefined when it names a file from the repository's root. */
export function promptFilePathProblem(path: string): PromptFilePathProblem | undefined {
  if (path.length > MAX_PROMPT_FILE_PATH_LENGTH) return "too_long";
  if (path.includes("\\")) return "backslash";
  if (path.startsWith("/") || /^[A-Za-z]:/u.test(path)) return "absolute";
  if (/\p{Cc}/u.test(path)) return "control_character";
  if (path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return "empty_or_dot_part";
  }
  return undefined;
}

// Clients show their own translated text for each problem; this is what the server answers.
const PROMPT_FILE_PATH_PROBLEM_TEXT: Record<PromptFilePathProblem, string> = {
  too_long: `The prompt file path is longer than ${MAX_PROMPT_FILE_PATH_LENGTH} characters.`,
  backslash: "Write the prompt file path with forward slashes.",
  absolute: "The prompt file path starts at the repository's root, so it cannot be absolute.",
  control_character: "The prompt file path cannot hold control characters.",
  empty_or_dot_part: "The prompt file path cannot have empty, . or .. parts.",
};

/** A file in the task's project, read from its remote's default branch for each run. */
export const ScheduledTaskPromptFilePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_PROMPT_FILE_PATH_LENGTH),
  Schema.makeFilter((path: string) => {
    const problem = promptFilePathProblem(path);
    return problem === undefined ? undefined : PROMPT_FILE_PATH_PROBLEM_TEXT[problem];
  }),
).annotate({
  description: "A path from the repository's root, such as automations/daily.md.",
});

/** One read of a prompt file: where it came from. The task's `prompt` holds the text it read. */
export const ScheduledTaskPromptFileRead = Schema.Struct({
  at: IsoDateTime,
  /** The remote branch it was read from, such as `origin/main`. */
  ref: TrimmedNonEmptyString,
  commit: TrimmedNonEmptyString,
});
export type ScheduledTaskPromptFileRead = typeof ScheduledTaskPromptFileRead.Type;

export const ScheduledTaskPromptFile = Schema.Struct({
  path: ScheduledTaskPromptFilePath,
  /** This machine's last read. Null until it reads the file, as for a shared copy from another machine. */
  lastRead: Schema.NullOr(ScheduledTaskPromptFileRead),
});
export type ScheduledTaskPromptFile = typeof ScheduledTaskPromptFile.Type;

export const ScheduledTask = Schema.Struct({
  id: ScheduledTaskId,
  title: TrimmedNonEmptyString,
  /** With `promptFile`, the text its last read found; runs read the file again. */
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskSchedule,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  lastRunError: Schema.NullOr(Schema.String),
  runCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  webhook: Schema.optional(ScheduledTaskWebhookEndpoint),
  /** Where the task shows in thread lists. Absent from servers that predate placement. */
  placement: Schema.optional(ScheduledTaskPlacement),
  /** When the task was pinned; it orders the pinned rows. */
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** Where a pinned task sits once moved by hand; null until then. Absent from servers without reordering. */
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  /** The thread the last successful run used: the bound thread, or the one it started. */
  lastRunThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  /** Runs the scheduled tasks default model, already resolved into `modelSelection`. */
  followsDefaultModel: Schema.optional(Schema.Boolean),
  /** Why the task cannot run regardless of `enabled`, such as a managed policy refusing webhooks. */
  blockedByPolicy: Schema.optionalKey(Schema.String),
  /** Present on a shared task. Absent from servers without sharing. */
  shared: Schema.optional(Schema.NullOr(ScheduledTaskSharing)),
  lastOneMachineDecision: Schema.optional(Schema.NullOr(ScheduledTaskOneMachineDecision)),
  /** A shared task's own model is not set up on this machine, so it runs the scheduled tasks default model here. */
  modelUnavailableHere: Schema.optional(Schema.Boolean),
  /**
   * A fixed-time run missed while the app was off runs once when the app is back, if that is
   * nearer the missed time than the next run. Absent from servers without catch-up.
   */
  catchUpMissedRun: Schema.optional(Schema.Boolean),
  /** Null when the task has none. Absent from servers without run conditions. */
  runCondition: Schema.optional(Schema.NullOr(ScheduledTaskRunCondition)),
  /** Null until a run condition first skips an occurrence. Kept after the condition is cleared: it is history. */
  lastNoWorkSkip: Schema.optional(Schema.NullOr(ScheduledTaskNoWorkSkip)),
  /** When the run condition of the occurrence due now started; null while none is running. */
  runCheckStartedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** Each run reads its prompt from this file. Null: `prompt` is the text. Absent from servers without prompt files. */
  promptFile: Schema.optional(Schema.NullOr(ScheduledTaskPromptFile)),
});
export type ScheduledTask = typeof ScheduledTask.Type;

export const ScheduledTaskListInput = Schema.Struct({});
export type ScheduledTaskListInput = typeof ScheduledTaskListInput.Type;

export const ScheduledTaskListResult = Schema.Struct({
  tasks: ForwardCompatibleArray(ScheduledTask),
  /** Shared tasks this machine deleted or unshared. Absent from servers without sharing. */
  sharedDeletions: Schema.optional(Schema.Array(ScheduledTaskSharedDeletion)),
  projectMachineOrders: Schema.optional(Schema.Array(ScheduledTaskProjectMachineOrder)),
  /** This machine's links, so clients can warn about one-machine tasks it cannot check. */
  peerLinks: Schema.optional(
    Schema.Struct({
      enabled: Schema.Boolean,
      links: Schema.Array(Schema.Struct({ environmentId: EnvironmentId, expiresAt: IsoDateTime })),
    }),
  ),
});
export type ScheduledTaskListResult = typeof ScheduledTaskListResult.Type;

/** A task on a machine this environment links to, as that machine last reported it. */
export const LinkedScheduledTask = Schema.Struct({
  id: ScheduledTaskId,
  title: Schema.String,
  prompt: Schema.String,
  enabled: Schema.Boolean,
  projectId: ProjectId,
  /** Null when that machine did not list the project. */
  projectTitle: Schema.NullOr(Schema.String),
  schedule: ScheduledTaskSchedule,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  lastRunAt: Schema.NullOr(IsoDateTime),
  shared: Schema.Boolean,
  /** Absent from servers without run conditions. */
  lastNoWorkSkip: Schema.optional(Schema.NullOr(ScheduledTaskNoWorkSkip)),
});
export type LinkedScheduledTask = typeof LinkedScheduledTask.Type;

/** The last task list this environment got from one machine it links to. */
export const LinkedScheduledTaskMachine = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** When it last answered. Null until it first does. */
  seenAt: Schema.NullOr(IsoDateTime),
  /** When this environment last asked it. */
  checkedAt: IsoDateTime,
  /** Why the last ask failed. Null when it answered. */
  error: Schema.NullOr(Schema.String),
  tasks: ForwardCompatibleArray(LinkedScheduledTask),
});
export type LinkedScheduledTaskMachine = typeof LinkedScheduledTaskMachine.Type;

export const LinkedScheduledTasksInput = Schema.Struct({});
export type LinkedScheduledTasksInput = typeof LinkedScheduledTasksInput.Type;

export const LinkedScheduledTasksResult = Schema.Struct({
  machines: ForwardCompatibleArray(LinkedScheduledTaskMachine),
});
export type LinkedScheduledTasksResult = typeof LinkedScheduledTasksResult.Type;

export const ScheduledTaskUpsertInput = Schema.Struct({
  id: Schema.optional(ScheduledTaskId),
  placement: Schema.optional(ScheduledTaskPlacement).annotate({
    description:
      "Where the task shows in the thread list. Omitted keeps the stored one, or for a new task the default.",
  }),
  requireExisting: Schema.optional(Schema.Boolean).annotate({
    description: "Reject the save if the task no longer exists, for edits from a client form.",
  }),
  commandId: Schema.optional(CommandId),
  title: TrimmedNonEmptyString,
  prompt: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "Needed unless the task reads its prompt from a file; ignored when it does.",
  }),
  promptFile: Schema.optional(Schema.NullOr(ScheduledTaskPromptFilePath)).annotate({
    description:
      "Read the prompt from this file of the project's repository, on its remote's default branch, at each run. The save reads it once. Null: run `prompt`. Omitted keeps the stored choice.",
  }),
  enabled: Schema.Boolean,
  schedule: ScheduledTaskUpsertSchedule,
  projectId: ProjectId,
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  followsDefaultModel: Schema.optional(Schema.Boolean).annotate({
    description: "Run the scheduled tasks default model. Omitted keeps the stored choice.",
  }),
  catchUpMissedRun: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run a fixed-time run missed while the app was off once it is back. Omitted keeps the stored choice, or for a new task the default: on for daily tasks.",
  }),
  runCondition: Schema.optional(Schema.NullOr(ScheduledTaskRunConditionInput)).annotate({
    description:
      "A command to run before each scheduled occurrence: exit code 0 starts the chat, 10 skips the occurrence. Null clears it. Omitted keeps the stored one.",
  }),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdBy: Schema.optional(OrchestrationV2Actor),
  creationSource: Schema.optional(OrchestrationV2CreationSource),
  shared: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        excludedEnvironmentIds: Schema.Array(EnvironmentId),
        runOn: Schema.optional(ScheduledTaskSharedRunOn),
        machineOrder: Schema.optional(Schema.Array(EnvironmentId)).annotate({
          description:
            "Sets the machine order of the task's project, for all its one-machine tasks.",
        }),
      }),
    ),
  ).annotate({
    description:
      "Run on every machine, kept in sync. Null keeps it on this machine only. Omitted keeps the stored choice.",
  }),
});
export type ScheduledTaskUpsertInput = typeof ScheduledTaskUpsertInput.Type;

/** A shared task as one machine hands it to another: its definition, without run state. */
export const ScheduledTaskSharedCopy = Schema.Struct({
  id: ScheduledTaskId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskSchedule,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  followsDefaultModel: Schema.Boolean,
  /** Absent from machines without catch-up; the receiving machine keeps its own choice. */
  catchUpMissedRun: Schema.optional(Schema.Boolean),
  /** Null: the task has none. Absent from machines without run conditions; the receiving machine keeps its own. */
  runCondition: Schema.optional(Schema.NullOr(ScheduledTaskRunCondition)),
  /** Null: the task runs `prompt`. Absent from machines without prompt files; the receiving machine keeps its own. */
  promptFile: Schema.optional(Schema.NullOr(ScheduledTaskPromptFilePath)),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  createdAt: IsoDateTime,
  shared: ScheduledTaskSharing,
});
export type ScheduledTaskSharedCopy = typeof ScheduledTaskSharedCopy.Type;

/** Brings this machine's copy of a shared task up to a newer revision; an older one changes nothing. */
export const ScheduledTaskApplySharedInput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("upsert"), task: ScheduledTaskSharedCopy }),
  Schema.Struct({ type: Schema.Literal("delete"), deletion: ScheduledTaskSharedDeletion }),
  Schema.Struct({
    type: Schema.Literal("projectMachineOrder"),
    order: ScheduledTaskProjectMachineOrder,
  }),
]);
export type ScheduledTaskApplySharedInput = typeof ScheduledTaskApplySharedInput.Type;

export const ScheduledTaskApplySharedResult = Schema.Struct({
  /**
   * `applied`: saved or deleted. `removed`: this machine is excluded, so its copy
   * was dropped. `stale`: it already has this revision or a newer one. `local`:
   * a task here that is not shared already uses the id, so it was left alone.
   */
  outcome: Schema.Literals(["applied", "removed", "stale", "local"]),
});
export type ScheduledTaskApplySharedResult = typeof ScheduledTaskApplySharedResult.Type;

export const ScheduledTaskSetEnabledInput = Schema.Struct({
  id: ScheduledTaskId,
  enabled: Schema.Boolean,
});
export type ScheduledTaskSetEnabledInput = typeof ScheduledTaskSetEnabledInput.Type;

export const ScheduledTaskSetPlacementInput = Schema.Struct({
  ids: Schema.Array(ScheduledTaskId).check(Schema.isMinLength(1)),
  placement: ScheduledTaskPlacement,
});
export type ScheduledTaskSetPlacementInput = typeof ScheduledTaskSetPlacementInput.Type;

export const ScheduledTaskSetPlacementResult = Schema.Struct({
  /** The tasks that changed; a task already there or since deleted is left out. */
  ids: Schema.Array(ScheduledTaskId),
});
export type ScheduledTaskSetPlacementResult = typeof ScheduledTaskSetPlacementResult.Type;

export const ScheduledTaskReorderPinnedInput = Schema.Struct({
  assignments: Schema.Array(
    Schema.Struct({ id: ScheduledTaskId, orderKey: TrimmedNonEmptyString }),
  ).check(Schema.isMinLength(1)),
});
export type ScheduledTaskReorderPinnedInput = typeof ScheduledTaskReorderPinnedInput.Type;

export const ScheduledTaskReorderPinnedResult = Schema.Struct({
  /** The tasks that took their key; one since unpinned or deleted is left out. */
  ids: Schema.Array(ScheduledTaskId),
});
export type ScheduledTaskReorderPinnedResult = typeof ScheduledTaskReorderPinnedResult.Type;

export const ScheduledTaskSetFollowsDefaultModelInput = Schema.Struct({
  ids: Schema.Array(ScheduledTaskId).check(Schema.isMinLength(1)),
  followsDefaultModel: Schema.Boolean,
});
export type ScheduledTaskSetFollowsDefaultModelInput =
  typeof ScheduledTaskSetFollowsDefaultModelInput.Type;

export const ScheduledTaskSetFollowsDefaultModelResult = Schema.Struct({
  /** The tasks that changed; a task already in that state or since deleted is left out. */
  ids: Schema.Array(ScheduledTaskId),
});
export type ScheduledTaskSetFollowsDefaultModelResult =
  typeof ScheduledTaskSetFollowsDefaultModelResult.Type;

export const ScheduledTaskDeleteInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskDeleteInput = typeof ScheduledTaskDeleteInput.Type;

export const ScheduledTaskRunNowInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskRunNowInput = typeof ScheduledTaskRunNowInput.Type;

export const ScheduledTaskListRunsInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskListRunsInput = typeof ScheduledTaskListRunsInput.Type;

/** Newest first; the server keeps the most recent runs of each task. */
export const ScheduledTaskListRunsResult = Schema.Struct({
  runs: Schema.Array(ScheduledTaskRunRecord),
});
export type ScheduledTaskListRunsResult = typeof ScheduledTaskListRunsResult.Type;

export const ScheduledTaskRotateWebhookTokenInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskRotateWebhookTokenInput = typeof ScheduledTaskRotateWebhookTokenInput.Type;

export const ScheduledTaskWebhookDeliveryId = TrimmedNonEmptyString.pipe(
  Schema.brand("ScheduledTaskWebhookDeliveryId"),
);
export type ScheduledTaskWebhookDeliveryId = typeof ScheduledTaskWebhookDeliveryId.Type;

export const ScheduledTaskWebhookDeliveryOutcome = Schema.Literals([
  "accepted",
  "dispatch_failed",
  "duplicate",
  "coalesced",
  "rejected_signature",
  "disabled",
  "rate_limited",
  "expired",
  "filtered",
]);
export type ScheduledTaskWebhookDeliveryOutcome = typeof ScheduledTaskWebhookDeliveryOutcome.Type;

export const ScheduledTaskWebhookDeliverySummary = Schema.Struct({
  id: ScheduledTaskWebhookDeliveryId,
  taskId: ScheduledTaskId,
  receivedAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  contentType: Schema.NullOr(Schema.String),
  bodyBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  // Any string, so an outcome added later doesn't break a client's whole list.
  outcome: Schema.Union([ScheduledTaskWebhookDeliveryOutcome, Schema.String]),
  signatureVerified: Schema.Boolean,
  pendingWindow: Schema.optional(Schema.Boolean),
  missingFields: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type ScheduledTaskWebhookDeliverySummary = typeof ScheduledTaskWebhookDeliverySummary.Type;

export const ScheduledTaskWebhookDelivery = Schema.Struct({
  ...ScheduledTaskWebhookDeliverySummary.fields,
  query: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
  bodyTruncated: Schema.Boolean,
  renderedPrompt: Schema.NullOr(Schema.String),
});
export type ScheduledTaskWebhookDelivery = typeof ScheduledTaskWebhookDelivery.Type;

export const ScheduledTaskListWebhookDeliveriesInput = Schema.Struct({
  id: ScheduledTaskId,
  /**
   * Sent by clients that decode any outcome. Shipped clients decode a closed
   * list and fail on the whole response, so without it the server leaves out
   * rows with outcomes they don't know.
   */
  acceptAnyOutcome: Schema.optional(Schema.Boolean),
});
export type ScheduledTaskListWebhookDeliveriesInput =
  typeof ScheduledTaskListWebhookDeliveriesInput.Type;

export const ScheduledTaskListWebhookDeliveriesResult = Schema.Struct({
  deliveries: Schema.Array(ScheduledTaskWebhookDeliverySummary),
});
export type ScheduledTaskListWebhookDeliveriesResult =
  typeof ScheduledTaskListWebhookDeliveriesResult.Type;

export const ScheduledTaskGetWebhookDeliveryInput = Schema.Struct({
  id: ScheduledTaskId,
  deliveryId: ScheduledTaskWebhookDeliveryId,
  acceptAnyOutcome: Schema.optional(Schema.Boolean),
});
export type ScheduledTaskGetWebhookDeliveryInput = typeof ScheduledTaskGetWebhookDeliveryInput.Type;

export const ScheduledTaskGetWebhookDeliveryResult = Schema.Struct({
  delivery: ScheduledTaskWebhookDelivery,
});
export type ScheduledTaskGetWebhookDeliveryResult =
  typeof ScheduledTaskGetWebhookDeliveryResult.Type;

export const ScheduledTaskMutationResult = Schema.Struct({
  task: ScheduledTask,
});
export type ScheduledTaskMutationResult = typeof ScheduledTaskMutationResult.Type;

export const ScheduledTaskDeleteResult = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskDeleteResult = typeof ScheduledTaskDeleteResult.Type;

export const ScheduledTaskRunNowResult = Schema.Struct({
  task: ScheduledTask,
});
export type ScheduledTaskRunNowResult = typeof ScheduledTaskRunNowResult.Type;

export class ScheduledTaskError extends Schema.TaggedError<ScheduledTaskError>()(
  "ScheduledTaskError",
  {
    message: Schema.String,
    taskId: Schema.optional(ScheduledTaskId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
