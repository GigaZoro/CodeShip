import {
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SeaRequiresCodexMetadata } from "./packagedCodexMetadata.ts";
import { createModelSelection } from "@t3tools/shared/model";
import { endingWindowsTrees } from "@t3tools/shared/windowsProcessTree";
import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import { ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";

import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { makeProcessProbe, processProbeSource } from "../testUtils/processProbe.ts";
import * as TextGenerationUsageRepository from "../persistence/TextGenerationUsage.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const DEFAULT_TEST_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("codex"),
  "gpt-5.4-mini",
);

const layerCodexTextGenerationTest = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-codex-text-generation-test-",
}).pipe(
  Layer.provideMerge(
    // Production wraps the spawner the same way: on Windows a kill ends only the `.cmd` launcher.
    Layer.effect(
      ChildProcessSpawner.ChildProcessSpawner,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        return endingWindowsTrees(spawner, yield* HostProcess.Platform, "leftBehind");
      }),
    ).pipe(Layer.provideMerge(NodeServices.layer)),
  ),
);

interface FakeCodexInput {
  output: string;
  metadata?: "supported" | "stock" | "legacy";
  invokedName?: string;
  expectedHome?: string;
  expectedManaged?: boolean;
  metadataReplies?: Readonly<Record<string, unknown>>;
  lifecycle?: { port: number; command: "exec" | "mcp list" };
  exitCode?: number;
  stderr?: string;
  requireImage?: boolean;
  requireServiceTier?: string;
  requireReasoningEffort?: string;
  forbidReasoningEffort?: boolean;
  requireArg?: string;
  forbidArg?: string;
  stdinMustContain?: string;
  stdinMustNotContain?: string;
  mcpServers?: ReadonlyArray<{ name: string; enabled: boolean }> | number;
}

