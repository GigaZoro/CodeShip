import { ANTIGRAVITY_DEFAULT_MODEL } from "@t3tools/contracts/model";
import type { OrchestrationV2ProviderCapabilities } from "@t3tools/contracts/orchestrationV2";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import type { ProviderSetupError } from "@t3tools/contracts/providerSetup";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { sleepAwake } from "@t3tools/shared/AwakeTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { pinnedSystemInstructionsKey } from "@t3tools/provider-core/server/orchestrationInstructions";
import { PULL_REQUEST_LINKING_INSTRUCTIONS } from "@t3tools/provider-core/server/runtimeInstructions";
import type { AntigravityAuth } from "../../provider/AntigravityAuth.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  antigravityAppendsSystemPrompt,
  antigravityPermissionMode,
  antigravityRuntimeModeForSessionMode,
  antigravitySessionMeta,
  applyAntigravityAcpModelSelection,
  buildAntigravityPrompt,
  type AntigravityAcpRuntimeInput,
} from "../../provider/acp/AntigravityAcpSupport.ts";
import {
  ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
  antigravitySubagentLaunches,
  describeAntigravitySubagentLaunches,
} from "../../provider/acp/AntigravityChildWork.ts";
import { readAntigravityClientTextFile } from "../../provider/acp/AntigravityClientFiles.ts";
import { watchAntigravityPromptOutcome } from "../../provider/acp/AntigravityTurnOutcome.ts";
import {
  antigravityApprovalOptions,
  antigravitySubagentOutput,
  classifyAntigravitySubagentToolCall,
  extractAntigravityUserInputQuestion,
  makeAntigravityReadRepair,
  makeAntigravityUserInputResponse,
  normalizeAntigravityToolCall,
} from "../../provider/acp/AntigravityProtocol.ts";
import {
  ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
  isAntigravitySignInRequiredError,
} from "../../provider/antigravityAuthSupport.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";

const ANTIGRAVITY_PROVIDER = ProviderDriverKind.make("antigravity");

/**
 * Maximum awake time an Antigravity prompt may wait with no stream progress before
 * aborting the stalled model request and retrying once within the same turn (well under
 * the ~55-minute backend 502 cutoff; AB#7688).
 */
export const ANTIGRAVITY_PROMPT_STALL_TIMEOUT = Duration.minutes(10);
const ANTIGRAVITY_PROMPT_STALL_MAX_RETRIES = 1;
export const ANTIGRAVITY_PROMPT_STALL_FAILURE_CODE = "model_request_stalled";

const ANTIGRAVITY_STALL_RETRY_PROMPT_TEXT =
  "Continue from where you left off. The previous model request stalled and was aborted.";

interface AntigravityPromptStallCause {
  readonly _tag: "AntigravityPromptStallCause";
  readonly idleTimeoutMs: number;
  readonly attempts: number;
  readonly partialUsage?: EffectAcpSchema.Usage | undefined;
}

function isAntigravityPromptStallCause(value: unknown): value is AntigravityPromptStallCause {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly _tag?: unknown })._tag === "AntigravityPromptStallCause"
  );
}

function extractAntigravityPromptStallCause(
  cause: unknown,
): AntigravityPromptStallCause | undefined {
  if (isAntigravityPromptStallCause(cause)) return cause;
  if (typeof cause === "object" && cause !== null && "cause" in cause) {
    const inner = (cause as { readonly cause?: unknown }).cause;
    if (isAntigravityPromptStallCause(inner)) return inner;
  }
  return undefined;
}

function formatAntigravityStallDuration(idleTimeoutMs: number): string {
  if (idleTimeoutMs >= 60_000 && idleTimeoutMs % 60_000 === 0) {
    const minutes = idleTimeoutMs / 60_000;
    return minutes === 1 ? "1 minute" : minutes + " minutes";
  }
  if (idleTimeoutMs >= 1_000 && idleTimeoutMs % 1_000 === 0) {
    const seconds = idleTimeoutMs / 1_000;
    return seconds === 1 ? "1 second" : seconds + " seconds";
  }
  return idleTimeoutMs + " ms";
}

