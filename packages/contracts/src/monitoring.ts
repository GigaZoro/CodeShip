import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

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

/** The most days one overview can ask about. */
const MONITORING_MAX_DAYS = 366;

const MONITORING_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A day on the viewer's clock: its `YYYY-MM-DD` name and the instant it starts. */
export const MonitoringDay = Schema.Struct({
  day: TrimmedNonEmptyString.check(Schema.isPattern(MONITORING_DAY_PATTERN)),
  since: IsoDateTime,
});
export type MonitoringDay = typeof MonitoringDay.Type;

/**
 * Chats settled from the first day's start until `until`, each counted on the last day that had
 * started by then. The viewer's clock draws the days, so every environment counts a chat on the
 * same day, whatever time zone data its own machine has.
 */
export const MonitoringOverviewInput = Schema.Struct({
  days: Schema.NonEmptyArray(MonitoringDay).check(Schema.isMaxLength(MONITORING_MAX_DAYS)),
  until: IsoDateTime,
});
export type MonitoringOverviewInput = typeof MonitoringOverviewInput.Type;

/** One finding code within a group: the chats it hit, how often, and the time it cost. */
export const MonitoringFindingTotal = Schema.Struct({
  code: MonitoringFindingCode,
  /** The highest severity it had in any of the chats. */
  severity: MonitoringFindingSeverity,
  chats: NonNegativeInt,
  occurrences: NonNegativeInt,
  wastedMs: NonNegativeInt,
});
export type MonitoringFindingTotal = typeof MonitoringFindingTotal.Type;

/**
 * The chats that settled on one day, in one project, of one kind, on one main model, summed. Each
 * chat counts in exactly one group, so groups add up across filters and environments, and the
 * per-chat times keep medians exact.
 */
export const MonitoringGroup = Schema.Struct({
  /** The name of the requested day the chats settled on. */
  day: Schema.String,
  projectId: ProjectId,
  kind: MonitoringThreadKind,
  /** The chats' own latest model; empty for chats that ran none. */
  model: Schema.String,
  /** One entry per chat, so their length is the group's chat count. */
  lifetimesMs: Schema.Array(NonNegativeInt),
  activesMs: Schema.Array(NonNegativeInt),
  time: MonitoringTimeBuckets,
  tokens: MonitoringTokenTotals,
  costUsd: Schema.Number,
  unpricedTurns: NonNegativeInt,
  runs: NonNegativeInt,
  failedRuns: NonNegativeInt,
  userPrompts: NonNegativeInt,
  /** Subagents, delegates, commands and workflows. */
  helpers: NonNegativeInt,
  findings: ForwardCompatibleArray(MonitoringFindingTotal),
  phases: ForwardCompatibleArray(MonitoringPhaseStats),
});
export type MonitoringGroup = typeof MonitoringGroup.Type;

/** The settled chats of one project in the window that no group holds yet. */
export const MonitoringUnanalyzed = Schema.Struct({
  projectId: ProjectId,
  /** Still waiting for their first analysis. */
  pending: NonNegativeInt,
  /** Their analysis failed; they are analyzed again later. */
  failed: NonNegativeInt,
});
export type MonitoringUnanalyzed = typeof MonitoringUnanalyzed.Type;

export const MonitoringOverviewResult = Schema.Struct({
  serverEpoch: Schema.optionalKey(Schema.String),
  revision: Schema.optionalKey(NonNegativeInt),
  /** Every analyzed chat in the window, grouped. */
  groups: Schema.Array(MonitoringGroup),
  /** One entry per project that has such chats; kind and model are known only after analysis. */
  unanalyzed: Schema.Array(MonitoringUnanalyzed),
});
export type MonitoringOverviewResult = typeof MonitoringOverviewResult.Type;

export const MonitoringChatSort = Schema.Literals([
  "settledAt",
  "lifetimeMs",
  "activeMs",
  "costUsd",
  "findings",
  "failures",
]);
export type MonitoringChatSort = typeof MonitoringChatSort.Type;

const MONITORING_CHATS_PAGE_LIMIT = 500;

/** One page of the analyzed chats of the window that match, in the requested order. */
export const MonitoringChatsInput = Schema.Struct({
  since: IsoDateTime,
  until: Schema.optional(IsoDateTime),
  projectId: Schema.optional(ProjectId),
  kind: Schema.optional(MonitoringThreadKind),
  /** A main model; empty for chats that ran none. */
  model: Schema.optional(Schema.String),
  findingCode: Schema.optional(MonitoringFindingCode),
  sort: MonitoringChatSort,
  direction: Schema.Literals(["asc", "desc"]),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MONITORING_CHATS_PAGE_LIMIT })),
  /** How many matching chats come before the page. */
  offset: NonNegativeInt,
});
export type MonitoringChatsInput = typeof MonitoringChatsInput.Type;

export const MonitoringListedChat = Schema.Struct({
  summary: MonitoringThreadSummary,
  /**
   * The key the environment sorted by, as a number: epoch milliseconds for `settledAt`. A merge
   * across environments compares these, since a client of another version can count the same
   * summary differently.
   */
  sortValue: Schema.Finite,
});
export type MonitoringListedChat = typeof MonitoringListedChat.Type;

export const MonitoringChatsResult = Schema.Struct({
  serverEpoch: Schema.optionalKey(Schema.String),
  revision: Schema.optionalKey(NonNegativeInt),
  chats: Schema.Array(MonitoringListedChat),
  /** Every chat that matches, on every page. */
  total: NonNegativeInt,
});
export type MonitoringChatsResult = typeof MonitoringChatsResult.Type;

export const MonitoringThreadInput = Schema.Struct({
  threadId: ThreadId,
  withRevision: Schema.optionalKey(Schema.Boolean),
});
export type MonitoringThreadInput = typeof MonitoringThreadInput.Type;

/** `null` when the chat is not settled, not a listed chat, or gone. */
export const MonitoringThreadAnswer = Schema.Struct({
  serverEpoch: Schema.optionalKey(Schema.String),
  revision: NonNegativeInt,
  detail: Schema.NullOr(MonitoringThreadDetail),
});
export type MonitoringThreadAnswer = typeof MonitoringThreadAnswer.Type;

// Older clients receive the original detail or null unless they opt in to revision tracking.
export const MonitoringThreadResult = Schema.Union([
  MonitoringThreadAnswer,
  MonitoringThreadDetail,
  Schema.Null,
]);
export type MonitoringThreadResult = typeof MonitoringThreadResult.Type;

/** Sent when the set of analyzed chats changes: a chat settled, reopened, or was analyzed again. */
export const MonitoringChange = Schema.Struct({
  serverEpoch: Schema.optionalKey(Schema.String),
  revision: NonNegativeInt,
  sinceRevision: Schema.optionalKey(NonNegativeInt),
  threadIds: Schema.optionalKey(Schema.Array(ThreadId)),
});
export type MonitoringChange = typeof MonitoringChange.Type;
