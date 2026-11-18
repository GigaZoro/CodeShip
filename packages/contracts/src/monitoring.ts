import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { UsageDay } from "./usage.ts";

export class MonitoringError extends Schema.TaggedError<MonitoringError>()("MonitoringError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Who started the chat: a person, a scheduled task, another agent, or a delegating chat. */
export const MonitoringThreadKind = Schema.Literals([
  "interactive",
  "scheduled",
  "agent",
  "delegated",
]);
export type MonitoringThreadKind = typeof MonitoringThreadKind.Type;

/**
 * Where a chat's lifetime went, from creation to settling. Every millisecond counts in exactly one
 * bucket, so the buckets add up to `lifetimeMs`.
 */
export const MonitoringTimeBuckets = Schema.Struct({
  /** A run was active and the model itself was working. */
  agentMs: NonNegativeInt,
  /** A run was active and a shell command was running. */
  commandMs: NonNegativeInt,
  /** A run was active and another tool (MCP, search, file read) was running. */
  toolMs: NonNegativeInt,
  /** A run was active and waited on an approval or a question to the user. */
  approvalMs: NonNegativeInt,
  /** A run was requested and waited to start. */
  queuedMs: NonNegativeInt,
  /** No run was active because a usage limit stopped the chat. */
  usageLimitMs: NonNegativeInt,
  /** No run was active while the chat's delegates, commands or background tasks ran. */
  delegateWaitMs: NonNegativeInt,
  /** No run was active until the user sent the next prompt. */
  userResponseMs: NonNegativeInt,
  /** No run was active for another reason, such as a timer or a scheduled wake. */
  idleMs: NonNegativeInt,
  /** After the last run ended, until the chat was settled. */
  settleTailMs: NonNegativeInt,
});
export type MonitoringTimeBuckets = typeof MonitoringTimeBuckets.Type;

/** The step of a process a shell command belongs to, read from the command line. */
export const MonitoringCommandPhase = Schema.Literals([
  "install",
  "build",
  "typecheck",
  "lint",
  "format",
  "test",
  "git",
  "ship",
  "inspect",
  "run",
  "other",
]);
export type MonitoringCommandPhase = typeof MonitoringCommandPhase.Type;

export const MonitoringPhaseStats = Schema.Struct({
  phase: MonitoringCommandPhase,
  count: NonNegativeInt,
  failed: NonNegativeInt,
  durationMs: NonNegativeInt,
});
export type MonitoringPhaseStats = typeof MonitoringPhaseStats.Type;

export const MonitoringFindingCode = Schema.Literals([
  "usage_limit",
  "run_failures",
  "retries",
  "steering_restarts",
  "user_interrupts",
  "long_queue",
  "slow_command",
  "repeated_command",
  "failing_commands",
  "approval_wait",
  "delegate_wait",
  "low_cache_reuse",
  "context_compacted",
  "context_pressure",
  "many_prompts",
  "reopened",
]);
export type MonitoringFindingCode = typeof MonitoringFindingCode.Type;

export const MonitoringFindingSeverity = Schema.Literals(["high", "medium", "low"]);
export type MonitoringFindingSeverity = typeof MonitoringFindingSeverity.Type;

/** A weak point in one chat's process. Clients word it from `code`; `detail` is data, such as a command. */
export const MonitoringFinding = Schema.Struct({
  code: MonitoringFindingCode,
  severity: MonitoringFindingSeverity,
  /** Time the weak point cost: waiting, failed work, or repeats beyond the first. */
  wastedMs: NonNegativeInt,
  count: NonNegativeInt,
  detail: Schema.NullOr(Schema.String),
});
export type MonitoringFinding = typeof MonitoringFinding.Type;

export const MonitoringTokenTotals = Schema.Struct({
  inputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
});
export type MonitoringTokenTotals = typeof MonitoringTokenTotals.Type;

/** One settled chat, analyzed when it settled. */
export const MonitoringThreadSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  kind: MonitoringThreadKind,
  providerInstanceId: ProviderInstanceId,
  /** The model of the chat's own runs, latest first. */
  models: Schema.Array(Schema.String),
  /** Models its subagents and delegates ran on. */
  helperModels: Schema.Array(Schema.String),
  createdAt: IsoDateTime,
  settledAt: IsoDateTime,
  lifetimeMs: NonNegativeInt,
  /** Time a run of the chat itself was active, overlaps counted once. */
  activeMs: NonNegativeInt,
  time: MonitoringTimeBuckets,
  runs: Schema.Struct({
    total: NonNegativeInt,
    completed: NonNegativeInt,
    failed: NonNegativeInt,
    interrupted: NonNegativeInt,
    cancelled: NonNegativeInt,
    /** Runs started by a prompt the user wrote. */
    userPrompts: NonNegativeInt,
    /** Runs the app or another agent started: wakes, continuations, scheduled prompts. */
    automatic: NonNegativeInt,
    retries: NonNegativeInt,
    steeringRestarts: NonNegativeInt,
    providerRecoveries: NonNegativeInt,
  }),
  /** Errors by failure class: usage_limit, provider_error, transport_error and so on. */
  errors: Schema.Record(Schema.String, NonNegativeInt),
  tokens: MonitoringTokenTotals,
  /** Estimated API-equivalent cost of the chat's own turns, at Usage's model prices. */
  costUsd: Schema.Number,
  /** Turns with no token counts or no known price; their cost is left out. */
  unpricedTurns: NonNegativeInt,
  /** Highest share of the context window a turn used, 0 to 1, when the provider reports it. */
  peakContextRatio: Schema.NullOr(Schema.Number),
  compactions: NonNegativeInt,
  handoffs: NonNegativeInt,
  helpers: Schema.Struct({
    /** The provider's own subagents. */
    subagents: NonNegativeInt,
    /** delegate_task children, here or in a linked environment. */
    delegates: NonNegativeInt,
    /** t3_command_run commands. */
    commands: NonNegativeInt,
    workflows: NonNegativeInt,
    failed: NonNegativeInt,
  }),
  commands: Schema.Struct({
    count: NonNegativeInt,
    failed: NonNegativeInt,
    durationMs: NonNegativeInt,
  }),
  phases: ForwardCompatibleArray(MonitoringPhaseStats),
  filesChanged: NonNegativeInt,
  /** Times the chat was reopened after it had settled. */
  reopens: NonNegativeInt,
  findings: ForwardCompatibleArray(MonitoringFinding),
});
export type MonitoringThreadSummary = typeof MonitoringThreadSummary.Type;