function antigravityPromptStallMessage(stall: AntigravityPromptStallCause): string {
  const duration = formatAntigravityStallDuration(stall.idleTimeoutMs);
  return stall.attempts > 1
    ? "Antigravity model request stalled with no stream progress for " +
        duration +
        " (aborted and retried once)."
    : "Antigravity model request stalled with no stream progress for " + duration + ".";
}

function makeAntigravityPromptStallError(
  stall: AntigravityPromptStallCause,
): EffectAcpErrors.AcpTransportError {
  return new EffectAcpErrors.AcpTransportError({
    operation: "call-rpc",
    method: "session/prompt",
    detail: antigravityPromptStallMessage(stall),
    cause: stall,
  });
}

function sumOptionalTokens(
  first: number | null | undefined,
  second: number | null | undefined,
): number | undefined {
  if (first == null && second == null) return undefined;
  return (first ?? 0) + (second ?? 0);
}

function mergeAcpUsage(
  first: EffectAcpSchema.Usage | null | undefined,
  second: EffectAcpSchema.Usage | null | undefined,
): EffectAcpSchema.Usage | undefined {
  if (first == null) return second ?? undefined;
  if (second == null) return first;
  const cachedReadTokens = sumOptionalTokens(first.cachedReadTokens, second.cachedReadTokens);
  const cachedWriteTokens = sumOptionalTokens(first.cachedWriteTokens, second.cachedWriteTokens);
  const thoughtTokens = sumOptionalTokens(first.thoughtTokens, second.thoughtTokens);
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    totalTokens: first.totalTokens + second.totalTokens,
    ...(cachedReadTokens === undefined ? {} : { cachedReadTokens }),
    ...(cachedWriteTokens === undefined ? {} : { cachedWriteTokens }),
    ...(thoughtTokens === undefined ? {} : { thoughtTokens }),
  };
}

const AntigravityProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface AntigravityAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly selfInvocation: SelfInvocation;
  readonly makeRuntime: (
    input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner">,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError | ProviderSetupError,
    Scope.Scope
  >;
  readonly withProcess: AntigravityAuth["withProcess"];
  readonly defaultModel: Effect.Effect<string | undefined>;
  readonly onSessionStarted?: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onSessionEvent?: AcpAdapterV2Flavor["onSessionEvent"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  /** The agent's GEMINI_HOME. Its session logs show turns that ended on an upstream error. */
  readonly profileDirectory?: string;
  /** Override the idle-progress stall limit (defaults to `ANTIGRAVITY_PROMPT_STALL_TIMEOUT`). */
  readonly promptIdleTimeout?: Duration.Input;
}

/**
 * Native subagent tools report no child session ids, so children stay read-only.
 * Only permission prompts carry the launch; NativeChildWorkQuery matches their ids by this text.
 */
const extractAntigravitySubagentUpdate: NonNullable<AcpAdapterV2Flavor["extractSubagentUpdate"]> = (
  toolCall,
) => {
  if (classifyAntigravitySubagentToolCall(toolCall) !== "subagent") {
    return undefined;
  }
  const status =
    toolCall.status === "failed" ? "failed" : toolCall.status === "pending" ? "pending" : "running";
  const launches = antigravitySubagentLaunches(toolCall.data.rawInput);
  const launch = launches === undefined ? undefined : describeAntigravitySubagentLaunches(launches);
  return {
    nativeTaskId: toolCall.toolCallId,
    prompt:
      launch?.prompt ??
      antigravitySubagentOutput(toolCall) ??
      toolCall.detail ??
      toolCall.title ??
      ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
    title: launch?.title ?? ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
    model: null,
    status,
    childSessionId: null,
    result: status === "failed" ? (antigravitySubagentOutput(toolCall) ?? null) : null,
  };
};

export const ANTIGRAVITY_PINNED_SYSTEM_INSTRUCTIONS = {
  key: pinnedSystemInstructionsKey({ harness: "Antigravity" }),
  text: PULL_REQUEST_LINKING_INSTRUCTIONS,
};

interface AntigravityFlavorServices {
  readonly crypto: Crypto.Crypto;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly host: ProviderHost.ProviderHost["Service"];
}

export function makeAntigravityAcpAdapterFlavor(
  options: AntigravityAdapterV2Options & AntigravityFlavorServices,
): AcpAdapterV2Flavor {
  const { profileDirectory } = options;
  const idleTimeout = options.promptIdleTimeout ?? ANTIGRAVITY_PROMPT_STALL_TIMEOUT;
  const idleTimeoutMs = Math.max(1, Duration.toMillis(Duration.fromInputUnsafe(idleTimeout)));
  const antigravityClientFileRoots = (cwd: string | null) =>
    cwd === null ? [options.host.paths.attachmentsDir] : [cwd, options.host.paths.attachmentsDir];
  const makeRuntime = Effect.fn("AntigravityAdapterV2.makeRuntime")(
    function* (input: AcpAdapterV2RuntimeInput) {
      const scope = yield* Scope.fork(yield* Effect.scope);
      let stallAborting: AntigravityPromptStallCause | undefined;
      const runtime = yield* options
        .withProcess(
          Scope.close(scope, Exit.void),
          options.makeRuntime({
            ...input,
            ...(input.onTermination === undefined
              ? {}
              : {
                  onTermination: (error) =>
                    input.onTermination!(
                      stallAborting === undefined
                        ? error
                        : makeAntigravityPromptStallError(stallAborting),
                    ),
                }),
            clientFileReads: true,
            sessionSystemPromptAppend:
              input.pinnedSystemInstructions ?? PULL_REQUEST_LINKING_INSTRUCTIONS,
            additionalDirectories: [options.host.paths.attachmentsDir],
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, scope));
      // Repair keeps state across updates, so each runtime must have one session-update handler.
      const reads = makeAntigravityReadRepair();
      // Served reads are reported from the read handler, so they take turns with agent updates.
      const updates = yield* Semaphore.make(1);
      let projectUpdate: Parameters<typeof runtime.handleSessionUpdate>[0] | undefined;
      let progressEpoch = 0;
      let attemptMadeProgress = false;
      let pendingUserInputCount = 0;
      let userCancelled = false;
      let progressChanged = yield* Deferred.make<void>();
      const signalProgress = Effect.fn("AntigravityAdapterV2.signalProgress")(function* (
        countsAsAttemptProgress: boolean,
      ) {
        progressEpoch += 1;
        if (countsAsAttemptProgress) {
          attemptMadeProgress = true;
        }
        const previous = progressChanged;
        progressChanged = yield* Deferred.make<void>();
        yield* Deferred.succeed(previous, undefined).pipe(Effect.ignore);
      });
      const withUserInputPaused = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            pendingUserInputCount += 1;
          }).pipe(Effect.andThen(signalProgress(false))),
          () => effect,
          () =>
            Effect.sync(() => {
              pendingUserInputCount = Math.max(0, pendingUserInputCount - 1);
            }).pipe(Effect.andThen(signalProgress(false))),
        );
      const waitForIdleStall: Effect.Effect<void> = Effect.gen(function* () {
        while (true) {
          const gate = progressChanged;
          if (pendingUserInputCount > 0) {
            yield* Deferred.await(gate);
            continue;
          }
          const epoch = progressEpoch;
          const winner = yield* Effect.raceFirst(
            Deferred.await(gate).pipe(Effect.as("progress" as const)),
            sleepAwake(idleTimeout).pipe(Effect.as("stalled" as const)),
          );
          if (winner === "stalled" && progressEpoch === epoch && pendingUserInputCount === 0) {
            return;
          }
        }
      });
      return {
        ...runtime,
        handleRequestPermission: (handler) =>
          runtime.handleRequestPermission((request, context) =>
            withUserInputPaused(handler(request, context)),
          ),
        handleElicitation: (handler) =>
          runtime.handleElicitation((request, context) =>
            withUserInputPaused(handler(request, context)),
          ),
        handleMcpConnect: (handler) =>
          runtime.handleMcpConnect((request, context) =>
            signalProgress(true).pipe(
              Effect.andThen(handler(request, context)),
              Effect.ensuring(signalProgress(true)),
            ),
          ),
        handleMcpMessage: (handler) =>
          runtime.handleMcpMessage((request, context) =>
            signalProgress(true).pipe(
              Effect.andThen(handler(request, context)),
              Effect.ensuring(signalProgress(true)),
            ),
          ),
        handleReadTextFile: (handler) =>
          runtime.handleReadTextFile((request, context) =>
            signalProgress(true).pipe(
              Effect.andThen(handler(request, context)),
              Effect.onExit((exit) => {
                const served = reads.attempted(request.path, Exit.isSuccess(exit));
                const repair =
                  served === undefined || projectUpdate === undefined
                    ? Effect.void
                    : updates
                        .withPermit(
                          projectUpdate({
                            sessionId: served.sessionId,
                            update: {
                              sessionUpdate: "tool_call_update",
                              toolCallId: served.toolCallId,
                              status: "completed",
                            },
                          }),
                        )
                        .pipe(Effect.ignore);
                return repair.pipe(Effect.andThen(signalProgress(true)));
              }),
            ),
          ),
        cancel: Effect.sync(() => {
          userCancelled = true;
        }).pipe(Effect.andThen(runtime.cancel)),
        prompt: Effect.fn("AntigravityAdapterV2.prompt")(function* (payload, promptOptions) {
          userCancelled = false;
          stallAborting = undefined;
          let accumulatedUsage: EffectAcpSchema.Usage | undefined;
          let priorAttemptMadeProgress = false;
          for (let attempt = 0; attempt <= ANTIGRAVITY_PROMPT_STALL_MAX_RETRIES; attempt += 1) {
            reads.reset();
            attemptMadeProgress = false;
            progressChanged = yield* Deferred.make<void>();
            const attemptPayload =
              attempt === 0 || !priorAttemptMadeProgress
                ? payload
                : {
                    ...payload,
                    prompt: [{ type: "text" as const, text: ANTIGRAVITY_STALL_RETRY_PROMPT_TEXT }],
                  };
            const promptFiber = yield* runtime
              .prompt(attemptPayload, attempt === 0 ? promptOptions : undefined)
              .pipe(Effect.forkIn(scope));
            const watchdogFiber = yield* waitForIdleStall.pipe(Effect.forkIn(scope));
            const outcome = yield* Effect.raceFirst(
              Fiber.await(promptFiber).pipe(
                Effect.map((exit) => ({ _tag: "prompt" as const, exit })),
              ),
              Fiber.await(watchdogFiber).pipe(Effect.as({ _tag: "stalled" as const })),
            ).pipe(
              Effect.onInterrupt(() =>
                Fiber.interrupt(watchdogFiber).pipe(
                  Effect.ignore,
                  Effect.andThen(Fiber.interrupt(promptFiber).pipe(Effect.ignore)),
                ),
              ),
            );
            if (outcome._tag === "prompt") {
              yield* Fiber.interrupt(watchdogFiber).pipe(Effect.ignore);
              if (Exit.isFailure(outcome.exit)) {
                return yield* Effect.failCause(outcome.exit.cause);
              }
              accumulatedUsage = mergeAcpUsage(accumulatedUsage, outcome.exit.value.usage);
              return {
                ...outcome.exit.value,
                ...(accumulatedUsage === undefined ? {} : { usage: accumulatedUsage }),
              };
            }
            if (userCancelled) {
              const promptExit = yield* Fiber.await(promptFiber);
              if (Exit.isFailure(promptExit)) {
                return yield* Effect.failCause(promptExit.cause);
              }
              accumulatedUsage = mergeAcpUsage(accumulatedUsage, promptExit.value.usage);
              return {
                ...promptExit.value,
                ...(accumulatedUsage === undefined ? {} : { usage: accumulatedUsage }),
              };
            }
            priorAttemptMadeProgress = priorAttemptMadeProgress || attemptMadeProgress;
            const stallAttempt: AntigravityPromptStallCause = {
              _tag: "AntigravityPromptStallCause",
              idleTimeoutMs,
              attempts: attempt + 1,
              ...(accumulatedUsage === undefined ? {} : { partialUsage: accumulatedUsage }),
            };
            stallAborting = stallAttempt;
            const cancelExit = yield* Effect.exit(runtime.cancel);
            const promptExit = yield* Fiber.await(promptFiber);
            stallAborting = undefined;
            if (Exit.isSuccess(promptExit)) {
              accumulatedUsage = mergeAcpUsage(accumulatedUsage, promptExit.value.usage);
              if (promptExit.value.stopReason !== "cancelled") {
                return {
                  ...promptExit.value,
                  ...(accumulatedUsage === undefined ? {} : { usage: accumulatedUsage }),
                };
              }
            }
            if (userCancelled) {
              return {
                stopReason: "cancelled" as const,
                ...(accumulatedUsage === undefined ? {} : { usage: accumulatedUsage }),
              };
            }
            if (attempt < ANTIGRAVITY_PROMPT_STALL_MAX_RETRIES && Exit.isSuccess(cancelExit)) {
              yield* Effect.logWarning("orchestration-v2.antigravity-prompt-stalled-retrying", {
                idleTimeoutMs,
                attempt: attempt + 1,
                priorAttemptMadeProgress,
              });
              continue;
            }
            return yield* makeAntigravityPromptStallError({
              _tag: "AntigravityPromptStallCause",
              idleTimeoutMs,
              attempts: attempt + 1,
              ...(accumulatedUsage === undefined ? {} : { partialUsage: accumulatedUsage }),
            });
          }
          return yield* makeAntigravityPromptStallError({
            _tag: "AntigravityPromptStallCause",
            idleTimeoutMs,
            attempts: ANTIGRAVITY_PROMPT_STALL_MAX_RETRIES + 1,
            ...(accumulatedUsage === undefined ? {} : { partialUsage: accumulatedUsage }),
          });
        }),
        handleSessionUpdate: (handler) => {
          projectUpdate = handler;
          return runtime.handleSessionUpdate((notification) =>
            signalProgress(true).pipe(
              Effect.andThen(updates.withPermit(handler(reads.repair(notification)))),
            ),
          );
        },
        start: () =>
          runtime
            .start()
            .pipe(
              Effect.tap(
                (started) => options.onSessionStarted?.(started, input.cwd) ?? Effect.void,
              ),
            ),
      } satisfies typeof runtime;
    },
    Effect.provideService(Crypto.Crypto, options.crypto),
    Effect.mapError((cause): EffectAcpErrors.AcpError =>
      cause._tag === "ProviderSetupError"
        ? new EffectAcpErrors.AcpTransportError({ detail: cause.detail, cause })
        : cause,
    ),
  );

  return {
    driver: ANTIGRAVITY_PROVIDER,
    runtimeHarness: "Antigravity",
    capabilities: AntigravityProviderCapabilitiesV2,
    // Agents that advertise HTTP MCP skip the stdio bridge process; others keep stdio.
    mcpOverHttp: true,
    sessionCarriesPullRequestLinking: antigravityAppendsSystemPrompt,
    sessionSystemPrompt: {
      current: ANTIGRAVITY_PINNED_SYSTEM_INSTRUCTIONS,
      appliesTo: antigravityAppendsSystemPrompt,
      activationSessionMeta: (text) => (initializeResult) =>
        antigravitySessionMeta(initializeResult, text),
    },
    makeRuntime,
    buildPrompt: ({
      text,
      attachments,
      resolveAttachmentPath,
      promptCapabilities,
      agentVersion,
      currentModel,
    }) =>
      buildAntigravityPrompt({
        input: text,
        attachments,
        resolveAttachmentPath,
        promptCapabilities,
        agentVersion,
        currentModel,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, options.fileSystem),
        Effect.provideService(Path.Path, options.path),
      ),
    // Loading history replays tool calls; resume avoids replay.
    subagentsIdleOnTurnCompletion: true,
    ...(options.onSessionEvent === undefined ? {} : { onSessionEvent: options.onSessionEvent }),
    applyModelSelection: Effect.fn("AntigravityAdapterV2.applyModelSelection")(function* ({
      runtime,
      modelSelection,
    }) {
      const defaultModel = yield* options.defaultModel;
      return yield* applyAntigravityAcpModelSelection({
        runtime,
        model:
          modelSelection.model === ANTIGRAVITY_DEFAULT_MODEL ? undefined : modelSelection.model,
        defaultModel,
        mapError: (cause) => cause,
      });
    }),
    sessionModeForPolicy: (policy) => antigravityPermissionMode(policy.runtimeMode),
    runtimeModeForSessionMode: antigravityRuntimeModeForSessionMode,
    clientFileSystem: {
      readTextFile: (request, cwd) =>
        readAntigravityClientTextFile({
          fileSystem: options.fileSystem,
          path: options.path,
          allowedRoots: antigravityClientFileRoots(cwd),
          request,
        }),
    },
    approvalOptions: antigravityApprovalOptions,
    extractPermissionQuestion: (request) => {
      const question = extractAntigravityUserInputQuestion(request);
      if (question === undefined) return undefined;
      return {
        question,
        respond: (answers) => makeAntigravityUserInputResponse(request, answers),
      };
    },
    normalizeToolCall: normalizeAntigravityToolCall,
    extractSubagentUpdate: extractAntigravitySubagentUpdate,
    supportsImagePrompts: true,
    // ACP 1.3.0 treats /compact as ordinary model input.
    supportsCompaction: false,
    requiresSignIn: isAntigravitySignInRequiredError,
    signInRequiredMessage: ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
    // 1.4.5 returns the root trajectory's Gemini usageMetadata delta; 1.4.1 returns none.
    reportsPerTurnPromptUsage: true,
    geminiPromptUsage: true,
    promptFailure: (cause) => {
      const stall = extractAntigravityPromptStallCause(cause);
      if (stall === undefined) return undefined;
      return makeProviderFailure({
        class: "transport_error",
        code: ANTIGRAVITY_PROMPT_STALL_FAILURE_CODE,
        message: antigravityPromptStallMessage(stall),
        retryable: true,
      });
    },
    extractPromptFailureUsage: (cause) => extractAntigravityPromptStallCause(cause)?.partialUsage,
    restartRuntimeAfterPromptError: (cause) =>
      extractAntigravityPromptStallCause(cause) !== undefined,
    ...(profileDirectory === undefined
      ? {}
      : {
          watchPromptOutcome: Effect.fn("AntigravityAdapterV2.watchPromptOutcome")(function* (
            sessionId: string,
            model: string,
          ) {
            // The refused quota follows the model the default resolves to.
            const resolved =
              model === ANTIGRAVITY_DEFAULT_MODEL ? yield* options.defaultModel : undefined;
            return yield* watchAntigravityPromptOutcome(
              profileDirectory,
              sessionId,
              resolved ?? model,
            );
          }),
        }),
  };
}

export const makeAntigravityAdapterV2 = Effect.fn("makeAntigravityAdapterV2")(function* (
  options: AntigravityAdapterV2Options,
) {
  const services: AntigravityFlavorServices = {
    crypto: yield* Crypto.Crypto,
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
    host: yield* ProviderHost.ProviderHost,
  };
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeAntigravityAcpAdapterFlavor({ ...options, ...services }),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
  });
});
