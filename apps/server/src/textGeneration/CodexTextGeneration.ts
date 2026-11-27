import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  CodexSettings,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  type ServerProviderModel,
  TextGenerationError,
} from "@t3tools/contracts";
import {
  CommandResolutionCache,
  resolveCommandPath,
  resolveMatchingLauncher,
  resolveSpawnCommand,
} from "@t3tools/shared/shell";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { codexExecArgsWithoutMcp } from "./codexStockMcpArgs.ts";
import {
  packagedMetadataSandboxProblem,
  resolvePackagedCodexMetadataBinary,
} from "./packagedCodexMetadata.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  codexExecLaunchArgs,
  codexMcpListLaunchArgs,
  resolveCodexLaunchArgs,
} from "../provider/codexLaunchArgs.ts";
import { isCodexLoginRejected } from "../provider/CodexLoginRejected.ts";
import { isNonRetryableCodexManagedError } from "../provider/CodexManagedErrors.ts";
import { codexAppServerEnvironment } from "../provider/CodexProvider.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import {
  normalizeCliError,
  toJsonSchemaObject,
} from "@t3tools/provider-core/server/textGenerationUtils";
import {
  codexModelFamily,
  getModelSelectionStringOptionValue,
  readCustomModelEntries,
} from "@t3tools/shared/model";
import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const CODEX_TIMEOUT_MS = 180_000;
const CODEX_MCP_LIST_TIMEOUT_MS = 10_000;
const CODEX_METADATA_BINARY_ENV = "T3CODE_CODEX_METADATA_BINARY_PATH";
const CODEX_METADATA_FLAG = "--codeship-metadata-no-mcp";
const { binaryPath: defaultCodexBinary } = Schema.decodeSync(CodexSettings)({});
// Plugins/apps add MCP servers; use trailing config overrides because --disable loses to user -c flags.
// Codex also reads the legacy connectors key for apps.
const CODEX_NO_PLUGIN_ARGS = [
  "--config",
  "features.connectors=false",
  "--config",
  "features.plugins=false",
  "--config",
  "features.apps=false",
] as const;
const CODEX_NOISE_LINE_PATTERN =
  /^(?:warn(?:ing)?|info|debug)\s*:|^\d{4}-\d{2}-\d{2}T\S+\s+(?:WARN|INFO|DEBUG)\b/i;