export const MonitoringLaneKind = Schema.Literals([
  "chat",
  "subagent",
  "delegate",
  "command",
  "workflow",
]);
export type MonitoringLaneKind = typeof MonitoringLaneKind.Type;

export const MonitoringSegmentStatus = Schema.Literals([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "running",
]);
export type MonitoringSegmentStatus = typeof MonitoringSegmentStatus.Type;

export const MonitoringSegment = Schema.Struct({
  startedAt: IsoDateTime,
  completedAt: IsoDateTime,
  status: MonitoringSegmentStatus,
  /** The run a chat-lane segment belongs to. */
  runId: Schema.NullOr(RunId),
});
export type MonitoringSegment = typeof MonitoringSegment.Type;

/** One row of the timeline: the chat's own runs, or one helper. */
export const MonitoringLane = Schema.Struct({
  id: Schema.String,
  kind: MonitoringLaneKind,
  label: Schema.String,
  model: Schema.NullOr(Schema.String),
  /** The helper's own chat, when it has one here. */
  childThreadId: Schema.NullOr(ThreadId),
  tokens: Schema.NullOr(NonNegativeInt),
  /** The lane's longest segments in start order; a lane with very many keeps only some. */
  segments: Schema.Array(MonitoringSegment),
  /** Shorter segments left out of `segments`. */
  omittedSegments: NonNegativeInt,
});
export type MonitoringLane = typeof MonitoringLane.Type;

export const MonitoringMarkerKind = Schema.Literals([
  "user_prompt",
  "automatic_prompt",
  "usage_limit",
  "failure",
  "interrupt",
  "compaction",
  "handoff",
  "steering_restart",
  "retry",
]);
export type MonitoringMarkerKind = typeof MonitoringMarkerKind.Type;

export const MonitoringMarker = Schema.Struct({
  at: IsoDateTime,
  kind: MonitoringMarkerKind,
  detail: Schema.NullOr(Schema.String),
});
export type MonitoringMarker = typeof MonitoringMarker.Type;

/** `helpers` is the app's wake after the chat's helpers finished. */
export const MonitoringPromptSource = Schema.Literals([
  "user",
  "automatic",
  "scheduled",
  "agent",
  "helpers",
]);
export type MonitoringPromptSource = typeof MonitoringPromptSource.Type;