function makeFakeCodexBinary(dir: string, input: FakeCodexInput) {
  const check = JSON.stringify({
    requireImage: input.requireImage ?? false,
    requireServiceTier: input.requireServiceTier ?? null,
    requireReasoningEffort: input.requireReasoningEffort ?? null,
    forbidReasoningEffort: input.forbidReasoningEffort ?? false,
    requireArg: input.requireArg ?? null,
    forbidArg: input.forbidArg ?? null,
    stdinMustContain: input.stdinMustContain ?? null,
    stdinMustNotContain: input.stdinMustNotContain ?? null,
    mcpServers: input.mcpServers ?? [],
    stderr: input.stderr ?? null,
    output: input.output,
    metadata: input.metadata ?? null,
    expectedHome: input.expectedHome ?? null,
    expectedManaged: input.expectedManaged ?? false,
    metadataReplies: input.metadataReplies ?? {},
    exitCode: input.exitCode ?? 0,
  });
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const binary = writeFakeCli({
      directory: path.join(dir, "bin"),
      name: "codex",
      source: [
        'import * as NodeFS from "node:fs";',
        `const check = ${check};`,
        "const args = process.argv.slice(2);",
        'if (args.join(" ") === "exec --help") {',
        "  const home = process.env.CODEX_HOME;",
        "  if (!home || home === check.expectedHome || home !== process.env.HOME || NodeFS.readdirSync(home).length) process.exit(20);",
        "  if (process.env.OPENAI_API_KEY || process.env.ACCESS_TOKEN) process.exit(20);",
        '  if (process.cwd() !== NodeFS.realpathSync(new URL(".", import.meta.url))) process.exit(29);',
        '  if (check.metadata === "supported") process.stdout.write("      --codeship-metadata-no-mcp\\n");',
        '  if (check.metadata === "legacy") process.stdout.write("      --codeship-metadata\\n");',
        "  process.exit(0);",
        "}",
        "if (check.expectedHome && process.env.CODEX_HOME !== check.expectedHome) process.exit(21);",
        "if (check.metadata) {",
        '  const expectedKey = check.expectedManaged ? undefined : "synthetic-test-key";',
        "  if (process.env.OPENAI_API_KEY !== expectedKey) process.exit(23);",
        '  if (args.includes("model_provider=synthetic-managed") !== check.expectedManaged) process.exit(24);',
        "}",
        'const isMcpList = args.includes("mcp") && args.includes("list");',
        ...(input.lifecycle === undefined
          ? []
          : [
              `if (isMcpList === ${input.lifecycle.command === "mcp list"}) {`,
              'process.on("SIGTERM", () => {});',
              processProbeSource(input.lifecycle.port),
              "await new Promise(() => {});",
              "}",
            ]),
        "if (isMcpList) {",
        "  if (check.metadata) process.exit(34);",
        '  if (typeof check.mcpServers === "number") process.exit(check.mcpServers);',
        "  process.stdout.write(JSON.stringify(check.mcpServers));",
        "  process.exit(0);",
        "}",
        'const originalArgs = ` ${args.join(" ")} `;',
        "let outputPath = null;",
        "let seenImage = false;",
        'let seenServiceTier = "";',
        'let seenReasoningEffort = "";',
        "for (let index = 0; index < args.length; index += 1) {",
        '  if (args[index] === "--image") {',
        "    index += 1;",
        "    if (args[index]) seenImage = true;",
        '  } else if (args[index] === "--config") {',
        "    index += 1;",
        '    const value = args[index] ?? "";',
        '    if (value.startsWith("service_tier=")) seenServiceTier = value;',
        '    if (value.startsWith("model_reasoning_effort=")) seenReasoningEffort = value;',
        '  } else if (args[index] === "--output-last-message") {',
        "    index += 1;",
        "    outputPath = args[index] ?? null;",
        "  }",
        "}",
        "const chunks = [];",
        "for await (const chunk of process.stdin) chunks.push(chunk);",
        'const stdinContent = Buffer.concat(chunks).toString("utf8");',
        "function fail(message, code) {",
        '  process.stderr.write(message + "\\n");',
        "  process.exit(code);",
        "}",
        "if (check.requireArg !== null && !originalArgs.includes(` ${check.requireArg} `)) {",
        '  fail("missing arg: " + check.requireArg, 8);',
        "}",
        "if (check.forbidArg !== null && originalArgs.includes(` ${check.forbidArg} `)) {",
        '  fail("forbidden arg: " + check.forbidArg, 9);',
        "}",
        'if (check.requireImage && !seenImage) fail("missing --image input", 2);',
        "if (",
        "  check.requireServiceTier !== null &&",
        '  seenServiceTier !== `service_tier="${check.requireServiceTier}"`',
        ") {",
        '  fail("unexpected service tier config: " + seenServiceTier, 5);',
        "}",
        "if (",
        "  check.requireReasoningEffort !== null &&",
        '  seenReasoningEffort !== `model_reasoning_effort="${check.requireReasoningEffort}"`',
        ") {",
        '  fail("unexpected reasoning effort config: " + seenReasoningEffort, 6);',
        "}",
        "if (check.forbidReasoningEffort && seenReasoningEffort.length > 0) {",
        '  fail("reasoning effort config should be omitted: " + seenReasoningEffort, 7);',
        "}",
        "if (check.stdinMustContain !== null && !stdinContent.includes(check.stdinMustContain)) {",
        '  fail("stdin missing expected content", 3);',
        "}",
        "if (check.stdinMustNotContain !== null && stdinContent.includes(check.stdinMustNotContain)) {",
        '  fail("stdin contained forbidden content", 4);',
        "}",
        'if (check.stderr !== null) process.stderr.write(check.stderr + "\\n");',
        "if (check.metadata) {",
        '  if (!args.includes("--codeship-metadata-no-mcp") || outputPath !== null) fail("wrong metadata argv", 22);',
        '  if (!originalArgs.includes(" --ephemeral --skip-git-repo-check -s read-only --model gpt-5.4-mini ")) fail("wrong policy or model", 25);',
        '  const schemaArg = args.indexOf("--output-schema");',
        '  if (schemaArg < 0 || args.at(-1) !== "-") fail("missing schema or stdin prompt", 26);',
        '  const schema = JSON.parse(NodeFS.readFileSync(args[schemaArg + 1], "utf8"));',
        '  if (schema.additionalProperties !== false) fail("schema must be strict", 27);',
        '  const reply = check.metadataReplies[Object.keys(schema.properties).sort().join(",")];',
        '  if (reply !== undefined && schema.properties.branch && !seenImage) fail("missing metadata image", 31);',
        '  process.stdout.write((reply === undefined ? check.output : JSON.stringify(reply)) + "\\n");',
        "} else {",
        '  if (args.includes("--codeship-metadata-no-mcp")) fail("stock exec received metadata flag", 32);',
        '  if (outputPath !== null) NodeFS.writeFileSync(outputPath, check.output + "\\n");',
        "}",
        "process.exitCode = check.exitCode;",
        "",
      ].join("\n"),
    });
    if (input.metadata) {
      const script = path.join(dir, "bin", "codex-stub.mjs");
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      yield* fs.writeFileString(
        binary,
        [
          "#!/bin/sh",
          ...(input.invokedName
            ? ['test "${0##*/}" = ' + quote(input.invokedName) + " || exit 33"]
            : []),
          `exec ${quote(process.execPath)} ${quote(script)} "$@"`,
          "",
        ].join("\n"),
      );
    }
    return binary;
  });
}

