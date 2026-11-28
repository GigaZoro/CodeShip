import { TokenPricing } from "../usage/TokenPricing.ts";
import {
  claudeProjectConfigRoot,
  claudeSettingSources,
  readClaudeSettingsCascade,
} from "../provider/Drivers/ClaudeSettingsCascade.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { type ClaudeSettings, TextGenerationError } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { deepMerge } from "@t3tools/shared/Struct";

import { ApiCreditBalance } from "../provider/ApiCreditBalance.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import {
  normalizeCliError,
  toJsonSchemaObject,
} from "@t3tools/provider-core/server/textGenerationUtils";
import { compileClaudeModelSelection, withClaudeSelectionSettings } from "../claudeModelOptions.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeModelCatalog,
  resolveClaudeModelSlug,
  scopeClaudeModelCatalog,
} from "../provider/ClaudeModelCatalog.ts";
import {
  hasClaudeManagedMcpConfig,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
  validateClaudeBillingSettings,
} from "../provider/Drivers/ClaudeHome.ts";
import { readClaudeUserSettings } from "../provider/Drivers/ClaudeSkills.ts";
import { readClaudeLaunchArgSettings } from "../provider/Drivers/ClaudeSettingsCascade.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import {
  nonNegativeCount,
  type TextGenerationCallUsage,
  TextGenerationUsageSink,
  unknownCallUsage,
} from "./TextGenerationUsage.ts";

const CLAUDE_TIMEOUT_MS = 180_000;
/** `--tools` takes bare names; patterns go in the allow list. */
const CLAUDE_INVESTIGATION_TOOLS = "Read,Grep,Glob,Bash";
/** In dontAsk mode every call outside this list, Bash included, is refused; investigationSettings keeps settings from adding to it. */
const CLAUDE_INVESTIGATION_ALLOWED = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
].join(",");
// Denies override allows; block git --output/-o because allowed trailing args can otherwise write anywhere.
const CLAUDE_INVESTIGATION_DENIED = ["Bash(git * --output*)", "Bash(git * -o *)"].join(",");

// --safe-mode keeps the account's CLAUDE.md, skills and plugins (about 23k tokens) out of one-shot calls.
// Claude versions that predate a flag exit with the stderr line "error: unknown option '<flag>'"; those runs retry without it.
const OPTIONAL_CLAUDE_FLAGS = ["--safe-mode", "--no-session-persistence"];
/**
 * Settings for an investigation, which runs with `--setting-sources ""`: the user's settings file
 * and the launch argument's settings as Claude Code would merge them, keeping from `permissions`
 * only the deny rules. Allow rules, extra directories and a default mode would approve calls
 * beyond the investigation's own list.
 */
function investigationSettings(
  userSettings: Record<string, unknown> | undefined,
  launchArgSettings: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const { permissions: _, ...settings } = deepMerge(userSettings ?? {}, launchArgSettings ?? {});
  const deny = [userSettings, launchArgSettings].flatMap((source) => {
    const permissions = source?.permissions;
    return Predicate.isObject(permissions) && Array.isArray(permissions.deny)
      ? permissions.deny
      : [];
  });
  return deny.length > 0 ? { ...settings, permissions: { deny: [...new Set(deny)] } } : settings;
}

// Only a rejection of images as such marks a model text-only, not a size or count limit.
const IMAGES_UNSUPPORTED =
  /image[^\n]*(?:not support|unsupported)|(?:not support|unsupported)[^\n]*image/i;

const ClaudeOutputEnvelope = Schema.Struct({
  structured_output: Schema.Unknown,
});
const ClaudeOutputMessage = Schema.Struct({
  type: Schema.String,
  structured_output: Schema.optionalKey(Schema.Unknown),
});
const isClaudeOutputEnvelope = Schema.is(ClaudeOutputEnvelope);

const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeClaudeOutput = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Union([ClaudeOutputEnvelope, Schema.Array(ClaudeOutputMessage)])),
);