/** One run of the chat and the prompt that started it. */
export const MonitoringRunStep = Schema.Struct({
  runId: RunId,
  source: MonitoringPromptSource,
  /** The start of the prompt, or the titles of the helpers whose end woke the chat; shortened. */
  prompt: Schema.String,
  model: Schema.NullOr(Schema.String),
  status: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  queuedMs: NonNegativeInt,
  durationMs: NonNegativeInt,
  outputTokens: NonNegativeInt,
  costUsd: Schema.NullOr(Schema.Number),
  commands: NonNegativeInt,
  failedCommands: NonNegativeInt,
  filesChanged: NonNegativeInt,
});
export type MonitoringRunStep = typeof MonitoringRunStep.Type;

export const MonitoringCommandRecord = Schema.Struct({
  /** The command line, shortened. */
  command: Schema.String,
  phase: MonitoringCommandPhase,
  startedAt: IsoDateTime,
  durationMs: NonNegativeInt,
  exitCode: Schema.NullOr(Schema.Int),
  failed: Schema.Boolean,
});
export type MonitoringCommandRecord = typeof MonitoringCommandRecord.Type;

/** Runs of the same command line, so a step repeated many times stands out. */
export const MonitoringCommandGroup = Schema.Struct({
  command: Schema.String,
  phase: MonitoringCommandPhase,
  count: NonNegativeInt,
  failed: NonNegativeInt,
  durationMs: NonNegativeInt,
});
export type MonitoringCommandGroup = typeof MonitoringCommandGroup.Type;

/**
 * A very long chat keeps only part of its lanes, markers and steps so the detail stays small; the
 * `omitted` counts say how many were left out.
 */
export const MonitoringThreadDetail = Schema.Struct({
  summary: MonitoringThreadSummary,
  lanes: Schema.Array(MonitoringLane),
  markers: ForwardCompatibleArray(MonitoringMarker),
  steps: Schema.Array(MonitoringRunStep),
  omitted: Schema.Struct({
    lanes: NonNegativeInt,
    markers: NonNegativeInt,
    steps: NonNegativeInt,
  }),
  /** The slowest commands, slowest first. */
  slowestCommands: Schema.Array(MonitoringCommandRecord),
  /** Command lines run more than once, most total time first. */
  repeatedCommands: Schema.Array(MonitoringCommandGroup),
});
export type MonitoringThreadDetail = typeof MonitoringThreadDetail.Type;

/** Longest period one overview may cover, in days; keeps the settled-chat read bounded. */
export const MONITORING_MAX_WINDOW_DAYS = 90;
/** Most chat rows one overview returns. */
export const MONITORING_CHAT_LIMIT_MAX = 1_000;
/** Chats listed under each outlier heading. */
export const MONITORING_OUTLIER_LIMIT = 3;

/**
 * Millisecond durations bucketed on a log scale so environments' distributions merge; quantiles
 * read back within about 1%. Buckets are sorted by index ascending and never empty.
 */
export const MonitoringDurationSketch = Schema.Struct({
  /** Durations of zero, which have no log-scale bucket. */
  zeros: NonNegativeInt,
  buckets: Schema.Array(Schema.Tuple([NonNegativeInt, PositiveInt])),
});
export type MonitoringDurationSketch = typeof MonitoringDurationSketch.Type;

export const MonitoringChatSortKey = Schema.Literals([
  "settledAt",
  "lifetimeMs",
  "activeMs",
  "costUsd",
  "findings",
]);
export type MonitoringChatSortKey = typeof MonitoringChatSortKey.Type;

export const MonitoringChatSort = Schema.Struct({
  key: MonitoringChatSortKey,
  direction: Schema.Literals(["asc", "desc"]),
});
export type MonitoringChatSort = typeof MonitoringChatSort.Type;

/** One listed chat: what the chat table and the outlier lists show. */
export const MonitoringChatRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  kind: MonitoringThreadKind,
  /** The chat's main model; empty when it ran none. */
  model: Schema.String,
  settledAt: IsoDateTime,
  lifetimeMs: NonNegativeInt,
  activeMs: NonNegativeInt,
  costUsd: Schema.Number,
  /** Failed runs plus failed commands. */
  failures: NonNegativeInt,
  findings: NonNegativeInt,
});
export type MonitoringChatRow = typeof MonitoringChatRow.Type;

/**
 * Chats settled from `sinceDay` through `untilDay` (calendar days in `timeZone`, as Usage does).
 * `projectId`, `kind` and `model` narrow every figure; `findingCode` narrows only the chat list.
 */
export const MonitoringOverviewInput = Schema.Struct({
  sinceDay: UsageDay,
  untilDay: UsageDay,
  timeZone: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  kind: Schema.optional(MonitoringThreadKind),
  model: Schema.optional(Schema.String),
  findingCode: Schema.optional(MonitoringFindingCode),
  sort: MonitoringChatSort,
  chatLimit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MONITORING_CHAT_LIMIT_MAX })),
});
export type MonitoringOverviewInput = typeof MonitoringOverviewInput.Type;