const CODEX_MCP_LINE_PATTERN = /\bMCP\b/u;
const NON_RETRYABLE_CODEX_CLI_PATTERN =
  /\b(?:usage[\s_-]+limit|rate[\s_-]+limit(?:ed)?|too\s+many\s+requests|you(?:'ve|\s+have)\s+(?:hit|reached)\s+(?:your|the)\s+(?:[a-z0-9-]+\s+)?limit|exceeded\s+(?:your\s+)?(?:current\s+)?quota|insufficient[\s_]+quota|quota[\s_]+(?:exceeded|exhausted)|unexpected\s+status\s+(?:401|402|403|429)|http\s+(?:401|402|403|429)|(?:401\s+unauthorized|402\s+payment\s+required|403\s+forbidden|429\s+too\s+many\s+requests)|model[\s_]+not[\s_]+supported|unsupported\s+model|authentication[\s_]+(?:failed|error)|invalid[\s_]+api[\s_]+key|incorrect\s+api\s+key)\b/i;

function isNonRetryableCodexCliDetail(detail: string): boolean {
  const line = detail
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(
      (entry) =>
        entry.length > 0 &&
        !CODEX_NOISE_LINE_PATTERN.test(entry) &&
        !CODEX_MCP_LINE_PATTERN.test(entry),
    );
  if (line === undefined) return false;
  if (isNonRetryableCodexManagedError(line) || isCodexLoginRejected({ message: line })) {
    return true;
  }
  const sanitized = line.replace(/https?:\/\/\S+/gi, " ").replace(/`[^`]*`/g, " ");
  return NON_RETRYABLE_CODEX_CLI_PATTERN.test(sanitized);
}

const CodexMcpServers = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, enabled: Schema.Boolean })),
);
const decodeCodexMcpServers = Schema.decodeEffect(CodexMcpServers);

const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
export const makeCodexTextGeneration = Effect.fn("makeCodexTextGeneration")(function* (
  codexConfig: CodexSettings,
  environment?: NodeJS.ProcessEnv,
  getModels: Effect.Effect<ReadonlyArray<ServerProviderModel>> = Effect.succeed([]),
  resolveRuntime?: Effect.Effect<
    import("../provider/CodexManagedRuntime.ts").CodexEffectiveRuntime,
    import("@t3tools/contracts").ProviderSetupError,
    Scope.Scope
  >,
  /** The program to run when no runtime is resolved; absent, `codexConfig.binaryPath`. */
  resolveBinaryPath?: Effect.Effect<string, import("@t3tools/contracts").ProviderSetupError>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig.ServerConfig);
  const resolvedEnvironment = environment ?? process.env;
  const hostEnvironment = yield* HostProcess.Environment;
  const hostOverride = hostEnvironment[CODEX_METADATA_BINARY_ENV];
  const nativeCustomLauncher =
    !resolveRuntime && codexConfig.binaryPath !== defaultCodexBinary
      ? codexConfig.binaryPath
      : undefined;
  const selectedMetadataPath = yield* Effect.result(
    hostOverride !== undefined || nativeCustomLauncher
      ? Effect.succeed(hostOverride)
      : resolvePackagedCodexMetadataBinary(),
  );
  const platform = yield* HostProcess.Platform;
  if (
    hostOverride === undefined &&
    !nativeCustomLauncher &&
    selectedMetadataPath._tag === "Success"
  ) {
    yield* packagedMetadataSandboxProblem(selectedMetadataPath.success).pipe(
      Effect.flatMap((problem) =>
        problem === undefined
          ? Effect.void
          : Effect.logWarning(problem.message, { setupCommand: problem.setupCommand }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("could not check the Codex metadata sandbox", { cause }),
      ),
    );
  }

  const resolveMetadataBinary = Effect.fn("CodexTextGeneration.resolveMetadataBinary")(function* (
    operation: TextGenerationOperations.Operation,
    configuredPath: string,
    cwd: string,
  ) {
    const unusableBinary = new TextGenerationError({
      operation,
      detail:
        hostOverride === undefined
          ? `Reinstall CodeShip to restore its bundled Codex metadata runtime. The installed executable must support ${CODEX_METADATA_FLAG}.`
          : `Set ${CODEX_METADATA_BINARY_ENV} on the CodeShip host to the absolute path of an executable patched Codex that supports ${CODEX_METADATA_FLAG}, then restart CodeShip.`,
      retryable: false,
    });
    if (
      !path.isAbsolute(configuredPath) ||
      (platform === "win32" &&
        (!/^[a-z]:[/\\]/i.test(configuredPath) ||
          path.extname(configuredPath).toLowerCase() !== ".exe"))
    ) {
      return yield* unusableBinary;
    }
    // A native custom launcher can own sign-in or policy. Shims dispatch by their invoked name.
    let executable = configuredPath;
    if (nativeCustomLauncher) {
      const launcher = yield* resolveCommandPath(nativeCustomLauncher, {
        cwd,
        env: resolvedEnvironment,
      }).pipe(
        // Compare the current account launcher even if another PATH directory gained an executable.
        Effect.provideService(CommandResolutionCache, new Map()),
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const matched =
        launcher === null
          ? null
          : yield* resolveMatchingLauncher(launcher, configuredPath).pipe(
              Effect.provideService(Path.Path, path),
              Effect.provideService(HostProcess.Platform, platform),
            );
      if (matched === null) {
        return yield* new TextGenerationError({
          operation,
          detail: `This Codex instance uses a different custom launcher. Provision that launcher for metadata and point ${CODEX_METADATA_BINARY_ENV} at it, or unset the host override to use this account’s launcher.`,
          retryable: false,
        });
      }
      executable = matched;
    }
    const [help, , exitCode] = yield* Effect.gen(function* () {
      // Cold OS verification can take tens of seconds. The enclosing request bounds this probe.
      // Codex initializes its home before parsing help, even with an empty environment.
      const probeHome = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-codex-probe-",
      });
      const child = yield* commandSpawner.spawn(
        ChildProcess.make(executable, ["exec", "--help"], {
          cwd: path.dirname(executable),
          env: { CODEX_HOME: probeHome, HOME: probeHome, USERPROFILE: probeHome },
          extendEnv: false,
          stdin: "ignore",
          forceKillAfter: "1 second",
        }),
      );
      return yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
    }).pipe(
      Effect.scoped,
      Effect.mapError(() => unusableBinary),
    );
    if (
      exitCode !== 0 ||
      !help.split("\n").some((line) => line.trim().split(/\s/, 1)[0] === CODEX_METADATA_FLAG)
    ) {
      return yield* unusableBinary;
    }
    return executable;
  });

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
        normalizeCliError("codex", operation, cause, "Failed to collect process output"),
      ),
    );

  const removeTempFileDir = (filePath: string): Effect.Effect<void, never> =>
    fileSystem.remove(path.dirname(filePath), { recursive: true }).pipe(Effect.ignore);

  // Background fibers may inherit closed scopes that immediately reap temp files; write unscoped.
  const writeTempFile = (
    operation: string,
    prefix: string,
    content: string,
  ): Effect.Effect<string, TextGenerationError> =>
    fileSystem
      .makeTempFile({
        prefix: `t3code-${prefix}-${process.pid}-`,
      })
      .pipe(
        Effect.tap((filePath) =>
          fileSystem
            .writeFileString(filePath, content)
            .pipe(Effect.onError(() => removeTempFileDir(filePath))),
        ),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: `Failed to write temp file`,
              cause,
            }),
        ),
      );

  const encodeJsonForOperation = (
    operation: TextGenerationOperations.Operation,
    value: unknown,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to encode structured output schema.",
            cause,
          }),
      ),
    );

  const materializeImageAttachments = Effect.fn("materializeImageAttachments")(function* (
    attachments: TextGenerationOperations.Request<Schema.Top>["attachments"],
  ) {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    const imagePaths: string[] = [];
    for (const attachment of attachments) {
      if (attachment.type !== "image") {
        continue;
      }

      const resolvedPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
        continue;
      }
      const fileInfo = yield* fileSystem.stat(resolvedPath).pipe(Effect.orElseSucceed(() => null));
      if (!fileInfo || fileInfo.type !== "File") {
        continue;
      }
      imagePaths.push(resolvedPath);
    }
    return imagePaths;
  });

  const listEnabledMcpServers = Effect.fn("listEnabledMcpServers")(
    function* (input: {
      readonly binary: string;
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly launchArgs: ReadonlyArray<string>;
    }) {
      const args = [...input.launchArgs, ...CODEX_NO_PLUGIN_ARGS, "mcp", "list", "--json"];
      const spawnCommand = yield* resolveSpawnCommand(input.binary, args, {
        cwd: input.cwd,
        env: input.env,
      });
      const child = yield* commandSpawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: input.env,
          cwd: input.cwd,
          shell: spawnCommand.shell,
          forceKillAfter: "1 second",
        }),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        yield* Effect.logWarning("codex mcp list failed", {
          reason: "exit",
          exitCode,
        });
        return null;
      }
      const servers = yield* decodeCodexMcpServers(stdout).pipe(
        Effect.tapError(() =>
          Effect.logWarning("codex mcp list failed", {
            reason: "decode",
          }),
        ),
      );
      return servers.filter((server) => server.enabled).map((server) => server.name);
    },
    Effect.scoped,
    Effect.timeoutOption(CODEX_MCP_LIST_TIMEOUT_MS),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.logWarning("codex mcp list failed", {
            reason: "timeout",
          }).pipe(Effect.as(null)),
        onSome: (names) => Effect.succeed(names),
      }),
    ),
    Effect.orElseSucceed(() => null),
  );

  const runCodexJson = Effect.fn("runCodexJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema: outputSchemaJson,
    modelSelection,
    attachments,
    investigate,
  }: TextGenerationOperations.Request<S>): Effect.fn.Return<
    S["Type"],
    TextGenerationError,
    S["DecodingServices"]
  > {
    const metadataBinaryPath = yield* Effect.fromResult(selectedMetadataPath).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: cause.message,
            retryable: false,
            cause,
          }),
      ),
    );
    const imagePaths = yield* materializeImageAttachments(attachments);
    const schemaJson = yield* encodeJsonForOperation(
      operation,
      toJsonSchemaObject(outputSchemaJson),
    );
    const schemaPath = yield* writeTempFile(operation, "codex-schema", schemaJson);
    const outputPath =
      metadataBinaryPath === undefined
        ? yield* writeTempFile(operation, "codex-output", "").pipe(
            Effect.onError(() => removeTempFileDir(schemaPath)),
          )
        : undefined;

    const runCodexCommand = Effect.fn("runCodexJson.runCodexCommand")(function* () {
      const metadataBinary =
        metadataBinaryPath === undefined
          ? undefined
          : yield* resolveMetadataBinary(operation, metadataBinaryPath, cwd);
      const resolved = resolveRuntime
        ? yield* resolveRuntime.pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation,
                  detail: cause.detail,
                  ...(cause.retryable === undefined ? {} : { retryable: cause.retryable }),
                  cause,
                }),
            ),
          )
        : undefined;
      const effectiveConfig = resolved?.config ?? codexConfig;
      const effectiveEnvironment = resolved?.environment ?? resolvedEnvironment;
      const models = yield* getModels;
      const requestedModel = modelSelection.model;
      const listed = models.filter((candidate) => !candidate.isCustom);
      // An unlisted slug is one this account can't run, e.g. gpt-6-luna on a ChatGPT login.
      const requestedFamily = codexModelFamily(requestedModel);
      const matchedModel =
        models.find((candidate) => candidate.slug === requestedModel)?.slug ??
        // Managed snapshots omit configured custom models; send those as requested.
        readCustomModelEntries(codexConfig.customModels).find(
          (entry) => entry.slug === requestedModel,
        )?.slug ??
        listed.find((candidate) => codexModelFamily(candidate.slug) === requestedFamily)?.slug;
      const model =
        matchedModel ??
        listed.find((candidate) => candidate.isDefault)?.slug ??
        listed.find((candidate) => !candidate.isLegacy)?.slug ??
        listed[0]?.slug ??
        requestedModel;
      // The selection's options were chosen for the requested model and may not fit a fallback.
      const fellBack = matchedModel === undefined && model !== requestedModel;
      const launchArgs = resolveCodexLaunchArgs(effectiveConfig.launchArgs, effectiveEnvironment);
      const reasoningEffort =
        (fellBack
          ? undefined
          : getModelSelectionStringOptionValue(modelSelection, "reasoningEffort")) ??
        DEFAULT_TEXT_GENERATION_REASONING_EFFORT;
      const serviceTier =
        resolved || fellBack ? undefined : getCodexServiceTierOptionValue(modelSelection);
      const binary =
        metadataBinary ??
        ((resolved || !resolveBinaryPath
          ? effectiveConfig.binaryPath
          : yield* resolveBinaryPath.pipe(
              Effect.mapError(
                (cause) =>
                  new TextGenerationError({
                    operation,
                    detail: cause.detail,
                    ...(cause.retryable === undefined ? {} : { retryable: cause.retryable }),
                    cause,
                  }),
              ),
            )) ||
          defaultCodexBinary);
      const env: NodeJS.ProcessEnv = {
        ...codexAppServerEnvironment(effectiveEnvironment),
        ...(effectiveConfig.homePath
          ? {
              CODEX_HOME: expandHomePath(
                effectiveConfig.homePath,
                yield* HostProcess.HomeDirectory,
              ),
            }
          : {}),
      };
      if (metadataBinary !== undefined) {
        // Provider environment overrides must not inject a loader into the host executable.
        for (const name of Object.keys(env)) {
          if (name.startsWith("LD_") || name.startsWith("DYLD_")) {
            delete env[name];
          }
        }
      }
      const execLaunchArgs = codexExecLaunchArgs(launchArgs);
      // The metadata runtime disables MCP in the resolved thread, including launch-argument servers.
      const mcpServers =
        metadataBinary === undefined
          ? yield* listEnabledMcpServers({
              binary,
              cwd,
              env,
              // `codex mcp` rejects --strict-config; the overrides still apply.
              launchArgs: codexMcpListLaunchArgs(launchArgs),
            })
          : null;
      const launchWithPluginsOff = [...execLaunchArgs, ...CODEX_NO_PLUGIN_ARGS];
      const args = [
        "exec",
        ...(mcpServers?.length
          ? codexExecArgsWithoutMcp(launchWithPluginsOff, mcpServers)
          : launchWithPluginsOff),
        ...(metadataBinary !== undefined ? [CODEX_METADATA_FLAG] : []),
        "--ephemeral",
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "--model",
        model,
        "--config",
        `model_reasoning_effort="${reasoningEffort}"`,
        "--config",
        "features.codex_hooks=false",
        "--config",
        "features.hooks=false",
        ...(serviceTier ? ["--config", `service_tier="${serviceTier}"`] : []),
        "--output-schema",
        schemaPath,
        ...(outputPath ? ["--output-last-message", outputPath] : []),
        ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
        "-",
      ];
      const spawnCommand = metadataBinary
        ? { command: metadataBinary, args, shell: false }
        : yield* resolveSpawnCommand(binary, args, { cwd, env: effectiveEnvironment });
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env,
        ...(metadataBinary ? { extendEnv: false } : {}),
        cwd,
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
            normalizeCliError("codex", operation, cause, "Failed to spawn Codex CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("codex", operation, cause, "Failed to read Codex CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Codex CLI command failed: ${detail}`
              : `Codex CLI command failed with code ${exitCode}.`,
          ...(detail.length > 0 && isNonRetryableCodexCliDetail(detail)
            ? { retryable: false }
            : {}),
        });
      }
      return stdout;
    });

    const cleanup = Effect.all(
      [removeTempFileDir(schemaPath), ...(outputPath ? [removeTempFileDir(outputPath)] : [])],
      {
        concurrency: "unbounded",
      },
    ).pipe(Effect.asVoid);

    return yield* Effect.gen(function* () {
      const stdout = yield* runCodexCommand().pipe(
        Effect.scoped,
        Effect.timeoutOption(investigate?.timeoutMs ?? CODEX_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Codex CLI request timed out." }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));

      const output = outputPath
        ? fileSystem.readFileString(outputPath).pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation,
                  detail: "Failed to read Codex output file.",
                  cause,
                }),
            ),
          )
        : Effect.succeed(stdout);
      return yield* output.pipe(
        Effect.flatMap((value) =>
          decodeOutput(value, outputPath ? undefined : { onExcessProperty: "error" }),
        ),
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Codex returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(Effect.ensuring(cleanup));
  });

  return TextGenerationOperations.fromRunner("CodexTextGeneration", runCodexJson);
});
