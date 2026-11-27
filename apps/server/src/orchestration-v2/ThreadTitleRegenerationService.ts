import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { isAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";
import {
  AUTHENTICATION_FAILED_FAILURE_CODE,
  CommandId,
  OrchestrationV2ProviderFailure,
  ProviderSetupError,
  TextGenerationError,
  type ChatAttachment,
  type MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type RunId,
  type ServerSettingsError,
  type ThreadId,
} from "@t3tools/contracts";
import { MODEL_NOT_SUPPORTED_FAILURE_CODE } from "@t3tools/provider-core/server/failure";
import {
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
  isChatGptUsageLimitCode,
} from "@t3tools/shared/usageLimits";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { isChatGptTokenRevoked, isCodexLoginRejected } from "../provider/CodexLoginRejected.ts";
import { isNonRetryableCodexManagedError } from "../provider/CodexManagedErrors.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { TextGenerationAttribution } from "../textGeneration/TextGenerationUsage.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
export { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";

const isProviderFailure = Schema.is(OrchestrationV2ProviderFailure);
const isProviderSetupError = Schema.is(ProviderSetupError);
const isTextGenerationError = Schema.is(TextGenerationError);

const NON_RETRYABLE_ERROR_TAGS = new Set([
  "ThreadManagementProviderInstanceDisabledError",
  "ProviderInstanceNotFoundError",
  "CursorModelUnavailableError",
  "AcpModelSelectionError",
  "ClaudeTermsReviewRequiredError",
  "CommandPolicyCapabilityUnsupportedError",
]);

const NON_RETRYABLE_ERROR_NAMES = new Set([
  "RateLimitError",
  "AuthenticationError",
  "PermissionDeniedError",
  "UnauthorizedError",
]);

const NON_RETRYABLE_HTTP_STATUSES = new Set([401, 402, 403, 429]);

const WRAPPER_PREFIX_PATTERN =
  /^(?:(?:Text generation failed in [a-zA-Z0-9_]+|(?:Claude|Codex) CLI command failed):\s*)+/i;
const MCP_LINE_PATTERN = /\bMCP\b/u;
const WARNING_LINE_PATTERN = /^(?:warn(?:ing)?|info|debug)\s*:/i;

const NON_RETRYABLE_CODE_PATTERN =
  /(?:^|[^a-z0-9])(?:usage[\s_-]*limit|rate[\s_-]*limit|rate[\s_-]*limited|quota[\s_-]*(?:exceeded|exhausted)|insufficient[\s_-]*(?:quota|credits?)|resource[\s_-]*exhausted|credit[\s_-]*balance|billing[\s_-]*(?:hard[\s_-]*limit|error)|payment[\s_-]*required|authentication[\s_-]*(?:failed|error)|unauthenticated|unauthorized|invalid[\s_-]*(?:api[\s_-]*key|auth)|token[\s_-]*(?:expired|revoked)|permission[\s_-]*(?:denied|error)|forbidden|access[\s_-]*denied|account[\s_-]*(?:suspended|disabled)|model[\s_-]*not[\s_-]*supported)(?=$|[^a-z0-9])|\b(?:usageLimit|rateLimit)(?:Exceeded)?\b/i;

const NON_RETRYABLE_TEXT_PATTERN = new RegExp(
  [
    String.raw`(?:^|[^a-z])(?:usage|rate|spending|credit|billing)[\s_-]+limit(?:ed|ing|s|_exceeded)?(?=$|[^a-z])`,
    String.raw`\b(?:usageLimit|rateLimit)(?:Exceeded)?\b`,
    String.raw`\btoo\s+many\s+requests\b`,
    String.raw`\b(?:5-hour|weekly)\s+limit\s+reached\b`,
    String.raw`(?:\b(?:http|status(?:\s+code)?|unexpected\s+status|api\s+error)\b[\s:=(\[]*429\b|\[429\]|\b429\s+(?:too\s+many|rate[\s_-]?limit|quota|resource_exhausted)\b|^429$)`,
    String.raw`(?:^|[^a-z0-9])(?:insufficient[\s_]+quota|quota[\s_]+(?:exceeded|exhausted|limit|reached)|resource[\s_]+exhausted)(?=$|[^a-z0-9])`,
    String.raw`\bexceeded\s+(?:your\s+)?(?:current\s+)?quota\b`,
    String.raw`\byou(?:'ve|\s+have)\s+(?:hit|reached)\s+(?:your|the)\s+(?:[a-z0-9-]+\s+)?limit\b`,
    String.raw`\b(?:credit\s+balance\s+(?:is\s+)?too\s+low|insufficient[\s_]+credits?|out\s+of\s+credits?|no\s+credits?\s+(?:remaining|left)|billing[\s_]+(?:hard[\s_]+limit|error|required)|payment\s+required)\b`,
    String.raw`(?:^|[^a-z0-9])(?:authentication[\s_]+(?:failed|error|required)|unauthenticated|unauthorized|permission[\s_]+denied|access[\s_]+denied|forbidden|invalid[\s_]+(?:api[\s_]+key|x-api-key|bearer\s+token|credentials?|access[\s_]+token)|missing[\s_]+api[\s_]+key|token[\s_]+(?:expired|revoked))(?=$|[^a-z0-9])`,
    String.raw`\b(?:not\s+(?:authenticated|logged\s+in|signed\s+in)|signed\s+out|logged\s+out|sign\s+in\s+(?:again|with|before|to\s+continue)|log\s+in\s+again|re-?authenticate|api[\s_]+key\s+(?:is\s+)?(?:invalid|missing|expired|revoked|required)|oauth\s+token\s+(?:has\s+)?expired|rejected\s+this\s+account'?s\s+login|connection\s+was\s+revoked|claude\s+auth\s+login|your\s+organization\s+has\s+disabled\s+this\s+model)\b`,
    String.raw`(?:\b(?:http|status(?:\s+code)?|unexpected\s+status|api\s+error)\b[\s:=(\[]*(?:401|402|403)\b|\[(?:401|402|403)\]|\b(?:401\s+unauthorized|402\s+payment\s+required|403\s+forbidden)\b|^(?:401|402|403)$)`,
    String.raw`\b(?:no\s+provider\s+instance\s+registered|does\s+not\s+provide\s+application\s+text\s+generation|do\s+not\s+provide\s+application\s+text\s+generation|not\s+available\s+on\s+path|is\s+disabled\s+(?:in\s+t3\.codeship\s+settings|for\s+project)|(?:cursor|claude|codex|antigravity|grok|muse\s+code|opencode|pi|fx)\s+is\s+disabled)\b`,
  ].join("|"),
  "i",
);

const HTTP_STATUS_KEYS = ["status", "statusCode", "httpStatusCode", "api_error_status"] as const;
const CODE_KEYS = ["code", "type", "reason", "codexErrorInfo"] as const;
const TEXT_KEYS = ["detail", "message", "additionalDetails"] as const;

function isNonRetryableCode(code: string): boolean {
  return (
    code === AUTHENTICATION_FAILED_FAILURE_CODE ||
    code === MODEL_NOT_SUPPORTED_FAILURE_CODE ||
    isChatGptUsageLimitCode(code) ||
    code === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE ||
    NON_RETRYABLE_CODE_PATTERN.test(code)
  );
}

function isNonRetryableText(text: string): boolean {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return false;
  const normalized = firstLine.replace(WRAPPER_PREFIX_PATTERN, "").trim();
  if (
    normalized.length === 0 ||
    MCP_LINE_PATTERN.test(normalized) ||
    WARNING_LINE_PATTERN.test(normalized)
  ) {
    return false;
  }
  if (
    isNonRetryableCodexManagedError(normalized) ||
    isCodexLoginRejected({ message: normalized })
  ) {
    return true;
  }
  const sanitized = normalized.replace(/https?:\/\/\S+/gi, " ").replace(/`[^`]*`/g, " ");
  return NON_RETRYABLE_TEXT_PATTERN.test(sanitized);
}

function isNonRetryableProviderFailure(failure: OrchestrationV2ProviderFailure): boolean {
  if (
    failure.class === "usage_limit" ||
    failure.class === "permission_error" ||
    failure.class === "validation_error" ||
    failure.retryable === false
  ) {
    return true;
  }
  if (failure.retryable === true) {
    return false;
  }
  return (
    (failure.code !== null && isNonRetryableCode(failure.code)) ||
    isNonRetryableCodexManagedError(failure) ||
    isNonRetryableText(failure.message)
  );
}

function isNonRetryableStatus(value: unknown): boolean {
  if (typeof value === "number") return NON_RETRYABLE_HTTP_STATUSES.has(value);
  if (typeof value !== "string") return false;
  return /^\d{3}$/.test(value)
    ? NON_RETRYABLE_HTTP_STATUSES.has(Number(value))
    : isNonRetryableCode(value);
}

function isNonRetryableThreadTitleError(error: unknown): boolean {
  const stack: Array<unknown> = [error];
  const seen = new Set<unknown>();
  while (stack.length > 0 && seen.size < 32) {
    const current = stack.pop();
    if (current == null || seen.has(current)) continue;
    seen.add(current);
    if (Cause.isCause(current)) {
      if (current.reasons.length === 0) {
        stack.push(Cause.squash(current));
      } else {
        for (const reason of current.reasons) {
          if (Cause.isFailReason(reason)) {
            stack.push(reason.error);
          } else if (Cause.isDieReason(reason)) {
            stack.push(reason.defect);
          }
        }
      }
      continue;
    }
    if (typeof current === "string") {
      if (isNonRetryableText(current)) return true;
      continue;
    }
    if (typeof current !== "object") continue;
    if (isTextGenerationError(current) || isProviderSetupError(current)) {
      if (current.retryable === false) return true;
      if (current.retryable === true) continue;
    }
    if (isChatGptTokenRevoked(current)) return true;
    if (isProviderFailure(current)) {
      if (isNonRetryableProviderFailure(current)) return true;
      continue;
    }
    if (isNonRetryableCodexManagedError(current)) return true;

    const record = current as Record<string, unknown>;
    if (typeof record._tag === "string" && NON_RETRYABLE_ERROR_TAGS.has(record._tag)) return true;
    if (typeof record.name === "string" && NON_RETRYABLE_ERROR_NAMES.has(record.name)) return true;
    if (record.retryable === false) return true;
    if (HTTP_STATUS_KEYS.some((key) => isNonRetryableStatus(record[key]))) return true;
    if (
      CODE_KEYS.some((key) => typeof record[key] === "string" && isNonRetryableCode(record[key]))
    ) {
      return true;
    }
    if (
      TEXT_KEYS.some((key) => typeof record[key] === "string" && isNonRetryableText(record[key]))
    ) {
      return true;
    }

    if (record.cause !== undefined) stack.push(record.cause);
    if (record.error !== undefined) stack.push(record.error);
    if (record.failure !== undefined) stack.push(record.failure);
    if (typeof record.codexErrorInfo === "object" && record.codexErrorInfo !== null) {
      stack.push(record.codexErrorInfo, ...Object.values(record.codexErrorInfo));
    }
    if (Array.isArray(record.errors)) {
      stack.push(...record.errors.slice(0, 8));
    }
  }
  return false;
}

/** Retries only transient failures; limit, auth, and disabled-provider errors fail fast. */
export function isRetryableThreadTitleError(error: unknown): boolean {
  return !isNonRetryableThreadTitleError(error);
}

export class ThreadTitleRegenerationService extends Context.Service<
  ThreadTitleRegenerationService,
  {
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      readonly kind:
        | { readonly type: "initial"; readonly messageId: MessageId }
        | { readonly type: "regenerate" };
    }) => Effect.Effect<
      void,
      | OrchestratorV2Error
      | ProjectStore.ProjectStoreV2Error
      | ServerSettingsError
      | ThreadManagementService.ThreadManagementProviderInstanceDisabledError
    >;
  }
>()("t3/orchestration-v2/ThreadTitleRegenerationService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const complete = (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) =>
    threads
      .dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make(`${input.requestId}:title-complete`),
        threadId: input.threadId,
        requestId: input.requestId,
        ...(input.title === undefined ? {} : { title: input.title }),
      })
      .pipe(Effect.asVoid);

  const messagesThroughRun = Effect.fn("ThreadTitleRegenerationService.messagesThroughRun")(
    function* (threadId: ThreadId, runId: RunId) {
      const source = yield* threads.getThreadRecords(threadId, ["messages", "runs"], {
        messageRoles: ["user", "assistant"],
      });
      const ordinals = new Map(
        source.runs
          .filter((run) => run.status !== "rolled_back")
          .map((run) => [run.id, run.ordinal]),
      );
      const forkOrdinal = ordinals.get(runId) ?? -1;
      const messages = source.messages.filter((message) => {
        if (message.streaming) return false;
        if (message.runId === null) return source.thread.historyOrigin === "v1_import";
        return (ordinals.get(message.runId) ?? Infinity) <= forkOrdinal;
      });
      return { thread: source.thread, messages };
    },
  );

  // A fork starts with no messages of its own, so its subject lives in the history it inherited.
  const forkSource = Effect.fn("ThreadTitleRegenerationService.forkSource")(function* (
    thread: OrchestrationV2AppThread,
  ) {
    let title: string | undefined;
    const history: Array<ReadonlyArray<OrchestrationV2ConversationMessage>> = [];
    let forkedFrom = thread.forkedFrom;
    while (forkedFrom?.type === "run") {
      const source = yield* messagesThroughRun(forkedFrom.threadId, forkedFrom.runId);
      history.push(source.messages);
      title ??= source.thread.title;
      forkedFrom = source.thread.forkedFrom;
    }
    const context = formatThreadTitleContext(history.reverse().flat());
    return title === undefined || context.message.length === 0
      ? undefined
      : { title, history: context.message };
  });

  const execute: ThreadTitleRegenerationService["Service"]["execute"] = Effect.fn(
    "ThreadTitleRegenerationService.execute",
  )(function* (input) {
    const outcome:
      | { readonly type: "stale" }
      | { readonly type: "complete"; readonly title?: string } = yield* Effect.gen(function* () {
      const projection = yield* threads.getThreadRecords(
        input.threadId,
        ["messages"],
        input.kind.type === "initial"
          ? { messageIds: [input.kind.messageId] }
          : { messageRoles: ["user", "assistant"] },
      );
      if (projection.thread.titleRegeneration?.requestId !== input.requestId) {
        return { type: "stale" as const };
      }

      const project = yield* projects.get(projection.thread.projectId);
      if (Option.isNone(project)) {
        return { type: "complete" as const };
      }

      let context: {
        readonly message: string;
        readonly attachments: ReadonlyArray<ChatAttachment>;
      };
      const settledMessages = projection.messages.filter((message) => !message.streaming);
      // The title serves the work of the run it describes: the first message's, or the latest.
      let sourceRunId =
        settledMessages.findLast((message) => message.runId !== null)?.runId ?? undefined;
      if (input.kind.type === "initial") {
        const messageId = input.kind.messageId;
        const message = settledMessages.find((candidate) => candidate.id === messageId);
        sourceRunId = message?.runId ?? undefined;
        context =
          message === undefined
            ? { message: "", attachments: [] }
            : {
                message: isAttachmentOnlyBootstrapPrompt(message.text) ? "" : message.text,
                attachments: message.attachments,
              };
      } else {
        context = formatThreadTitleContext(settledMessages);
      }
      if (context.message.length === 0 && context.attachments.length === 0) {
        return { type: "complete" as const };
      }

      // A deleted source should not cost the fork its title.
      const inherited = yield* forkSource(projection.thread).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        projection.thread.projectId,
      ).settings;
      const demandId =
        sourceRunId === undefined
          ? null
          : yield* threads
              .getThreadRecords(input.threadId, ["runs"], { runIds: [sourceRunId] })
              .pipe(
                Effect.map((records) => records.runs[0]?.demandId ?? null),
                Effect.catch((cause) =>
                  Effect.logWarning(
                    "Could not read the titled run's demand; its title stays unattributed",
                    {
                      threadId: input.threadId,
                      cause,
                    },
                  ).pipe(Effect.as(null)),
                ),
              );
      const result = yield* textGeneration
        .generateThreadTitle({
          cwd: projection.thread.worktreePath ?? project.value.workspaceRoot,
          message: context.message,
          attachments: context.attachments,
          ...(input.kind.type === "regenerate" ? { previousTitle: projection.thread.title } : {}),
          ...(inherited === undefined ? {} : { forkSource: inherited }),
          instructions: settings.threadTitleInstructions,
          modelSelection: settings.textGenerationModelSelection,
        })
        .pipe(
          Effect.provideService(TextGenerationAttribution, {
            threadId: input.threadId,
            demandId,
          }),
        );
      const generatedTitle = result.title.trim();
      return generatedTitle === "New thread" ||
        (input.kind.type === "regenerate" && generatedTitle === projection.thread.title.trim())
        ? { type: "complete" as const }
        : { type: "complete" as const, title: result.title };
    }).pipe(
      Effect.retry({
        times: input.kind.type === "initial" ? 2 : 0,
        schedule: Schedule.exponential("2 seconds"),
        while: (error) => isRetryableThreadTitleError(error),
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Thread title generation failed", {
              threadId: input.threadId,
              requestId: input.requestId,
              cause,
            }).pipe(Effect.as({ type: "complete" as const })),
      ),
    );

    if (outcome.type === "stale") {
      return;
    }
    yield* complete({
      ...input,
      ...(outcome.title === undefined ? {} : { title: outcome.title }),
    });
  });

  return ThreadTitleRegenerationService.of({ execute });
});

export const layer = Layer.effect(ThreadTitleRegenerationService, make);
