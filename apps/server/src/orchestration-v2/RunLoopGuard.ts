import {
  DEFAULT_RUN_LOOP_GUARD_SETTINGS,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ProviderThreadId,
  type ProviderTurnId,
  type RunAttemptId,
  type RunLoopGuardSettings,
  type RunLoopRole,
  type RunLoopRoleLimit,
  type TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { compactDynamicToolOutput, toolOutputIndicatesFailure } from "@t3tools/shared/toolOutput";
import * as Predicate from "effect/Predicate";

export type RunLoopAbortReasonCode =
  | "turn_cap_exceeded"
  | "tool_call_cap_exceeded"
  | "thrash_circuit_breaker";

export interface RunLoopAbortDecision {
  readonly code: RunLoopAbortReasonCode;
  readonly role: RunLoopRole;
  readonly reason: string;
  readonly observedCount: number;
  readonly limit: number;
  readonly errorSignature?: string;
}

export interface RunLoopGuardState {
  readonly role: RunLoopRole;
  readonly settings: RunLoopGuardSettings;
  readonly limits: RunLoopRoleLimit;
  readonly seenRootTurnIds: Set<ProviderTurnId>;
  readonly completedRootTurnIds: Set<ProviderTurnId>;
  readonly seenToolCallIds: Set<TurnItemId>;
  readonly settledToolCallIds: Set<TurnItemId>;
  lastErrorSignature: string | null;
  consecutiveErrorCount: number;
  abortedDecision: RunLoopAbortDecision | null;
}

const COUNTED_TOOL_CALL_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "web_search",
  "subagent",
]);