function withFakeCodexEnv<A, E, R>(
  input: FakeCodexInput & {
    launchArgs?: string;
    environment?: NodeJS.ProcessEnv;
    models?: ReadonlyArray<string>;
    managedRuntime?: boolean;
    packaged?: true | "missing-directory";
    metadataPath?: "configured" | "relative" | "missing" | "unset";
    customBinary?:
      | "same"
      | "different"
      | "absolute-shim"
      | "path-shim"
      | "relative-shim"
      | "relative-path-shim"
      | "linked-parent-shim"
      | "different-shim-name";
  },
  effectFn: (
    textGeneration: TextGeneration.TextGeneration["Service"],
    fixtureRoot: string,
  ) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-codex-text-" });
    const codexPath = yield* makeFakeCodexBinary(
      tempDir,
      input.metadata ? { output: "", exitCode: 28, stderr: "Unexpected stock exec" } : input,
    );
    const path = yield* Path.Path;
    const home = path.join(tempDir, "selected-home");
    const relativeShim =
      input.customBinary === "relative-shim" || input.customBinary === "relative-path-shim";
    const shim =
      relativeShim ||
      input.customBinary === "linked-parent-shim" ||
      input.customBinary === "absolute-shim" ||
      input.customBinary === "path-shim" ||
      input.customBinary === "different-shim-name";
    const packageDir = path.join(tempDir, "codex-metadata");
    const usePackageFixture = input.packaged && input.metadataPath === "unset" && input.metadata;
    if (input.packaged && !usePackageFixture) {
      // The ordinary or explicitly configured launcher must win over this incompatible package.
      yield* makeFakeCodexBinary(packageDir, { metadata: "stock", output: "" });
    }
    const metadataBinary = input.metadata
      ? yield* makeFakeCodexBinary(usePackageFixture ? packageDir : path.join(tempDir, "host"), {
          ...input,
          ...(shim ? { invokedName: "account-codex" } : {}),
          expectedHome: home,
          expectedManaged: input.managedRuntime === true,
        })
      : undefined;
    if (input.packaged === "missing-directory") {
      yield* fs.remove(packageDir, { recursive: true });
    }
    let metadataPath = metadataBinary;
    if (shim && metadataBinary) {
      metadataPath = path.join(path.dirname(metadataBinary), "account-codex");
      yield* fs.symlink(metadataBinary, metadataPath);
      if (input.customBinary === "linked-parent-shim") {
        yield* fs.symlink(path.dirname(metadataBinary), path.join(tempDir, "linked"));
      }
      if (relativeShim) yield* fs.symlink(codexPath, path.join(tempDir, "bin", "account-codex"));
    }
    const configuredPath = {
      configured: metadataPath,
      relative: "bin/codex",
      missing: path.join(tempDir, "missing"),
      unset: undefined,
    }[input.metadataPath ?? "configured"];
    const customPaths = {
      same: metadataPath,
      different: codexPath,
      "absolute-shim": metadataPath,
      "path-shim": "account-codex",
      "relative-shim": "./bin/account-codex",
      "relative-path-shim": "account-codex",
      "linked-parent-shim": "./linked/../bin/account-codex",
      "different-shim-name": metadataBinary,
    };
    const config = decodeCodexSettings({
      binaryPath: input.customBinary
        ? customPaths[input.customBinary]
        : input.metadata
          ? "codex"
          : codexPath,
      launchArgs:
        input.managedRuntime && input.metadata
          ? [input.launchArgs, "--config model_provider=synthetic-managed"]
              .filter(Boolean)
              .join(" ")
          : input.launchArgs,
      homePath: input.metadata ? home : undefined,
    });
    const environment = {
      ...process.env,
      ...(shim && metadataPath ? { PATH: relativeShim ? "bin" : path.dirname(metadataPath) } : {}),
      T3CODE_CODEX_METADATA_BINARY_PATH: codexPath,
      ...(input.metadata
        ? { OPENAI_API_KEY: input.managedRuntime ? undefined : "synthetic-test-key" }
        : {}),
      ...input.environment,
    };
    const textGeneration = yield* makeCodexTextGeneration(
      config,
      environment,
      Effect.succeed(
        (input.models ?? []).map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: null,
        })),
      ),
      input.managedRuntime
        ? Effect.succeed({
            config: { ...config, binaryPath: codexPath },
            environment,
            revision: "test",
            privateMcpSignIns: false,
          })
        : undefined,
      Effect.succeed(codexPath),
    ).pipe(
      Effect.provideService(SeaRequiresCodexMetadata, Boolean(input.packaged)),
      Effect.provideService(HostProcess.IsExecutable, Boolean(input.packaged)),
      Effect.provideService(HostProcess.ExecutablePath, path.join(tempDir, "t3")),
      Effect.provideService(HostProcess.Environment, {
        ...process.env,
        T3CODE_CODEX_METADATA_BINARY_PATH: configuredPath,
      }),
    );
    return yield* effectFn(textGeneration, tempDir);
  }).pipe(Effect.scoped);
}

