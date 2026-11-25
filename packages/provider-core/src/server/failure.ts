import {
  ORCHESTRATION_V2_PROMPT_NOT_SENT_FAILURE_CODE,
  OrchestrationV2ProviderFailure as ProviderFailureSchema,
} from "@t3tools/contracts";
import type {
  NodeId,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2ProviderRetry,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { redactSensitiveText, stripTerminalEscapes } from "@t3tools/shared/redaction";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";

import * as IdAllocator from "./IdAllocator.ts";
import type { ProviderAdapterFailureReason } from "./ProviderAdapter.ts";
import * as Schema from "effect/Schema";

export class ContextHandoffBudgetError extends Schema.TaggedError<ContextHandoffBudgetError>()(
  "ContextHandoffBudgetError",
  {},
) {
  override get message() {
    return "The request leaves too little context for a provider handoff. Shorten the request or use a larger-context model; the current request has not been truncated.";
  }
}

export class ContextHandoffBackgroundWorkError extends Schema.TaggedError<ContextHandoffBackgroundWorkError>()(
  "ContextHandoffBackgroundWorkError",
  {},
) {
  override get message() {
    return "The target provider still has background work running. Wait for it to finish or stop it before retrying the handoff.";
  }
}

/** The failure code of a turn a provider refused because this account's login cannot run the model. */
export const MODEL_NOT_SUPPORTED_FAILURE_CODE = "model_not_supported";

/** The words a model slug is matched by in a model-scoped hold: `gpt-6.2-astra` is `gpt_6_2_astra`. */
export function modelHoldScope(model: string): string {
  return model
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("_");
}

export const MAX_PROVIDER_FAILURE_MESSAGE_LENGTH = 4_096;
const MAX_PROVIDER_FAILURE_CODE_LENGTH = 128;

const isProviderFailure = Schema.is(ProviderFailureSchema);

const DEFAULT_PROVIDER_FAILURE_MESSAGE = "Provider turn failed.";

const PROVIDER_FAILURE_CATEGORIES: Partial<
  Record<string, { readonly summary: string; readonly guidance: string }>
> = {
  ProviderAdapterTurnStartError: {
    summary: "The provider could not start this turn",
    guidance: "Retry the turn; if it keeps failing, check the provider setup and server logs.",
  },
  ProviderAdapterEventStreamError: {
    summary: "The provider event stream closed unexpectedly",
    guidance: "Retry the turn; if it keeps failing, check the provider and server logs.",
  },
  ProviderAdapterOpenSessionError: {
    summary: "The provider session could not be opened",
    guidance: "Check that the provider is installed and signed in, then retry the turn.",
  },
  ProviderAdapterResumeThreadError: {
    summary: "The provider conversation could not be resumed",
    guidance: "Retry the turn; if it keeps failing, check the provider and server logs.",
  },
};

// codex_protocol::protocol::validate_thread_goal_objective
const CODEX_GOAL_VALIDATION_MESSAGE =
  /^goal objective must (?:not be empty|be at most \d{1,6} characters)$/u;

// codex_config::ConstraintError::InvalidValue for a managed requirements.toml or cloud policy.
const CODEX_ACCESS_REQUIREMENT_REJECTION =
  /invalid value for `(approval_policy|sandbox_mode)`: `([A-Za-z]{1,32})` is not in the allowed set /u;

const PROVIDER_FAILURE_REASONS: Record<ProviderAdapterFailureReason, string> = {
  previous_turn_active: "the previous turn is still running",
  attachment_unreadable: "an attachment could not be read",
};

/**
 * Walks a cause chain for curated text without reading arbitrary provider
 * defect text. `known` is the message of a domain error T3.CodeShip raised itself;
 * `category` is the generic message of the innermost provider wrapper seen.
 */
function curatedCauseMessages(cause: unknown): {
  readonly failure?: OrchestrationV2ProviderFailure;
  readonly known: string | undefined;
  readonly category: string | undefined;
} {
  const seen = new Set<unknown>();
  let category: (typeof PROVIDER_FAILURE_CATEGORIES)[string];
  let reason: string | undefined;
  const categoryMessage = () => {
    if (category === undefined) return undefined;
    return reason
      ? `${category.summary}: ${reason}. ${category.guidance}`
      : `${category.summary}. ${category.guidance}`;
  };
  for (let depth = 0; depth < 16 && cause != null && !seen.has(cause); depth++) {
    seen.add(cause);
    try {
      if (Cause.isCause(cause)) {
        cause = Cause.squash(cause);
        continue;
      }
      if (typeof cause !== "object") break;
      const tag = (cause as Record<string, unknown>)._tag;
      switch (tag) {
        case "ProviderAdapterOpenSessionError": {
          const failure = (cause as Record<string, unknown>).failure;
          if (isProviderFailure(failure))
            return { known: failure.message, category: categoryMessage(), failure };
          break;
        }
        case "ContextHandoffBudgetError":
          return { known: new ContextHandoffBudgetError().message, category: categoryMessage() };
        case "ContextHandoffBackgroundWorkError":
          return {
            known: new ContextHandoffBackgroundWorkError().message,
            category: categoryMessage(),
          };
        case "AcpModelSelectionError":
        // Setup errors carry text written for the user, never provider output.
        case "ProviderSetupError":
        case "ClaudeBackgroundWorkBlocksQueryReplacementError":
        case "ClaudeAppendSystemPromptFileError":
        case "ClaudeAppendSystemPromptMissingValueError":
        case "ClaudeUltracodeOverriddenError":
        case "ClaudeCodeStartupExitError":
        case "ClaudeTermsReviewRequiredError":
        case "ClaudeSettingsLaunchArgError":
        case "ClaudeProjectConfigRootError":
        case "ClaudeSettingsResolveError":
        case "ClaudeMcpRegistrationTimeoutError":
        case "ClaudeCodeRootRefusalError":
        case "CursorModelUnavailableError":
        case "CodexGoalObjectiveTooLongError":
        case "ProviderAdapterThreadInUseError":
        case "ProviderCompactionUnsupportedError":
          return { known: stringField(cause, "message"), category: categoryMessage() };
        case "CodexAppServerRequestError": {
          // Only Codex's fixed-shape goal validation and managed-requirements
          // text is actionable and safe to show; other request error text stays hidden.
          const rejection = stringField(cause, "message");
          if (
            (cause as Record<string, unknown>).method === "thread/goal/set" &&
            rejection !== undefined &&
            CODEX_GOAL_VALIDATION_MESSAGE.test(rejection)
          ) {
            return { known: `Codex rejected the goal: ${rejection}.`, category: categoryMessage() };
          }
          const access =
            rejection === undefined ? null : CODEX_ACCESS_REQUIREMENT_REJECTION.exec(rejection);
          if (access !== null) {
            return {
              known: `Codex's managed requirements do not allow \`${access[1]}\` \`${access[2]}\`, which this thread's access mode uses. Switch the thread to an access mode the policy allows.`,
              category: categoryMessage(),
            };
          }
          break;
        }
        case "AcpProcessExitedError": {
          const exit = `provider process exited${processExitStatus(cause)}`;
          const stage = category === undefined ? `The ${exit}` : `${category.summary}: the ${exit}`;
          return {
            known: `${stage}. Check the server logs for the provider's output, then retry the turn.`,
            category: categoryMessage(),
          };
        }
        case "ContextHandoffDeliveryUncertainError":
          return {
            known:
              "T3.CodeShip could not confirm whether conversation history reached the provider. Retry the turn to recover the session.",
            category: categoryMessage(),
          };
        case "ProviderAdapterProtocolError": {
          const typedReason = (cause as Record<string, unknown>).reason;
          if (
            category !== undefined &&
            typeof typedReason === "string" &&
            Object.hasOwn(PROVIDER_FAILURE_REASONS, typedReason)
          ) {
            reason ??= PROVIDER_FAILURE_REASONS[typedReason as ProviderAdapterFailureReason];
          }
          break;
        }
      }
      if (typeof tag === "string" && Object.hasOwn(PROVIDER_FAILURE_CATEGORIES, tag)) {
        category = PROVIDER_FAILURE_CATEGORIES[tag];
        reason = undefined;
      }
      cause = (cause as Record<string, unknown>).cause;
    } catch {
      break;
    }
  }
  return { known: undefined, category: categoryMessage() };
}

// Only the structured status; stderr and the spawner cause can carry provider output.
function processExitStatus(exited: object): string {
  const { signal, code } = exited as Record<string, unknown>;
  if (typeof signal === "string" && /^SIG[A-Z0-9]{1,16}$/u.test(signal)) {
    return ` after signal ${signal}`;
  }
  return typeof code === "number" && Number.isSafeInteger(code) ? ` with code ${code}` : "";
}

/**
 * The curated message of a domain error in a failure's cause chain, if any.
 * Callers that pass their own `message` to `makeProviderFailure` check it
 * first, so a known reason is not hidden behind a wrapper's text.
 */
export function knownProviderFailureMessage(cause: unknown): string | undefined {
  return curatedCauseMessages(cause).known;
}

function stringField(value: unknown, key: "message" | "code"): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function redactUrl(match: string): string {
  const trailing = /[),.;!?]+$/u.exec(match)?.[0] ?? "";
  const candidate = trailing.length === 0 ? match : match.slice(0, -trailing.length);
  try {
    const url = new URL(candidate);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.toString()}${trailing}`;
  } catch {
    return "[REDACTED_URL]";
  }
}

function replaceUnsafeControlCharacters(value: string): string {
  const sanitized: Array<string> = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized.push(
      codePoint <= 0x08 ||
        (codePoint >= 0x0b && codePoint <= 0x0c) ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        codePoint === 0x7f
        ? " "
        : character,
    );
  }
  return sanitized.join("");
}

function redactProviderFailureText(value: string): string {
  // URLs are rebuilt only after redaction, which finds user info by the URL's own `@`.
  return redactSensitiveText(replaceUnsafeControlCharacters(stripTerminalEscapes(value)))
    .replace(/\bhttps?:\/\/[^\s<>"']+/giu, redactUrl)
    .replace(/\b(Basic)\s+[^\s,;]+/giu, "$1 [REDACTED]")
    .replace(
      /(["'][\w-]*(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)["']\s*:\s*["'])[^"']*(["'])/giu,
      "$1[REDACTED]$2",
    )
    .replace(
      /((?<![\w-])[\w-]*(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .trim();
}

function boundedText(value: string, maxLength: number): string {
  const redacted = redactProviderFailureText(value);
  if (redacted.length <= maxLength) return redacted;
  let end = Math.max(0, maxLength - 1);
  const finalCodeUnit = redacted.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    end -= 1;
  }
  return `${redacted.slice(0, end)}…`;
}

// Socket and DNS failures, as Node, Rust and Go clients word them. A lost connection
// clears up on its own, so these turns resume once the network is back. TLS, certificate
// and proxy sign-in errors are left out: waiting does not fix them.
const CONNECTION_FAILURE_TEXT =
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ENETDOWN|ETIMEDOUT)\b|getaddrinfo|fetch failed|socket hang up|(?:socket|connection|connect) timed out|connection (?:reset|refused)|network is unreachable|error sending request/i;

/** The class of a provider-reported error: a lost connection, or the provider's own error. */
export function providerErrorClass(
  message: string | null | undefined,
): "transport_error" | "provider_error" {
  return message != null && CONNECTION_FAILURE_TEXT.test(message)
    ? "transport_error"
    : "provider_error";
}

export function makeProviderFailure(input: {
  readonly cause?: unknown;
  readonly message?: string | undefined;
  readonly code?: string | null | undefined;
  readonly class?: OrchestrationV2ProviderFailureClass;
  readonly retryable?: boolean | null;
  readonly resetAt?: string | null;
  readonly modelScope?: string | undefined;
}): OrchestrationV2ProviderFailure {
  const curated = curatedCauseMessages(input.cause);
  if (curated.failure !== undefined)
    return makeProviderFailure({ ...curated.failure, resetAt: curated.failure.resetAt ?? null });
  const rawMessage =
    input.message ?? curated.known ?? curated.category ?? DEFAULT_PROVIDER_FAILURE_MESSAGE;
  const message = boundedText(rawMessage, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
  const rawCode = input.code ?? stringField(input.cause, "code") ?? null;
  const code =
    rawCode === null ? null : boundedText(rawCode, MAX_PROVIDER_FAILURE_CODE_LENGTH) || null;

  return {
    class: input.class ?? "unknown",
    message: message || DEFAULT_PROVIDER_FAILURE_MESSAGE,
    code,
    retryable: input.retryable ?? null,
    ...(input.modelScope === undefined ? {} : { modelScope: input.modelScope }),
    ...(input.class === "usage_limit" &&
    input.resetAt != null &&
    Number.isFinite(Date.parse(input.resetAt))
      ? { resetAt: DateTime.formatIso(DateTime.makeUnsafe(input.resetAt)) }
      : {}),
  };
}

/** The agent did not start before it received the message, for a reason that waiting fixes. */
export function promptNotSentFailure(
  message: string,
  cause?: unknown,
): OrchestrationV2ProviderFailure {
  return makeProviderFailure({
    cause,
    message,
    class: "transport_error",
    code: ORCHESTRATION_V2_PROMPT_NOT_SENT_FAILURE_CODE,
    retryable: true,
  });
}

export function makeProviderFailureTurnItem(input: {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly nodeId: NodeId | null;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly itemOrdinal: number;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly retry?: OrchestrationV2ProviderRetry;
  readonly retryStartedAt?: DateTime.Utc;
  readonly occurredAt: DateTime.Utc;
}): Extract<OrchestrationV2TurnItem, { readonly type: "error" }> {
  return {
    id: IdAllocator.derive.turnItemFromProviderItem({
      driver: input.driver,
      nativeItemId: `terminal-failure:${input.providerTurnId}`,
    }),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.itemOrdinal,
    status: "failed",
    title: input.failure.class === "usage_limit" ? "Usage limit reached" : "Provider error",
    startedAt: input.retryStartedAt ?? input.occurredAt,
    completedAt: input.occurredAt,
    updatedAt: input.occurredAt,
    type: "error",
    failure: input.failure,
    ...(input.retry === undefined ? {} : { retry: input.retry }),
  };
}

/**
 * Longest a turn may stay in provider retries before the adapter stops it as
 * failed. Codex waits for the network without limit and a hung Claude request
 * can take many minutes per attempt, so counting attempts alone never ends them.
 */
export const PROVIDER_RETRY_BUDGET_MS = 10 * 60 * 1000;

export function makeProviderRetryTurnItem(input: {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly nodeId: NodeId | null;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly itemOrdinal: number;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly retry: OrchestrationV2ProviderRetry;
  readonly status: Extract<
    OrchestrationV2TurnItem["status"],
    "running" | "completed" | "failed" | "interrupted" | "cancelled"
  >;
  readonly startedAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}): Extract<OrchestrationV2TurnItem, { readonly type: "error" }> {
  const completed = input.status !== "running";
  let title = "Provider retry";
  if (input.status === "completed") {
    title = "Provider recovered";
  } else if (input.status === "failed") {
    title = input.failure.class === "usage_limit" ? "Usage limit reached" : "Provider error";
  } else if (input.status === "interrupted" || input.status === "cancelled") {
    title = "Provider retry stopped";
  }
  return {
    id: IdAllocator.derive.turnItemFromProviderItem({
      driver: input.driver,
      nativeItemId: `terminal-failure:${input.providerTurnId}`,
    }),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.itemOrdinal,
    status: input.status,
    title,
    startedAt: input.startedAt,
    completedAt: completed ? input.updatedAt : null,
    updatedAt: input.updatedAt,
    type: "error",
    failure: input.failure,
    retry: input.retry,
  };
}