const ClaudeModelUsage = Schema.Record(
  Schema.String,
  Schema.Struct({
    inputTokens: Schema.Number,
    outputTokens: Schema.Number,
    cacheReadInputTokens: Schema.Number,
    cacheCreationInputTokens: Schema.Number,
  }),
);
const decodeModelUsage = Schema.decodeUnknownOption(ClaudeModelUsage);
// Only `success` results carry `result`; error subtypes such as
// error_max_structured_output_retries report through `errors` instead.
const ClaudeErrorResult = Schema.Struct({
  is_error: Schema.Literal(true),
  result: Schema.optionalKey(Schema.String),
  errors: Schema.optionalKey(Schema.Array(Schema.String)),
});
const isClaudeErrorResult = Schema.is(ClaudeErrorResult);
const decodeJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const NON_RETRYABLE_CLAUDE_STATUSES = new Set([401, 402, 403, 429]);
const NON_RETRYABLE_CLAUDE_ERROR_CODES = new Set([
  "rate_limit",
  "authentication_failed",
  "billing_error",
  "invalid_request",
]);
const NON_RETRYABLE_CLAUDE_RESULT_PATTERN =
  /\b(?:5-hour\s+limit\s+reached|weekly\s+limit\s+reached|your\s+organization\s+has\s+disabled\s+this\s+model|invalid\s+bearer\s+token|claude\s+auth\s+login|credit\s+balance\s+(?:is\s+)?too\s+low|usage\s+limit|rate\s+limit(?:ed)?|too\s+many\s+requests|you(?:'ve|\s+have)\s+(?:hit|reached)\s+(?:your|the)\s+(?:[a-z0-9-]+\s+)?limit|authentication[\s_]+(?:failed|error)|not\s+logged\s+in|signed\s+out|logged\s+out|invalid\s+(?:api[\s_]+key|x-api-key)|api\s+error:\s*(?:401|402|403|429)|http\s+(?:401|402|403|429)|(?:401\s+unauthorized|402\s+payment\s+required|403\s+forbidden|429\s+too\s+many\s+requests))\b/i;

function hasNonRetryableClaudeEnvelope(messages: ReadonlyArray<unknown>): boolean {
  return messages.some((message) => {
    if (typeof message !== "object" || message === null) return false;
    const status = Reflect.get(message, "api_error_status");
    if (typeof status === "number" && NON_RETRYABLE_CLAUDE_STATUSES.has(status)) {
      return true;
    }
    const errorCode = Reflect.get(message, "error");
    return typeof errorCode === "string" && NON_RETRYABLE_CLAUDE_ERROR_CODES.has(errorCode);
  });
}

// Claude reports JSON errors on stdout; stderr may contain only wrapper notices.
function claudeErrorResult(
  stdout: string,
): { readonly detail: string; readonly retryable?: false } | undefined {
  const output = Option.getOrUndefined(decodeJsonOption(stdout));
  const messages: ReadonlyArray<unknown> = Array.isArray(output) ? output : [output];
  const detail = messages
    .filter(isClaudeErrorResult)
    .map((message) =>
      (
        message.result ??
        // error_during_execution mixes CLI telemetry into the list.
        message.errors?.filter((error) => !error.startsWith("[ede_diagnostic]")).join("\n") ??
        ""
      ).trim(),
    )
    .findLast((result) => result.length > 0);
  if (detail === undefined) return undefined;
  const nonRetryable =
    hasNonRetryableClaudeEnvelope(messages) || NON_RETRYABLE_CLAUDE_RESULT_PATTERN.test(detail);
  return nonRetryable ? { detail, retryable: false } : { detail };
}

const sumKnown = (counts: ReadonlyArray<number | null>): number | null =>
  counts.some((count) => count === null)
    ? null
    : counts.reduce<number>((sum, count) => sum + (count ?? 0), 0);

function callUsage(
  model: string,
  input: unknown,
  cacheRead: unknown,
  cacheWrite: unknown,
  output: unknown,
): TextGenerationCallUsage {
  const cacheReadTokens = nonNegativeCount(cacheRead);
  const cacheWriteTokens = nonNegativeCount(cacheWrite);
  return {
    model,
    inputTokens: sumKnown([nonNegativeCount(input), cacheReadTokens, cacheWriteTokens]),
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: nonNegativeCount(output),
  };
}

/** Per-model usage of one CLI call, read from its result message; unknown when it printed none. */
function claudeCallUsage(
  stdout: string,
  apiModelId: string,
): ReadonlyArray<TextGenerationCallUsage> {
  const output = Option.getOrUndefined(decodeJsonOption(stdout.trim()));
  const messages: ReadonlyArray<unknown> = Array.isArray(output) ? output : [output];
  const result = messages.findLast(
    (message): message is Record<string, unknown> =>
      typeof message === "object" &&
      message !== null &&
      (message as Record<string, unknown>).type === "result",
  );
  const modelUsage = result?.modelUsage;
  if (typeof modelUsage === "object" && modelUsage !== null && Object.keys(modelUsage).length > 0) {
    return Object.entries(modelUsage as Record<string, unknown>).map(([model, entry]) => {
      const fields = (entry ?? {}) as Record<string, unknown>;
      return callUsage(
        model,
        fields.inputTokens,
        fields.cacheReadInputTokens,
        fields.cacheCreationInputTokens,
        fields.outputTokens,
      );
    });
  }
  const usage = result?.usage;
  if (typeof usage !== "object" || usage === null) return [unknownCallUsage(apiModelId)];
  const fields = usage as Record<string, unknown>;
  return [
    callUsage(
      apiModelId,
      fields.input_tokens,
      fields.cache_read_input_tokens,
      fields.cache_creation_input_tokens,
      fields.output_tokens,
    ),
  ];
}

export const makeClaudeTextGeneration = Effect.fn("makeClaudeTextGeneration")(function* (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  modelCatalog: Effect.Effect<ClaudeModelCatalog> = Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG),
  routeModelCatalog: (
    catalog: ClaudeModelCatalog,
    cwd: string,
  ) => Effect.Effect<ClaudeModelCatalog> = Effect.succeed,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const scopedModelCatalog = modelCatalog.pipe(
    Effect.map((catalog) => scopeClaudeModelCatalog(catalog, claudeSettings.customModels)),
  );
  // Models that failed with images and then succeeded without them; later runs skip the image attempt.
  const textOnlyModels = new Set<string>();

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("claude", operation, cause, "Failed to collect process output"),
      ),
    );

  const encodeJsonForOperation = (
    operation: TextGenerationOperations.Operation,
    value: unknown,
    detail: string,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail,
            cause,
          }),
      ),
    );

  const readImageBlocks = Effect.fn("readImageBlocks")(function* (
    attachments: TextGenerationOperations.Request<Schema.Top>["attachments"],
  ) {
    const blocks: Array<{
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }> = [];
    for (const attachment of attachments ?? []) {
      if (attachment.type !== "image") continue;
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) continue;
      const bytes = yield* fileSystem
        .readFile(attachmentPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!bytes) continue;
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mimeType,
          data: Buffer.from(bytes).toString("base64"),
        },
      });
    }
    return blocks;
  });

  const runClaudeJson = Effect.fn("runClaudeJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema: outputSchemaJson,
    modelSelection,
    investigate,
    attachments,
  }: TextGenerationOperations.Request<S>): Effect.fn.Return<
    S["Type"],
    TextGenerationError,
    S["DecodingServices"] | Scope.Scope
  > {
    const reportUsage = yield* TextGenerationUsageSink;
    const balances = yield* Effect.serviceOption(ApiCreditBalance);
    const pricing = yield* Effect.serviceOption(TokenPricing);
    const paid = claudeSettings.billingKind === "payPerUse";
    if (paid && Option.isNone(balances))
      return yield* new TextGenerationError({
        operation,
        detail: "API balance tracking is unavailable.",
      });
    if (paid && Option.isSome(balances))
      yield* balances.value
        .assertAvailable(modelSelection.instanceId)
        .pipe(
          Effect.mapError(
            (cause) => new TextGenerationError({ operation, detail: cause.message, cause }),
          ),
        );
    const workingDirectory =
      operation === "generateThreadTitle"
        ? yield* fileSystem
            .makeTempDirectoryScoped({ prefix: "t3code-claude-title-" })
            .pipe(
              Effect.mapError((cause) =>
                normalizeCliError("claude", operation, cause, "Failed to create title directory"),
              ),
            )
        : cwd;
    const catalog = yield* routeModelCatalog(yield* scopedModelCatalog, workingDirectory);
    const resolvedModelSelection = {
      ...modelSelection,
      model: resolveClaudeModelSlug(catalog, modelSelection.model),
    };
    const jsonSchemaStr = yield* encodeJsonForOperation(
      operation,
      toJsonSchemaObject(outputSchemaJson),
      "Failed to encode structured output schema.",
    );
    // The same model options a chat turn on this selection launches with.
    const selection = compileClaudeModelSelection(resolvedModelSelection, catalog);
    const launchArgSettings = yield* readClaudeLaunchArgSettings({
      settings: claudeSettings,
      // The investigated checkout holds the change under review, not the user's files.
      cwd: investigate?.projectCwd ?? cwd,
      fileSystem,
      path,
    }).pipe(
      Effect.mapError(
        (cause) => new TextGenerationError({ operation, detail: cause.message, cause }),
      ),
    );
    const settings = {
      ...withClaudeSelectionSettings(
        (investigate
          ? investigationSettings(
              yield* readClaudeUserSettings(
                claudeSettings,
                workingDirectory,
                claudeEnvironment,
              ).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              ),
              launchArgSettings,
            )
          : launchArgSettings) ?? {},
        selection,
      ),
      disableAllHooks: true,
    };
    const settingsJson = yield* encodeJsonForOperation(
      operation,
      settings,
      "Failed to encode Claude CLI settings.",
    );
    // The user's settings can hold credentials; a file keeps them out of the process list.
    const settingsArgument = investigate
      ? yield* fileSystem
          .makeTempFileScoped({ prefix: "t3code-claude-settings-", suffix: ".json" })
          .pipe(
            Effect.tap((filePath) => fileSystem.writeFileString(filePath, settingsJson)),
            Effect.mapError((cause) =>
              normalizeCliError("claude", operation, cause, "Failed to write Claude CLI settings"),
            ),
          )
      : settingsJson;

    // `claude -p` accepts images only as content blocks of a stream-json user message.
    const apiModelId = selection.apiModelId;
    const imageBlocks = textOnlyModels.has(apiModelId) ? [] : yield* readImageBlocks(attachments);
    const imageStdin =
      imageBlocks.length > 0
        ? `${yield* encodeJsonForOperation(
            operation,
            {
              type: "user",
              message: { role: "user", content: [{ type: "text", text: prompt }, ...imageBlocks] },
            },
            "Failed to encode Claude CLI input.",
          )}\n`
        : undefined;

    let started = false;
    const runClaudeCommand = Effect.fn("runClaudeJson.runClaudeCommand")(function* (
      optionalFlags: ReadonlyArray<string>,
      withImages: boolean,
    ) {
      const streamJson = withImages && imageStdin !== undefined;
      const stdin = streamJson ? imageStdin : prompt;
      const cascade = yield* readClaudeSettingsCascade({
        homePath: yield* resolveClaudeHomePath(claudeSettings, claudeEnvironment),
        environment: claudeEnvironment,
        cwd: workingDirectory,
        settingSources: claudeSettingSources(claudeSettings),
        projectConfigRoot: claudeProjectConfigRoot(claudeSettings),
        flagSettings: settings,
        fileSystem,
        path,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Could not validate Claude billing settings.",
              cause,
            }),
        ),
      );
      yield* validateClaudeBillingSettings(
        claudeSettings,
        cascade.tiers.map((tier) => tier.settings),
        claudeEnvironment,
      ).pipe(
        Effect.mapError(
          (cause) => new TextGenerationError({ operation, detail: cause.message, cause }),
        ),
      );
      const managedMcpConfig = yield* hasClaudeManagedMcpConfig();
      const spawnCommand = yield* resolveSpawnCommand(
        claudeSettings.binaryPath || "claude",
        [
          "-p",
          ...(streamJson
            ? ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
            : ["--output-format", "json"]),
          "--json-schema",
          jsonSchemaStr,
          "--model",
          selection.apiModelId,
          ...(selection.effort ? ["--effort", selection.effort] : []),
          "--settings",
          settingsArgument,
          ...(investigate
            ? [
                "--tools",
                CLAUDE_INVESTIGATION_TOOLS,
                "--allowedTools",
                CLAUDE_INVESTIGATION_ALLOWED,
                "--disallowedTools",
                CLAUDE_INVESTIGATION_DENIED,
              ]
            : ["--tools", ""]),
          ...(investigate ? ["--setting-sources", ""] : []),
          "--disable-slash-commands",
          ...optionalFlags,
          // managed-mcp.json already isolates servers and makes Claude reject this flag.
          ...(managedMcpConfig ? [] : ["--strict-mcp-config"]),
          "--permission-mode",
          "dontAsk",
        ],
        { cwd: workingDirectory, env: claudeEnvironment },
      );
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: claudeEnvironment,
        cwd: workingDirectory,
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(stdin)),
        },
        forceKillAfter: "1 second",
      });

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("claude", operation, cause, "Failed to spawn Claude CLI process"),
          ),
        );

      started = true;
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("claude", operation, cause, "Failed to read Claude CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      // stream-json prints one message per line and ends with the result message.
      const normalizedStdout = streamJson ? (stdout.trim().split("\n").at(-1) ?? "") : stdout;
      if (paid && Option.isSome(balances)) {
        const output = Option.getOrUndefined(decodeJsonOption(normalizedStdout));
        const messages: ReadonlyArray<unknown> = Array.isArray(output) ? output : [output];
        const result = messages.findLast(
          (entry) => entry !== null && typeof entry === "object" && "is_error" in entry,
        );
        const modelUsage =
          result !== null && typeof result === "object" && "modelUsage" in result
            ? Option.getOrUndefined(decodeModelUsage(result.modelUsage))
            : undefined;
        const costs =
          modelUsage && Option.isSome(pricing)
            ? yield* pricing.value
                .priceTokens(
                  Object.entries(modelUsage).map(([model, tokens]) => ({
                    model,
                    totals: {
                      uncachedInputTokens: tokens.inputTokens,
                      outputTokens: tokens.outputTokens,
                      cachedInputTokens: tokens.cacheReadInputTokens,
                      cacheCreationTokens: tokens.cacheCreationInputTokens,
                      reasoningTokens: 0,
                    },
                  })),
                )
                .pipe(Effect.orElseSucceed(() => []))
            : [];
        const cost =
          costs.length > 0 && costs.every((value) => value !== null)
            ? costs.reduce<number>((sum, value) => sum + (value ?? 0), 0)
            : null;
        yield* balances.value.recordCheckSpend(modelSelection.instanceId, cost);
        if (
          exitCode === 0 &&
          result !== null &&
          typeof result === "object" &&
          "is_error" in result &&
          result.is_error === false
        )
          yield* balances.value.recordSuccess(modelSelection.instanceId);
        else
          yield* balances.value.recordFailure(modelSelection.instanceId, "claudeAgent", {
            stdout: normalizedStdout,
            stderr,
          });
      }
      return {
        stdout: normalizedStdout,
        stderr,
        exitCode,
      };
    });

    const runClaudeAttempt = Effect.fn("runClaudeAttempt")(function* (withImages: boolean) {
      let optionalFlags = OPTIONAL_CLAUDE_FLAGS;
      let result = yield* runClaudeCommand(optionalFlags, withImages);
      // A structured Claude result means Claude started, so no flag was rejected; wrapper text must not drop safe mode.
      // A rejected flag ends the CLI before any model call, so only the run that stays is charged.
      while (result.exitCode !== 0 && claudeErrorResult(result.stdout.trim()) === undefined) {
        const stderrLines = new Set(result.stderr.split(/\r?\n/).map((line) => line.trim()));
        const supportedFlags = optionalFlags.filter(
          (flag) => !stderrLines.has(`error: unknown option '${flag}'`),
        );
        if (supportedFlags.length === optionalFlags.length) break;
        started = false;
        optionalFlags = supportedFlags;
        result = yield* runClaudeCommand(optionalFlags, withImages);
      }
      return result;
    });

    const rawStdout = yield* runClaudeAttempt(true).pipe(
      // Text-only models (custom models behind Anthropic-compatible endpoints) reject image blocks.
      Effect.filterOrElse(
        (result) => result.exitCode === 0 || imageStdin === undefined,
        (imageResult) =>
          runClaudeAttempt(false).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                const imageFailure = `${imageResult.stdout}\n${imageResult.stderr}`;
                if (result.exitCode === 0 && IMAGES_UNSUPPORTED.test(imageFailure)) {
                  textOnlyModels.add(apiModelId);
                }
              }),
            ),
          ),
      ),
      Effect.onInterrupt(() =>
        paid && Option.isSome(balances)
          ? balances.value.recordCheckSpend(modelSelection.instanceId, null)
          : Effect.void,
      ),
      Effect.scoped,
      Effect.timeoutOption(investigate?.timeoutMs ?? CLAUDE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Claude CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
      Effect.onError(() =>
        Effect.sync(() => {
          if (started) reportUsage([unknownCallUsage(selection.apiModelId)]);
        }),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          reportUsage(claudeCallUsage(result.stdout, selection.apiModelId));
        }),
      ),
      Effect.flatMap(({ stdout, stderr, exitCode }) => {
        if (exitCode === 0) return Effect.succeed(stdout);
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const structuredError = claudeErrorResult(stdoutDetail);
        const detail =
          structuredError?.detail ?? (stderrDetail.length > 0 ? stderrDetail : stdoutDetail);
        return Effect.fail(
          new TextGenerationError({
            operation,
            detail:
              detail.length > 0
                ? `Claude CLI command failed: ${detail}`
                : `Claude CLI command failed with code ${exitCode}.`,
            ...(structuredError?.retryable === false ? { retryable: false } : {}),
          }),
        );
      }),
    );

    const output = yield* decodeClaudeOutput(rawStdout).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude CLI returned unexpected output format.",
              cause,
            }),
          ),
      }),
    );
    const envelope = isClaudeOutputEnvelope(output)
      ? output
      : output.findLast((message) => message.type === "result");

    const decodeOutput = Schema.decodeEffect(outputSchemaJson);
    return yield* decodeOutput(envelope?.structured_output).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  return TextGenerationOperations.fromRunner(
    "ClaudeTextGeneration",
    <S extends Schema.Top>(request: TextGenerationOperations.Request<S>) =>
      Effect.scoped(runClaudeJson(request)),
  );
});