it.layer(layerCodexTextGenerationTest)("CodexTextGeneration", (it) => {
  for (const customBinary of ["relative-shim", "relative-path-shim"] as const) {
    it.effect.skipIf(isWindowsHost)(`resolves ${customBinary} from the request repository`, () =>
      withFakeCodexEnv(
        { customBinary, metadata: "supported", output: '{"title":"Repository launcher"}' },
        (generation, root) =>
          Effect.gen(function* () {
            const path = yield* Path.Path;
            const title = (cwd: string) =>
              generation.generateThreadTitle({
                cwd,
                message: "Name this thread",
                modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              });
            expect((yield* title(path.join(root, "host"))).title).toBe("Repository launcher");
            const error = yield* Effect.flip(title(root));
            expect(error.detail).toContain("different custom launcher");
          }),
      ),
    );
  }
  it.effect.skipIf(isWindowsHost)(
    "invokes the selected named shim reached through a linked parent",
    () =>
      withFakeCodexEnv(
        {
          customBinary: "linked-parent-shim",
          metadata: "supported",
          output: '{"title":"Physical launcher"}',
        },
        (generation, cwd) =>
          Effect.gen(function* () {
            const result = yield* generation.generateThreadTitle({
              cwd,
              message: "Name this thread",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            });
            expect(result.title).toBe("Physical launcher");
          }),
      ),
  );
  it.effect.skipIf(isWindowsHost)("allows a cold metadata launch within the request deadline", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const checking = yield* Deferred.make<void>();
      const coldSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (command._tag === "StandardCommand" && command.args.includes("--help")) {
            yield* Deferred.succeed(checking, undefined);
            yield* Effect.sleep("40 seconds");
          }
          return yield* spawner.spawn(command);
        }),
      );
      const request = yield* withFakeCodexEnv(
        {
          packaged: true,
          metadataPath: "unset",
          metadata: "supported",
          output: '{"title":"Cold launch"}',
        },
        (generation) =>
          generation.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, coldSpawner),
        Effect.forkScoped,
      );
      yield* Deferred.await(checking);
      yield* TestClock.adjust("40 seconds");
      expect((yield* Fiber.join(request)).title).toBe("Cold launch");
    }),
  );
  for (const customBinary of ["absolute-shim", "path-shim"] as const) {
    it.effect.skipIf(isWindowsHost)(`invokes the named metadata launcher for ${customBinary}`, () =>
      withFakeCodexEnv(
        {
          packaged: true,
          customBinary,
          metadata: "supported",
          output: '{"title":"Named launcher"}',
        },
        (generation) =>
          Effect.gen(function* () {
            const result = yield* generation.generateThreadTitle({
              cwd: process.cwd(),
              message: "Name this thread",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            });
            expect(result.title).toBe("Named launcher");
          }),
      ),
    );
  }
  for (const managedRuntime of [false, true]) {
    it.effect.skipIf(isWindowsHost)(
      `uses the explicit host override before the package (managed=${managedRuntime})`,
      () =>
        withFakeCodexEnv(
          {
            packaged: true,
            managedRuntime,
            metadata: "supported",
            output: '{"title":"Host override"}',
          },
          (generation) =>
            Effect.gen(function* () {
              const result = yield* generation.generateThreadTitle({
                cwd: process.cwd(),
                message: "Name this thread",
                modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              });
              expect(result.title).toBe("Host override");
            }),
        ),
    );
    it.effect.skipIf(isWindowsHost)(
      `uses the packaged metadata binary with the selected home (managed=${managedRuntime})`,
      () =>
        withFakeCodexEnv(
          {
            metadata: "supported",
            managedRuntime,
            packaged: true,
            metadataPath: "unset",
            ...(managedRuntime ? { customBinary: "different" as const } : {}),
            output: "",
            metadataReplies: {
              "needsRefinement,title": { title: "Read-only metadata" },
              branch: { branch: "metadata" },
              "body,subject": { subject: "Add metadata", body: "" },
              "body,title": { title: "Add metadata", body: "Summary" },
              stops: { stops: [] },
              "needsPerson,solutions,summary,translation": {
                summary: "Review the step",
                needsPerson: false,
                solutions: [
                  { title: "Run checks", detail: "Verify metadata", command: "", agentCanDo: true },
                ],
                translation: { title: "Run checks", step: "Verify metadata" },
              },
            },
            launchArgs: "--strict-config --listen off --config features.plugins=true",
            mcpServers: [{ name: "server.with.dots", enabled: true }],
            requireArg:
              "--config features.plugins=false --config features.apps=false --codeship-metadata-no-mcp",
            forbidArg: "--listen",
          },
          (textGeneration) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const { attachmentsDir } = yield* ServerConfig.ServerConfig;
              const imageId = `metadata-image-${managedRuntime}`;
              const imagePath = path.join(attachmentsDir, `${imageId}.png`);
              yield* fs.makeDirectory(attachmentsDir, { recursive: true });
              yield* Effect.acquireRelease(fs.writeFile(imagePath, Buffer.from("image")), () =>
                fs.remove(imagePath).pipe(Effect.ignore),
              );
              const common = { cwd: process.cwd(), modelSelection: DEFAULT_TEST_MODEL_SELECTION };
              const message = "Name this synthetic thread";
              const result = yield* Effect.all(
                {
                  title: textGeneration.generateThreadTitle({ ...common, message }),
                  branch: textGeneration.generateBranchName({
                    ...common,
                    message,
                    attachments: [
                      {
                        type: "image",
                        id: imageId,
                        name: "metadata.png",
                        mimeType: "image/png",
                        sizeBytes: 5,
                      },
                    ],
                  }),
                  commit: textGeneration.generateCommitMessage({
                    ...common,
                    branch: "example",
                    stagedSummary: "M README.md",
                    stagedPatch: "diff --git a/README.md b/README.md",
                  }),
                  pr: textGeneration.generatePrContent({
                    ...common,
                    baseBranch: "main",
                    headBranch: "example",
                    commitSummary: "Add metadata",
                    diffSummary: "M README.md",
                    diffPatch: "diff --git a/README.md b/README.md",
                  }),
                  guide: textGeneration.generateReviewGuide({
                    ...common,
                    number: 1,
                    title: "Add metadata",
                    description: "Local fixture",
                    baseBranch: "main",
                    baseCommit: "abc123",
                    settledReview: "",
                    language: "en",
                  }),
                  step: textGeneration.generateManualStepReview({
                    ...common,
                    step: {
                      title: "Check metadata",
                      step: "Run checks",
                      kind: "hands-on",
                      machine: "Test host",
                    },
                    notes: [],
                    language: "en",
                  }),
                },
                { concurrency: "unbounded" },
              );
              expect(result).toEqual({
                title: { title: "Read-only metadata" },
                branch: { branch: "metadata" },
                commit: { subject: "Add metadata", body: "" },
                pr: { title: "Add metadata", body: "Summary" },
                guide: { stops: [] },
                step: {
                  summary: "Review the step",
                  needsPerson: false,
                  solutions: [{ title: "Run checks", detail: "Verify metadata", agentCanDo: true }],
                  translation: { title: "Run checks", step: "Verify metadata" },
                },
              });
            }),
        ),
    );
  }

  it.effect.skipIf(isWindowsHost)(
    "keeps the selected native custom launcher on a packaged host",
    () =>
      withFakeCodexEnv(
        { packaged: true, metadataPath: "unset", output: '{"title":"Custom launcher"}' },
        (generation) =>
          Effect.gen(function* () {
            const result = yield* generation.generateThreadTitle({
              cwd: process.cwd(),
              message: "Name this thread",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            });
            expect(result.title).toBe("Custom launcher");
          }),
      ),
  );

  for (const [fixture, detail] of [
    [{ packaged: "missing-directory", metadataPath: "unset" }, "Reinstall CodeShip"],
    [{ packaged: true, metadataPath: "unset", metadata: "legacy" }, "Reinstall CodeShip"],
    [{ packaged: true, metadataPath: "missing" }, "absolute path of an executable patched Codex"],
    [{ metadataPath: "relative" }, "absolute path of an executable patched Codex"],
    [{ metadataPath: "missing" }, "absolute path of an executable patched Codex"],
    [{ metadata: "stock" }, "supports --codeship-metadata-no-mcp"],
    [{ metadata: "legacy" }, "supports --codeship-metadata-no-mcp"],
    [{ customBinary: "different" }, "different custom launcher"],
    [{ customBinary: "different-shim-name" }, "different custom launcher"],
    [{ output: '{"title":"Title","extra":true}' }, "invalid structured output"],
    [{ output: 'progress\n{"title":"Title"}' }, "invalid structured output"],
    [{ exitCode: 3, stderr: "Synthetic policy denial" }, "Synthetic policy denial"],
  ] as const) {
    it.effect.skipIf(isWindowsHost)(
      `reports a metadata failure for ${JSON.stringify(fixture)}`,
      () =>
        withFakeCodexEnv(
          { metadata: "supported", output: '{"title":"Title"}', ...fixture },
          (textGeneration) =>
            Effect.gen(function* () {
              const error = yield* Effect.flip(
                textGeneration.generateThreadTitle({
                  cwd: process.cwd(),
                  message: "Name this thread",
                  modelSelection: DEFAULT_TEST_MODEL_SELECTION,
                }),
              );
              expect(error.detail).toContain(detail);
            }),
        ),
    );
  }

  it.effect.each(["exec", "mcp list"] as const)(
    "kills a stalled %s CLI when its request is interrupted",
    (command) =>
      Effect.gen(function* () {
        const probe = yield* makeProcessProbe;
        yield* withFakeCodexEnv(
          { output: "", lifecycle: { port: probe.port, command } },
          (textGeneration) =>
            Effect.gen(function* () {
              const fiber = yield* textGeneration
                .generateThreadTitle({
                  cwd: process.cwd(),
                  message: "Name this thread",
                  modelSelection: DEFAULT_TEST_MODEL_SELECTION,
                })
                .pipe(Effect.forkScoped);
              yield* probe.started;

              const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
              yield* probe.exited;
              yield* Fiber.join(interrupted);
              const exit = yield* Fiber.await(fiber);
              expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
            }),
        );
      }),
  );

  it.effect.each(["gpt-5.6-luna", "openai.gpt-5.6-luna"])(
    "dispatches the qualified live model for %s",
    (selectedModel) =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({ title: "Bedrock title" }),
          models: ["openai.gpt-5.6-luna"],
          requireArg: "--model openai.gpt-5.6-luna",
          forbidArg: "--model gpt-5.6-luna",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const result = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Describe this change",
              modelSelection: createModelSelection(ProviderInstanceId.make("codex"), selectedModel),
            });
            expect(result.title).toBe("Bedrock title");
          }),
      ),
  );

  it.effect("omits a persisted service tier for managed ChatGPT text generation", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "Update project", body: "" }),
        managedRuntime: true,
        forbidArg: 'service_tier="priority"',
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/chatgpt",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
            { id: "serviceTier", value: "priority" },
          ]),
        }),
    ),
  );

  it.effect("generates titles with the user's MCP servers and plugins off", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Remove default shapes" }),
        mcpServers: [
          { name: "augmenter", enabled: true },
          { name: "my.server", enabled: true },
          { name: "already-off", enabled: false },
        ],
        requireArg:
          '--config features.plugins=false --config features.apps=false --config mcp_servers={"augmenter"={enabled=false},"my.server"={enabled=false}}',
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Augmenter task 1. Use the Augmenter MCP: link_thread when you start.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.title).toBe("Remove default shapes");
        }),
    ),
  );

  it.effect("still generates when Codex cannot list its MCP servers", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ branch: "remove-default-shapes" }),
        mcpServers: 2,
        requireArg: "--config features.plugins=false --config features.apps=false --ephemeral",
        forbidArg: "mcp_servers=",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Remove default shapes from characters",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.branch).toBe("remove-default-shapes");
        }),
    ),
  );

  it.effect("keeps plugins and apps off over launch args that turn them on", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Remove default shapes" }),
        launchArgs: "--config features.plugins=true --config features.apps=true",
        requireArg:
          "--config features.plugins=true --config features.apps=true --config features.plugins=false --config features.apps=false --ephemeral",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Remove default shapes from characters",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.title).toBe("Remove default shapes");
        }),
    ),
  );

  it.effect("passes exec-safe launch args into codex exec", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        launchArgs: "--strict-config --listen off",
        requireArg: "--strict-config",
        forbidArg: "--listen",
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );

  it.effect("generates branch names even when the ambient scope is already closed", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "feat/background-generation",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          // Background fibers can outlive request scopes; temp files scoped there would be reaped on creation.
          const closedScope = yield* Scope.make();
          yield* Scope.close(closedScope, Exit.void);

          const generated = yield* textGeneration
            .generateBranchName({
              cwd: process.cwd(),
              message: "Please update session handling.",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.provideService(Scope.Scope, closedScope));

          expect(generated.branch).toBe("feat/background-generation");
        }),
    ),
  );

  it.effect("returns the refinement signal for an unresolved subject", () =>
    withFakeCodexEnv(
      { output: JSON.stringify({ title: "Investigate issue", needsRefinement: true }) },
      (textGeneration) =>
        Effect.gen(function* () {
          expect(
            yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Fix this",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            }),
          ).toEqual({ title: "Investigate issue", needsRefinement: true });
        }),
    ),
  );

  it.effect("resolves persisted attachment ids to files for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const attachmentId = "thread-1-attachment";
          const imagePath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(imagePath, Buffer.from("hello"));

          const generated = yield* textGeneration
            .generateBranchName({
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              cwd: process.cwd(),
              message: "Fix layout bug from screenshot.",
              attachments: [
                {
                  type: "image",
                  id: attachmentId,
                  name: "bug.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            })
            .pipe(
              Effect.tap(() =>
                fs.stat(imagePath).pipe(
                  Effect.map((fileInfo) => {
                    expect(fileInfo.type).toBe("File");
                  }),
                ),
              ),
              Effect.ensuring(fs.remove(imagePath).pipe(Effect.ignore)),
            );

          expect(generated.branch).toBe("fix/ui-regression");
        }),
    ),
  );

  it.effect.each([
    ["Codex usage limit stderr", "ERROR: You've hit your usage limit. Try again at 3pm.", false],
    [
      "Codex 401 unauthorized stderr",
      "ERROR: unexpected status 401 Unauthorized: invalid token",
      false,
    ],
    [
      "Codex warning line followed by usage limit error",
      "2026-04-10T12:00:00Z WARN config option deprecated\nERROR: You've hit your usage limit.",
      false,
    ],
    [
      "MCP 403 stderr noise",
      'MCP server "linear" connection failed: HTTP 403 Forbidden',
      undefined,
    ],
    [
      "warning mentioning rate_limit followed by transient error",
      "warn: config key `rate_limit` ignored\nconnection reset by peer",
      undefined,
    ],
    ["transient 503 stderr", "HTTP 503 Service Unavailable", undefined],
  ] as const)("sets retryable on Codex CLI failure (%s)", ([, stderr, expectedRetryable]) =>
    withFakeCodexEnv({ output: "", stderr, exitCode: 1 }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          }),
        );

        expect(error.retryable).toBe(expectedRetryable);
      }),
    ),
  );
});