const MAX_OUTPUT_SCAN_CHARS = 32_768;
const MAX_SIGNATURE_DETAIL_CHARS = 200;
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*[A-Za-z]`, "g");
const ISO_TIMESTAMP_RE =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/gi;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const TIME_OF_DAY_RE = /\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const UNIX_TMP_PATH_RE = /(?:\/private)?\/(?:tmp|var\/folders|dev\/shm)\/[^\s:'"`)\]]+/gi;
const WINDOWS_TMP_PATH_RE =
  /[A-Za-z]:\\(?:Users\\[^\\]+\\AppData\\Local\\Temp|Windows\\Temp)\\[^\s:'"`)\]]+/gi;
const GENERIC_TMP_TOKEN_RE = /\btmp[-_][a-z0-9_-]{3,}\b/gi;
const PID_RE = /\b(pid|process)\s*[:=#]?\s*\d+\b/gi;
const DURATION_RE = /\b\d+(?:\.\d+)?\s*(?:ms|ns|us|µs|s)\b/gi;
const HEX_ADDR_RE = /\b0x[0-9a-f]+\b/gi;
const LONG_HEX_HASH_RE = /\b[0-9a-f]{12,}\b/gi;

export function resolveRunLoopRole(input: {
  readonly appThread: Pick<OrchestrationV2AppThread, "lineage"> & {
    readonly delegatedFrom?: OrchestrationV2AppThread["delegatedFrom"];
  };
  readonly run: Pick<OrchestrationV2Run, "delegatedTaskId">;
  readonly message: Pick<
    ProviderAdapter.ProviderAdapterV2TurnMessage,
    "createdBy" | "scheduledTaskId"
  >;
}): RunLoopRole {
  if (input.message.scheduledTaskId !== undefined) {
    return "scheduled";
  }
  if (input.message.createdBy === "system") {
    return "maintenance";
  }
  if (
    input.appThread.lineage.relationshipToParent === "subagent" ||
    input.appThread.delegatedFrom !== undefined ||
    input.run.delegatedTaskId !== undefined ||
    input.message.createdBy === "agent"
  ) {
    return "delegated";
  }
  return "interactive";
}

export function resolveRunLoopLimits(
  settings: RunLoopGuardSettings | undefined,
  role: RunLoopRole,
): { readonly settings: RunLoopGuardSettings; readonly limits: RunLoopRoleLimit } {
  const effective = settings ?? DEFAULT_RUN_LOOP_GUARD_SETTINGS;
  return {
    settings: effective,
    limits: effective.limits[role],
  };
}

export function makeRunLoopGuardState(input: {
  readonly role: RunLoopRole;
  readonly settings?: RunLoopGuardSettings;
}): RunLoopGuardState {
  const resolved = resolveRunLoopLimits(input.settings, input.role);
  return {
    role: input.role,
    settings: resolved.settings,
    limits: resolved.limits,
    seenRootTurnIds: new Set(),
    completedRootTurnIds: new Set(),
    seenToolCallIds: new Set(),
    settledToolCallIds: new Set(),
    lastErrorSignature: null,
    consecutiveErrorCount: 0,
    abortedDecision: null,
  };
}

function nonEmptyTrimmed(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function normalizeToolErrorDetail(raw: string): string {
  const normalized = raw
    .slice(0, 4_096)
    .replace(ANSI_ESCAPE_RE, "")
    .replace(ISO_TIMESTAMP_RE, "<ts>")
    .replace(ISO_DATE_RE, "<date>")
    .replace(TIME_OF_DAY_RE, "<time>")
    .replace(UUID_RE, "<uuid>")
    .replace(UNIX_TMP_PATH_RE, "<tmp>")
    .replace(WINDOWS_TMP_PATH_RE, "<tmp>")
    .replace(GENERIC_TMP_TOKEN_RE, "<tmp>")
    .replace(PID_RE, "$1 <pid>")
    .replace(DURATION_RE, "<dur>")
    .replace(HEX_ADDR_RE, "<hex>")
    .replace(LONG_HEX_HASH_RE, "<hash>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (normalized.length <= MAX_SIGNATURE_DETAIL_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_SIGNATURE_DETAIL_CHARS - 3)}...`;
}

function formatErrorSignature(prefix: string, detail: string): string {
  const normalizedDetail = normalizeToolErrorDetail(detail);
  return normalizedDetail.length === 0 ? prefix : `${prefix}: ${normalizedDetail}`;
}

function collectDynamicToolErrorText(
  value: unknown,
  state: { hasErrorTag: boolean; remainingNodes: number },
): string | undefined {
  if (state.remainingNodes-- <= 0 || value == null) return undefined;
  if (typeof value === "string") {
    const trimmed = nonEmptyTrimmed(value);
    if (trimmed === undefined) return undefined;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return collectDynamicToolErrorText(JSON.parse(trimmed) as unknown, state) ?? trimmed;
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = collectDynamicToolErrorText(entry, state);
      if (text !== undefined) return text;
    }
    return undefined;
  }
  if (!Predicate.isObject(value)) return undefined;
  const tag = typeof value._tag === "string" ? value._tag : undefined;
  if (
    value.isError === true ||
    value.is_error === true ||
    value.error != null ||
    (tag !== undefined && /Error$|Failure$/.test(tag))
  ) {
    state.hasErrorTag = true;
  }
  for (const key of ["error", "message", "reason", "detail", "text"] as const) {
    const candidate = collectDynamicToolErrorText(value[key], state);
    if (candidate !== undefined) return candidate;
  }
  for (const key of ["structuredContent", "content"] as const) {
    if (value[key] !== undefined) {
      const candidate = collectDynamicToolErrorText(value[key], state);
      if (candidate !== undefined) return candidate;
    }
  }
  return tag;
}

export function extractToolItemErrorSignature(item: OrchestrationV2TurnItem): string | undefined {
  switch (item.type) {
    case "command_execution": {
      const outputHead = item.output?.slice(0, MAX_OUTPUT_SCAN_CHARS);
      const failed =
        item.status === "failed" ||
        item.outputIndicatesFailure === true ||
        (item.exitCode !== undefined && item.exitCode !== 0) ||
        (item.exitCode === undefined &&
          outputHead !== undefined &&
          toolOutputIndicatesFailure(outputHead));
      if (!failed) return undefined;
      const prefix =
        item.exitCode !== undefined && item.exitCode !== 0
          ? `command_execution(exit=${item.exitCode})`
          : "command_execution";
      const detail =
        nonEmptyTrimmed(outputHead) ??
        nonEmptyTrimmed(item.title) ??
        nonEmptyTrimmed(item.input) ??
        "command failed";
      return formatErrorSignature(prefix, detail);
    }
    case "dynamic_tool": {
      const compact = item.output === undefined ? undefined : compactDynamicToolOutput(item.output);
      const scanState = { hasErrorTag: false, remainingNodes: 64 };
      const extractedText = collectDynamicToolErrorText(item.output, scanState);
      const failed = item.status === "failed" || compact?.isError === true || scanState.hasErrorTag;
      if (!failed) return undefined;
      const toolLabel = nonEmptyTrimmed(item.toolName) ?? "unknown";
      const detail = extractedText ?? nonEmptyTrimmed(item.title) ?? "tool failed";
      return formatErrorSignature(`dynamic_tool(${toolLabel.toLowerCase()})`, detail);
    }
    case "file_change": {
      if (item.status !== "failed") return undefined;
      return formatErrorSignature("file_change", nonEmptyTrimmed(item.title) ?? item.fileName);
    }
    case "file_search": {
      if (item.status !== "failed") return undefined;
      return formatErrorSignature(
        "file_search",
        nonEmptyTrimmed(item.title) ?? nonEmptyTrimmed(item.pattern) ?? "file search failed",
      );
    }
    case "web_search": {
      if (item.status !== "failed") return undefined;
      const patterns = nonEmptyTrimmed(item.patterns?.join(" "));
      return formatErrorSignature(
        "web_search",
        nonEmptyTrimmed(item.title) ?? patterns ?? "web search failed",
      );
    }
    case "subagent": {
      if (item.status !== "failed") return undefined;
      return formatErrorSignature(
        "subagent",
        nonEmptyTrimmed(item.result) ??
          nonEmptyTrimmed(item.progress) ??
          nonEmptyTrimmed(item.title) ??
          "subagent failed",
      );
    }
    default:
      return undefined;
  }
}

function recordAbort(
  state: RunLoopGuardState,
  decision: RunLoopAbortDecision,
): RunLoopAbortDecision {
  state.abortedDecision = decision;
  return decision;
}

export function stepRunLoopGuard(
  state: RunLoopGuardState,
  input: {
    readonly event: ProviderAdapter.ProviderAdapterV2Event;
    readonly attemptId: RunAttemptId;
    readonly rootProviderThreadId: ProviderThreadId;
  },
): RunLoopAbortDecision | null {
  if (!state.settings.enabled || state.abortedDecision !== null) {
    return null;
  }

  const { event } = input;

  if (event.type === "provider_turn.updated") {
    const isRootTurn =
      event.providerTurn.runAttemptId === input.attemptId ||
      event.providerTurn.providerThreadId === input.rootProviderThreadId;
    if (!isRootTurn) {
      return null;
    }

    if (!state.seenRootTurnIds.has(event.providerTurn.id)) {
      state.seenRootTurnIds.add(event.providerTurn.id);
      if (state.settings.enabled && state.seenRootTurnIds.size > state.limits.maxTurns) {
        return recordAbort(state, {
          code: "turn_cap_exceeded",
          role: state.role,
          observedCount: state.seenRootTurnIds.size,
          limit: state.limits.maxTurns,
          reason: `Run aborted by loop guard (${state.role} turn cap: ${state.seenRootTurnIds.size}/${state.limits.maxTurns} turns).`,
        });
      }
    }

    if (
      event.providerTurn.status === "completed" &&
      !state.completedRootTurnIds.has(event.providerTurn.id)
    ) {
      state.completedRootTurnIds.add(event.providerTurn.id);
      state.lastErrorSignature = null;
      state.consecutiveErrorCount = 0;
    }
    return null;
  }

  if (event.type !== "turn_item.updated") {
    return null;
  }

  const item = event.turnItem;
  if (!COUNTED_TOOL_CALL_TYPES.has(item.type)) {
    return null;
  }

  if (!state.seenToolCallIds.has(item.id)) {
    state.seenToolCallIds.add(item.id);
    if (state.settings.enabled && state.seenToolCallIds.size > state.limits.maxToolCalls) {
      return recordAbort(state, {
        code: "tool_call_cap_exceeded",
        role: state.role,
        observedCount: state.seenToolCallIds.size,
        limit: state.limits.maxToolCalls,
        reason: `Run aborted by loop guard (${state.role} tool-call cap: ${state.seenToolCallIds.size}/${state.limits.maxToolCalls} tool calls).`,
      });
    }
  }

  if (item.status !== "completed" && item.status !== "failed") {
    return null;
  }
  if (state.settledToolCallIds.has(item.id)) {
    return null;
  }
  state.settledToolCallIds.add(item.id);

  const errorSignature = extractToolItemErrorSignature(item);
  if (errorSignature !== undefined) {
    if (state.lastErrorSignature === errorSignature) {
      state.consecutiveErrorCount += 1;
    } else {
      state.lastErrorSignature = errorSignature;
      state.consecutiveErrorCount = 1;
    }
    if (
      state.settings.thrashBreakerEnabled &&
      state.consecutiveErrorCount >= state.settings.identicalErrorThreshold
    ) {
      return recordAbort(state, {
        code: "thrash_circuit_breaker",
        role: state.role,
        observedCount: state.consecutiveErrorCount,
        limit: state.settings.identicalErrorThreshold,
        errorSignature,
        reason: `Run aborted by thrash circuit breaker (${state.role} hit ${state.consecutiveErrorCount} consecutive identical tool errors: ${errorSignature}).`,
      });
    }
    return null;
  }

  state.lastErrorSignature = null;
  state.consecutiveErrorCount = 0;
  return null;
}