export const MonitoringOverviewTotals = Schema.Struct({
  chats: NonNegativeInt,
  lifetimeMs: NonNegativeInt,
  activeMs: NonNegativeInt,
  lifetime: MonitoringDurationSketch,
  active: MonitoringDurationSketch,
  time: MonitoringTimeBuckets,
  costUsd: Schema.Number,
  unpricedTurns: NonNegativeInt,
  tokens: Schema.Struct({
    inputTokens: NonNegativeInt,
    cachedInputTokens: NonNegativeInt,
    outputTokens: NonNegativeInt,
  }),
  runs: NonNegativeInt,
  failedRuns: NonNegativeInt,
  userPrompts: NonNegativeInt,
  /** Subagents, delegates, commands and workflows. */
  helpers: NonNegativeInt,
  findings: NonNegativeInt,
});
export type MonitoringOverviewTotals = typeof MonitoringOverviewTotals.Type;

export const MonitoringFindingRollup = Schema.Struct({
  code: MonitoringFindingCode,
  chats: NonNegativeInt,
  occurrences: NonNegativeInt,
  wastedMs: NonNegativeInt,
  /** The highest severity any chat had. */
  severity: MonitoringFindingSeverity,
});
export type MonitoringFindingRollup = typeof MonitoringFindingRollup.Type;

/** One calendar day in the requested zone; days with no chats are present with zeros. */
export const MonitoringDayRollup = Schema.Struct({
  day: UsageDay,
  chats: NonNegativeInt,
  lifetime: MonitoringDurationSketch,
  activeMs: NonNegativeInt,
  costUsd: Schema.Number,
});
export type MonitoringDayRollup = typeof MonitoringDayRollup.Type;

export const MonitoringBreakdownGroup = Schema.Struct({
  /** A project id, a kind, or a main model; empty when a chat ran no model. */
  key: Schema.String,
  chats: NonNegativeInt,
  lifetime: MonitoringDurationSketch,
  active: MonitoringDurationSketch,
  costUsd: Schema.Number,
  findings: NonNegativeInt,
});
export type MonitoringBreakdownGroup = typeof MonitoringBreakdownGroup.Type;

export const MonitoringOverviewResult = Schema.Struct({
  totals: MonitoringOverviewTotals,
  phases: ForwardCompatibleArray(MonitoringPhaseStats),
  findings: ForwardCompatibleArray(MonitoringFindingRollup),
  days: ForwardCompatibleArray(MonitoringDayRollup),
  breakdowns: Schema.Struct({
    projects: ForwardCompatibleArray(MonitoringBreakdownGroup),
    kinds: ForwardCompatibleArray(MonitoringBreakdownGroup),
    models: ForwardCompatibleArray(MonitoringBreakdownGroup),
  }),
  outliers: Schema.Struct({
    slowest: Schema.Array(MonitoringChatRow),
    mostExpensive: Schema.Array(MonitoringChatRow),
    mostFailures: Schema.Array(MonitoringChatRow),
  }),
  /** The first `chatLimit` listed chats in the requested order. */
  chats: Schema.Array(MonitoringChatRow),
  /** Chats the list holds in all, which may exceed `chats`. */
  listedChats: NonNegativeInt,
  /** Choices for the filters, over every analyzed chat in the period whatever the filters. */
  options: Schema.Struct({
    projectIds: Schema.Array(ProjectId),
    kinds: Schema.Array(MonitoringThreadKind),
    models: Schema.Array(Schema.String),
  }),
  /** Settled chats still waiting for their first analysis. */
  pendingAnalysis: NonNegativeInt,
  /** Settled chats whose analysis failed; they are analyzed again later. */
  failedAnalysis: NonNegativeInt,
});
export type MonitoringOverviewResult = typeof MonitoringOverviewResult.Type;

export const MonitoringThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type MonitoringThreadInput = typeof MonitoringThreadInput.Type;

/** `null` when the chat is not settled, not a listed chat, or gone. */
export const MonitoringThreadResult = Schema.NullOr(MonitoringThreadDetail);
export type MonitoringThreadResult = typeof MonitoringThreadResult.Type;

/** Sent when the set of analyzed chats changes: a chat settled, reopened, or was analyzed again. */
export const MonitoringChange = Schema.Struct({
  revision: NonNegativeInt,
});
export type MonitoringChange = typeof MonitoringChange.Type;
