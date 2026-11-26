import {
  type MonitoringCommandPhase,
  type MonitoringFinding,
  type MonitoringFindingCode,
  type MonitoringFindingSeverity,
  type MonitoringLaneKind,
  type MonitoringMarkerKind,
  type MonitoringSegmentStatus,
  type MonitoringThreadKind,
} from "@t3tools/contracts";
import { msg, t, type Message } from "@t3tools/shared/i18n";
import type * as Cause from "effect/Cause";

import { fixChatFailureReason, type TimeBucketKey } from "./aggregate.ts";

export interface FindingText {
  readonly title: Message;
  readonly explanation: Message;
  /** Worded for many chats at once, when the explanation needs one chat's `{detail}`. */
  readonly overview?: Message;
  /** Null when the finding names a fact and the fix depends on its cause. */
  readonly advice: Message | null;
}

/** `{detail}` in an explanation is the finding's own detail, so the wording stays translatable. */
export const FINDING_TEXT: Readonly<Record<MonitoringFindingCode, FindingText>> = {
  usage_limit: {
    title: msg("Stopped by usage limits"),
    explanation: msg("The chat stood still until a usage limit lifted."),
    advice: msg("Move long or scheduled work to another account or a cheaper model."),
  },
  run_failures: {
    title: msg("Runs failed"),
    explanation: msg("Runs failed, or hit provider, network or other errors."),
    advice: msg(
      "Recurring network errors point at the connection or the provider; others at the setup.",
    ),
  },
  retries: {
    title: msg("Runs retried"),
    explanation: msg("Runs were retried or recovered after provider trouble."),
    advice: null,
  },
  steering_restarts: {
    title: msg("Restarted to steer"),
    explanation: msg("A message sent mid-run restarted the work."),
    advice: msg("Give the whole brief up front, or queue follow-ups."),
  },
  user_interrupts: {
    title: msg("Stopped by hand"),
    explanation: msg("Runs were stopped by hand; their time counts as lost."),
    advice: msg("The agent went the wrong way: sharpen the prompt or the project rules."),
  },
  long_queue: {
    title: msg("Waited in the queue"),
    explanation: msg("Runs waited to start behind other work."),
    advice: null,
  },
  slow_command: {
    title: msg("Slow commands"),
    explanation: msg("Single commands ran 10 minutes or more."),
    advice: msg("Run them in the background, narrow the test scope, cache builds."),
  },
  repeated_command: {
    title: msg("Same command again and again"),
    explanation: msg("One command line ran 4 or more times."),
    advice: msg("Fix the cause before running it again; run focused checks first."),
  },
  failing_commands: {
    title: msg("Failing commands"),
    explanation: msg("Commands failed 3 or more times; reads and searches are not counted."),
    advice: null,
  },
  approval_wait: {
    title: msg("Waited on approvals"),
    explanation: msg("Runs paused for approvals or answers."),
    advice: msg("Allow routine commands, or answer from the mobile app."),
  },
  delegate_wait: {
    title: msg("Waited on helpers"),
    explanation: msg("The chat sat idle while delegates or background commands ran."),
    advice: msg("Run independent work in parallel and keep working meanwhile."),
  },
  low_cache_reuse: {
    title: msg("Low prompt-cache reuse"),
    explanation: msg("Only {detail}% of input came from the prompt cache."),
    overview: msg("Little of the input came from the prompt cache."),
    advice: msg("Long gaps between runs let the cache expire; avoid switching models mid-chat."),
  },
  context_compacted: {
    title: msg("Context compacted"),
    explanation: msg("The context window filled up, so the agent went on from a summary."),
    advice: msg("Split long work into new chats or hand it off."),
  },
  context_pressure: {
    title: msg("Context nearly full"),
    explanation: msg("The context window reached {detail}% full."),
    overview: msg("The context window nearly filled up."),
    advice: msg("Split long work into new chats or hand it off."),
  },
  many_prompts: {
    title: msg("Lots of back-and-forth"),
    explanation: msg("The user sent 6 or more prompts; time waiting for the user counts."),
    advice: msg("A fuller first brief saves rounds."),
  },
  reopened: {
    title: msg("Reopened after settling"),
    explanation: msg("The chat was settled before its work was done."),
    advice: null,
  },
};

/** Findings whose detail is a plain fact worth showing next to the explanation. */
export const FINDING_DETAIL_LABELED: ReadonlySet<MonitoringFindingCode> = new Set([
  "run_failures",
  "slow_command",
  "repeated_command",
]);

const FINDING_DETAIL_INLINE: ReadonlySet<MonitoringFindingCode> = new Set([
  "low_cache_reuse",
  "context_pressure",
]);

const FIX_CHAT_FAILURE_MESSAGES: Readonly<
  Record<ReturnType<typeof fixChatFailureReason>, Message>
> = {
  "no-chats": msg("Those chats no longer show this weak point. Refresh and try again."),
  "auto-unsupported": msg(
    "That machine does not support quota-aware Auto. Choose a provider model in its settings, then try again.",
  ),
  "no-model": msg(
    "No provider account on that machine is signed in. Sign in to one, then try again.",
  ),
  "launch-failed": msg("The chat could not be started. Try again."),
  unauthorized: msg("This connection may not start chats on that machine."),
  offline: msg("Could not reach the machine that runs the chat."),
};

