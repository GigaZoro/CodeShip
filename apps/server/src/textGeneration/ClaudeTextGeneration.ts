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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { type ClaudeSettings, TextGenerationError } from "@t3tools/contracts";
import { parseCliArgs } from "@t3tools/shared/cliArgs";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

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

const CLAUDE_TIMEOUT_MS = 180_000;
/** `--tools` takes bare names; patterns go in the allow list. */
const CLAUDE_INVESTIGATION_TOOLS = "Read,Grep,Glob,Bash";
/** In dontAsk mode every call outside this list, Bash included, is refused. */
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
const ClaudeErrorResult = Schema.Struct({ is_error: Schema.Literal(true), result: Schema.String });
const isClaudeErrorResult = Schema.is(ClaudeErrorResult);
const decodeLaunchSettings = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

// Claude reports JSON errors on stdout; stderr may contain only wrapper notices.
function claudeErrorResult(stdout: string): string | undefined {
  const output = Option.getOrUndefined(decodeJsonOption(stdout));
  const messages: ReadonlyArray<unknown> = Array.isArray(output) ? output : [output];
  return messages
    .filter(isClaudeErrorResult)
    .map((message) => message.result.trim())
    .findLast((result) => result.length > 0);
}

export const makeClaudeTextGeneration = Effect.fn("makeClaudeTextGeneration")(function* (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  modelCatalog: Effect.Effect<ClaudeModelCatalog> = Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG),
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const scopedModelCatalog = modelCatalog.pipe(
    Effect.map((catalog) => scopeClaudeModelCatalog(catalog, claudeSettings.customModels)),
  );

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

  // Claude passes one --settings flag, so ours has to carry the launch-arg settings too.
  // Like the CLI, a value starting with "{" is JSON and anything else is a file path.
  const readLaunchSettings = Effect.fn("readLaunchSettings")(function* (
    operation: TextGenerationOperations.Operation,
    cwd: string,
  ) {
    const raw = parseCliArgs(claudeSettings.launchArgs).flags.settings;
    if (raw === undefined) return {};
    const value = raw?.trim() ?? "";
    const fail = (detail: string) => (cause: unknown) =>
      new TextGenerationError({ operation, detail, cause });
    if (value.length === 0) {
      return yield* new TextGenerationError({
        operation,
        detail: "The --settings launch argument needs a JSON object or file path.",
      });
    }
    const filePath = path.resolve(cwd, value);
    const json = value.startsWith("{")
      ? value
      : yield* fileSystem
          .readFileString(filePath)
          .pipe(Effect.mapError(fail(`Failed to read Claude settings file ${filePath}.`)));
    return yield* decodeLaunchSettings(json).pipe(
      Effect.mapError(fail("The --settings launch argument is not a JSON object.")),
    );
  });

  const runClaudeJson = Effect.fn("runClaudeJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema: outputSchemaJson,
    modelSelection,
    investigate,
  }: TextGenerationOperations.Request<S>): Effect.fn.Return<
    S["Type"],
    TextGenerationError,
    S["DecodingServices"]
  > {
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
    const catalog = yield* scopedModelCatalog;
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
    const settings = {
      ...withClaudeSelectionSettings(yield* readLaunchSettings(operation, cwd), selection),
      disableAllHooks: true,
    };
    const settingsJson = yield* encodeJsonForOperation(
      operation,
      settings,
      "Failed to encode Claude CLI settings.",
    );

    const runClaudeCommand = Effect.fn("runClaudeJson.runClaudeCommand")(function* (
      optionalFlags: ReadonlyArray<string>,
    ) {
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
      yield* validateClaudeBillingSettings(claudeSettings, cascade.tiers, claudeEnvironment).pipe(
        Effect.mapError(
          (cause) => new TextGenerationError({ operation, detail: cause.message, cause }),
        ),
      );
      const managedMcpConfig = yield* hasClaudeManagedMcpConfig();
      const spawnCommand = yield* resolveSpawnCommand(
        claudeSettings.binaryPath || "claude",
        [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          jsonSchemaStr,
          "--model",
          selection.apiModelId,
          ...(selection.effort ? ["--effort", selection.effort] : []),
          "--settings",
          settingsJson,
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
          stream: Stream.encodeText(Stream.make(prompt)),
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

      if (paid && Option.isSome(balances)) {
        const output = Option.getOrUndefined(decodeJsonOption(stdout));
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
            stdout,
            stderr,
          });
      }
      return { stdout, stderr, exitCode };
    });

    const rawStdout = yield* Effect.gen(function* () {
      let optionalFlags = OPTIONAL_CLAUDE_FLAGS;
      let result = yield* runClaudeCommand(optionalFlags);
      // A structured Claude result means Claude started, so no flag was rejected; wrapper text must not drop safe mode.
      while (result.exitCode !== 0 && claudeErrorResult(result.stdout.trim()) === undefined) {
        const stderrLines = new Set(result.stderr.split(/\r?\n/).map((line) => line.trim()));
        const supportedFlags = optionalFlags.filter(
          (flag) => !stderrLines.has(`error: unknown option '${flag}'`),
        );
        if (supportedFlags.length === optionalFlags.length) break;
        optionalFlags = supportedFlags;
        result = yield* runClaudeCommand(optionalFlags);
      }
      return result;
    }).pipe(
      Effect.onInterrupt(() =>
        paid && Option.isSome(balances)
          ? balances.value.recordCheckSpend(modelSelection.instanceId, null)
          : Effect.void,
      ),
      Effect.flatMap(({ stdout, stderr, exitCode }) => {
        if (exitCode === 0) return Effect.succeed(stdout);
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail =
          claudeErrorResult(stdoutDetail) ??
          (stderrDetail.length > 0 ? stderrDetail : stdoutDetail);
        return Effect.fail(
          new TextGenerationError({
            operation,
            detail:
              detail.length > 0
                ? `Claude CLI command failed: ${detail}`
                : `Claude CLI command failed with code ${exitCode}.`,
          }),
        );
      }),
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

  return TextGenerationOperations.fromRunner("ClaudeTextGeneration", runClaudeJson);
});