it.effect.each([false, true])("text generation preflight: exhausted=%s", (exhausted) =>
  Effect.gen(function* () {
    const primary = ProviderInstanceId.make("codex");
    const fallback = ProviderInstanceId.make("claude_work");
    const selection = {
      instanceId: primary,
      model: "chat-model",
      options: [{ id: "effort", value: "high" }],
    };
    const calls: ModelSelection[] = [];
    const instances: ProviderInstance[] = [primary, fallback].map((instanceId) => {
      const driver = ProviderDriverKind.make(instanceId === primary ? "codex" : "claudeAgent");
      const snapshot: ServerProvider = {
        instanceId,
        driver,
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        version: null,
        checkedAt: "1970-01-01T00:00:00Z",
        models: [],
        slashCommands: [],
        skills: [],
        ...(exhausted && instanceId === primary
          ? {
              usageLimits: {
                checkedAt: "1970-01-01T00:00:00Z",
                windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 100 }],
              },
            }
          : {}),
      };
      return {
        instanceId,
        driverKind: driver,
        continuationIdentity: { driverKind: driver, continuationKey: instanceId },
        displayName: undefined,
        enabled: true,
        snapshot: { getSnapshot: Effect.succeed(snapshot) } as ProviderInstance["snapshot"],
        orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
        textGeneration: TextGeneration.TextGeneration.of({
          generateCommitMessage: () => Effect.die("unused"),
          generatePrContent: () => Effect.die("unused"),
          generateBranchName: () => Effect.die("unused"),
          generateReviewGuide: () => Effect.die("unused"),
          generateManualStepReview: () => Effect.die("unused"),
          generateThreadTitle: (input) =>
            Effect.sync(() => {
              calls.push(input.modelSelection);
              return { title: "Generated title" };
            }),
        }),
      };
    });
    const service = yield* TextGeneration.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            listInstances: Effect.succeed(instances),
            getInstance: (id) =>
              Effect.succeed(instances.find((instance) => instance.instanceId === id)),
          }),
          ServerSettings.layerTest({
            providerInstances: {
              [fallback]: { driver: ProviderDriverKind.make("claudeAgent"), config: {} },
            },
          }),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("unused"),
          }),
          Layer.succeed(TextGenerationUsageRepository.TextGenerationUsageRepository, {
            record: () => Effect.void,
          }),
        ),
      ),
    );
    expect(
      yield* service.generateThreadTitle({
        cwd: "/tmp",
        message: "hello",
        linkedContext: "",
        modelSelection: selection,
      }),
    ).toEqual({ title: "Generated title" });
    expect(calls).toEqual([
      exhausted
        ? {
            instanceId: fallback,
            model:
              DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[ProviderDriverKind.make("claudeAgent")],
          }
        : selection,
    ]);
    const refusal = yield* Effect.flip(
      service.generateThreadTitle({
        cwd: "/tmp",
        message: "Fresh Auto title",
        linkedContext: "",
        modelSelection: { ...selection, quotaAwareAuto: true },
      }),
    );
    expect(refusal.operation).toBe("generateThreadTitle");
    expect(refusal.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  }),
);