/** Why a fix chat did not start, from the failed command's cause. */
export function monitoringFixChatFailureMessage(cause: Cause.Cause<unknown>): string {
  return t(FIX_CHAT_FAILURE_MESSAGES[fixChatFailureReason(cause)]);
}

export const SEVERITY_LABEL: Readonly<Record<MonitoringFindingSeverity, Message>> = {
  high: msg("High"),
  medium: msg("Medium"),
  low: msg("Low"),
};

export interface BucketPresentation {
  readonly label: Message;
  readonly hint: Message;
  readonly color: string;
}

/** Fixed per bucket, so a color always means the same wait. Legend text carries identity too. */
export const TIME_BUCKET_PRESENTATION: Readonly<Record<TimeBucketKey, BucketPresentation>> = {
  agentMs: {
    label: msg("Model working"),
    hint: msg("A run was active and the model itself was working."),
    color: "#3b82f6",
  },
  commandMs: {
    label: msg("Commands running"),
    hint: msg("A run was active and a shell command was running."),
    color: "#14a38b",
  },
  toolMs: {
    label: msg("Tools running"),
    hint: msg("A run was active and another tool, such as search or a file read, was running."),
    color: "#7aa116",
  },
  approvalMs: {
    label: msg("Waiting on approvals"),
    hint: msg("A run was active and waited on an approval or a question to the user."),
    color: "#f59e0b",
  },
  queuedMs: {
    label: msg("Queued"),
    hint: msg("A run was requested and waited to start."),
    color: "#ea580c",
  },
  usageLimitMs: {
    label: msg("Usage limit"),
    hint: msg("No run was active because a usage limit stopped the chat."),
    color: "#dc2626",
  },
  delegateWaitMs: {
    label: msg("Waiting on helpers"),
    hint: msg("No run was active while delegates, commands or background tasks ran."),
    color: "#8b5cf6",
  },
  userResponseMs: {
    label: msg("Waiting for you"),
    hint: msg("No run was active until the user sent the next prompt."),
    color: "#ec4899",
  },
  idleMs: {
    label: msg("Idle"),
    hint: msg("No run was active for another reason, such as a timer or a scheduled wake."),
    color: "#a1a1aa",
  },
  settleTailMs: {
    label: msg("Before settling"),
    hint: msg("After the last run ended, until the chat was settled."),
    color: "#57534e",
  },
};

export const PHASE_LABEL: Readonly<Record<MonitoringCommandPhase, Message>> = {
  install: msg("Install"),
  build: msg("Build"),
  typecheck: msg("Typecheck"),
  lint: msg("Lint"),
  format: msg("Format"),
  test: msg("Test"),
  git: msg("Git"),
  ship: msg("Ship"),
  inspect: msg("Inspect"),
  run: msg("Run"),
  other: msg("Other"),
};

export const KIND_LABEL: Readonly<Record<MonitoringThreadKind, Message>> = {
  interactive: msg("Interactive"),
  scheduled: msg("Scheduled"),
  agent: msg("Started by an agent"),
  delegated: msg("Delegated"),
};

export const LANE_KIND_LABEL: Readonly<Record<MonitoringLaneKind, Message>> = {
  chat: msg("Chat"),
  subagent: msg("Subagent"),
  delegate: msg("Delegate"),
  command: msg("Command"),
  workflow: msg("Workflow"),
};

export const SEGMENT_STATUS_LABEL: Readonly<Record<MonitoringSegmentStatus, Message>> = {
  completed: msg("Completed"),
  failed: msg("Failed"),
  interrupted: msg("Interrupted"),
  cancelled: msg("Cancelled"),
  running: msg("Running"),
};

export interface MarkerPresentation {
  readonly label: Message;
  readonly color: string;
}

export const MARKER_PRESENTATION: Readonly<Record<MonitoringMarkerKind, MarkerPresentation>> = {
  user_prompt: { label: msg("Your prompt"), color: "#3b82f6" },
  automatic_prompt: { label: msg("Automatic prompt"), color: "#8b5cf6" },
  usage_limit: { label: msg("Usage limit"), color: "#dc2626" },
  failure: { label: msg("Failure"), color: "#be123c" },
  interrupt: { label: msg("Interrupted"), color: "#ea580c" },
  compaction: { label: msg("Context compacted"), color: "#0891b2" },
  handoff: { label: msg("Handoff"), color: "#0d9488" },
  steering_restart: { label: msg("Restarted to steer"), color: "#f59e0b" },
  retry: { label: msg("Retry"), color: "#a16207" },
};

/** Stable per model name, so a filter or a new chat never repaints the others. */
const MODEL_COLORS = [
  "#3b82f6",
  "#14a38b",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
  "#7aa116",
  "#0891b2",
  "#ea580c",
] as const;

export function modelColor(model: string | null): string {
  if (model === null || model === "") return "#a1a1aa";
  let hash = 0;
  for (const char of model) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return MODEL_COLORS[hash % MODEL_COLORS.length]!;
}

export function findingExplanation(finding: Pick<MonitoringFinding, "code" | "detail">): string {
  return t(FINDING_TEXT[finding.code].explanation, {
    detail: FINDING_DETAIL_INLINE.has(finding.code) ? (finding.detail ?? "") : "",
  });
}
