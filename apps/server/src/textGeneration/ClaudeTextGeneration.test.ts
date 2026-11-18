import * as ApiCreditBalance from "../provider/ApiCreditBalance.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { TokenPricing } from "../usage/TokenPricing.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelSelection } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { makeProcessProbe, processProbeSource } from "../testUtils/processProbe.ts";
import {
  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
  SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
  SYNTHETIC_CLAUDE_MODEL_CATALOG,
  SYNTHETIC_CLAUDE_STANDARD_MODEL,
} from "../provider/ClaudeModelCatalog.testFixtures.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { sanitizeThreadTitle } from "@t3tools/provider-core/server/textGenerationUtils";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
import { type TextGenerationCallUsage, TextGenerationUsageSink } from "./TextGenerationUsage.ts";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const layerClaudeTextGenerationTest = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-claude-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// The stub behaviour lives in Node so the same implementation runs on Windows,
// where a shebang file is not executable and would fall through to the real
// Claude CLI on PATH; `writeFakeCli` picks the launcher shape per host.
function makeFakeClaudeBinary(dir: string, lifecyclePort?: number) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
    const binDir = path.join(dir, "bin");
    const fixturePath = yield* path.fromFileUrl(
      new URL("./testing/ClaudeTextGeneration.fixture.mjs", import.meta.url),
    );
    const source = yield* fs.readFileString(fixturePath);
    writeFakeCli({
      directory: binDir,
      name: "claude",
      platform,
      source:
        lifecyclePort === undefined
          ? source
          : `process.on("SIGTERM", () => {}); ${processProbeSource(lifecyclePort)}`,
    });
    return binDir;
  });
}

function withFakeClaudeEnv<A, E, R>(
  input: {
    output: string;
    unsupportedOptions?: ReadonlyArray<string>;
    investigation?: boolean;
    schemaProperty?: string;
    lifecyclePort?: number;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    argsMustNotContain?: string;
    stdinMustContain?: string;
    configDirMustBe?: string;
    cwdMustNotBe?: string;
    settingsMustEqual?: unknown;
    claudeConfig?: Partial<ClaudeSettings>;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-claude-text-" });
    const binDir = yield* makeFakeClaudeBinary(tempDir, input.lifecyclePort);
    const pathDelimiter = (yield* HostProcess.isWindows) ? ";" : ":";
    const environment = {
      ...process.env,
      PATH: `${binDir}${pathDelimiter}${process.env.PATH ?? ""}`,
      T3_FAKE_CLAUDE_OUTPUT: input.output,
      T3_FAKE_CLAUDE_UNSUPPORTED_OPTIONS: JSON.stringify(input.unsupportedOptions ?? []),
      T3_FAKE_CLAUDE_INVESTIGATION: input.investigation ? "1" : "",
      T3_FAKE_CLAUDE_SCHEMA_PROPERTY: input.schemaProperty ?? "",
      T3_FAKE_CLAUDE_EXIT_CODE: String(input.exitCode ?? 0),
      T3_FAKE_CLAUDE_STDERR: input.stderr ?? "",
      T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN: input.argsMustContain ?? "",
      T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN: input.argsMustNotContain ?? "",
      T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN: input.stdinMustContain ?? "",
      T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE: input.configDirMustBe ?? "",
      T3_FAKE_CLAUDE_CWD_MUST_NOT_BE: input.cwdMustNotBe ?? "",
      T3_FAKE_CLAUDE_SETTINGS_MUST_EQUAL: JSON.stringify(input.settingsMustEqual) ?? "",
    };
    const config = decodeClaudeSettings(input.claudeConfig ?? {});
    const textGeneration = yield* makeClaudeTextGeneration(
      config,
      environment,
      Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(layerClaudeTextGenerationTest)("ClaudeTextGeneration", (it) => {
  it.effect("meters auxiliary tokens using configured rates rather than CLI reported dollars", () =>
    Effect.gen(function* () {
      const balance = yield* ApiCreditBalance.make;
      const instanceId = ProviderInstanceId.make("claudeAgent");
      yield* balance.configure(instanceId, {
        linkedPlanInstanceId: ProviderInstanceId.make("plan"),
        grantUsd: 100,
        cycleEnd: "2026-12-01T00:00:00.000Z",
      });
      yield* withFakeClaudeEnv(
        {
          claudeConfig: { billingKind: "payPerUse", apiKey: "test-only-key" },
          output: JSON.stringify({
            is_error: false,
            total_cost_usd: 999,
            modelUsage: {
              "priced-model": {
                inputTokens: 10,
                outputTokens: 3,
                cacheReadInputTokens: 2,
                cacheCreationInputTokens: 1,
              },
            },
            structured_output: { title: "Meter tokens" },
          }),
        },
        (service) =>
          service.generateThreadTitle({
            cwd: process.cwd(),
            message: "Meter tokens",
            modelSelection: { instanceId, model: SYNTHETIC_CLAUDE_STANDARD_MODEL },
          }),
      ).pipe(
        Effect.provideService(ApiCreditBalance.ApiCreditBalance, balance),
        Effect.provideService(TokenPricing, {
          priceTokens: (items) => {
            expect(items).toEqual([
              {
                model: "priced-model",
                totals: {
                  uncachedInputTokens: 10,
                  outputTokens: 3,
                  cachedInputTokens: 2,
                  cacheCreationTokens: 1,
                  reasoningTokens: 0,
                },
              },
            ]);
            return Effect.succeed([0.25]);
          },
        }),
      );
      expect((yield* balance.snapshot(instanceId))?.spendUsd).toBe(0.25);
    }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect(
    "keeps canonical built-in capabilities when a custom model collides with its alias",
    () =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title: "Improve orchestration flow",
              body: "Body",
            },
          }),
          argsMustContain: `--model ${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded] --effort max --settings {"fastMode":true,"ultracode":false,"disableAllHooks":true}`,
          claudeConfig: { customModels: [SYNTHETIC_CLAUDE_COLLIDING_ALIAS] },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generatePrContent({
              cwd: process.cwd(),
              baseBranch: "main",
              headBranch: "feature/claude-effect",
              commitSummary: "Improve orchestration",
              diffSummary: "1 file changed",
              diffPatch: "diff --git a/README.md b/README.md",
              modelSelection: {
                ...createModelSelection(
                  ProviderInstanceId.make("claudeAgent"),
                  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
                  [
                    { id: "effort", value: "max" },
                    { id: "fastMode", value: true },
                  ],
                ),
              },
            });

            expect(generated.title).toBe("Improve orchestration flow");
          }),
      ),
  );

  it.effect(
    "generates thread titles outside the project with tools, skills, and hooks disabled",
    () =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title:
                '  "Reconnect failures after restart because the session state does not recover"  ',
            },
          }),
          cwdMustNotBe: process.cwd(),
          stdinMustContain: "/call-script",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "/call-script",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe(
              sanitizeThreadTitle(
                '"Reconnect failures after restart because the session state does not recover"',
              ),
            );
          }),
      ),
  );

  it.effect("sends thread title instructions to the provider prompt", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { title: "Reconnect failures" } }),
        stdinMustContain: "Additional instructions:\nUse two to four words.",
      },
      (textGeneration) =>
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Investigate reconnect failures",
          instructions: "Use two to four words.",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
          },
        }),
    ),
  );

  const launchSettings = {
    disableAllHooks: false,
    fastMode: false,
    ultracode: true,
    env: { ANTHROPIC_VERTEX_PROJECT_ID: "issue-25017-marker" },
  };
  it.effect.each([
    { label: "inline JSON", inline: true },
    { label: "a request-cwd-relative file", inline: false },
  ])("merges --settings launch args from $label under T3 settings", ({ inline }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const requestCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-claude-settings-" });
      yield* fs.writeFileString(
        path.join(requestCwd, "launch-settings.json"),
        JSON.stringify(launchSettings),
      );
      return yield* withFakeClaudeEnv(
        {
          output: JSON.stringify({ structured_output: { title: "Use launch settings" } }),
          settingsMustEqual: {
            ...launchSettings,
            disableAllHooks: true,
            fastMode: true,
            ultracode: false,
          },
          claudeConfig: {
            launchArgs: `--settings '${inline ? JSON.stringify(launchSettings) : "launch-settings.json"}'`,
          },
        },
        (textGeneration) =>
          textGeneration.generateThreadTitle({
            cwd: requestCwd,
            message: "thread title",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("claudeAgent"),
              SYNTHETIC_CLAUDE_CAPABLE_MODEL,
              [{ id: "fastMode", value: true }],
            ),
          }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    [
      "malformed JSON",
      `--settings '{"env":'`,
      "The --settings launch argument is not a JSON object.",
    ],
    ["no value", "--settings", "The --settings launch argument needs a JSON object or file path."],
  ] as const)("rejects a --settings launch arg with %s", ([, launchArgs, detail]) =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { title: "Unused" } }),
        claudeConfig: { launchArgs },
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Name this thread",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            }),
          );

          expect(error.detail).toBe(detail);
        }),
    ),
  );

  it.effect("runs Claude text generation with the configured CLAUDE_CONFIG_DIR", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const claudeConfigDir = path.join(process.cwd(), ".claude-work-test");
      return yield* withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title: "Use Claude home",
            },
          }),
          configDirMustBe: claudeConfigDir,
          claudeConfig: { homePath: claudeConfigDir },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "thread title",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe(sanitizeThreadTitle("Use Claude home"));
          }),
      );
    }),
  );

  it.effect.each([
    { unsupportedOptions: ["--no-session-persistence"] },
    { unsupportedOptions: ["--safe-mode"] },
    { unsupportedOptions: ["--safe-mode", "--no-session-persistence"] },
  ])("retries without unsupported CLI options $unsupportedOptions", ({ unsupportedOptions }) =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { title: "Reconnect failures" } }),
        unsupportedOptions,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Investigate reconnect failures",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe("Reconnect failures");
        }),
    ),
  );

  const title = { title: "Reconnect failures" };
  const unknown = {
    inputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
  };
  it.effect.each([
    [
      "one row per model in its ledger",
      {
        type: "result",
        structured_output: title,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {
          "claude-main": {
            inputTokens: 10,
            cacheReadInputTokens: 100,
            cacheCreationInputTokens: 5,
            outputTokens: 7,
          },
          "claude-helper": {
            inputTokens: 2,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            outputTokens: 3,
          },
        },
      },
      [
        {
          model: "claude-main",
          inputTokens: 115,
          cacheReadTokens: 100,
          cacheWriteTokens: 5,
          outputTokens: 7,
        },
        {
          model: "claude-helper",
          inputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 3,
        },
      ],
    ],
    [
      "the call's usage under its model without a ledger",
      {
        type: "result",
        structured_output: title,
        usage: {
          input_tokens: 3,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 1,
          output_tokens: 4,
        },
      },
      [
        {
          model: `${SYNTHETIC_CLAUDE_STANDARD_MODEL}[expanded]`,
          inputTokens: 24,
          cacheReadTokens: 20,
          cacheWriteTokens: 1,
          outputTokens: 4,
        },
      ],
    ],
    [
      "an unknown input total when a cache count is missing",
      {
        type: "result",
        structured_output: title,
        usage: { input_tokens: 3, cache_read_input_tokens: 20, output_tokens: 4 },
      },
      [
        {
          model: `${SYNTHETIC_CLAUDE_STANDARD_MODEL}[expanded]`,
          inputTokens: null,
          cacheReadTokens: 20,
          cacheWriteTokens: null,
          outputTokens: 4,
        },
      ],
    ],
    [
      "an unknown call when the result carries no usage",
      { structured_output: title },
      [{ model: `${SYNTHETIC_CLAUDE_STANDARD_MODEL}[expanded]`, ...unknown }],
    ],
  ] as const)("reports %s, once across a flag retry", ([, output, expected]) => {
    const reports: Array<ReadonlyArray<TextGenerationCallUsage>> = [];
    return withFakeClaudeEnv(
      { output: JSON.stringify(output), unsupportedOptions: ["--safe-mode"] },
      (textGeneration) =>
        Effect.gen(function* () {
          yield* textGeneration
            .generateThreadTitle({
              cwd: process.cwd(),
              message: "Investigate reconnect failures",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            })
            .pipe(
              Effect.provideService(TextGenerationUsageSink, (calls) => {
                reports.push(calls);
              }),
            );

          expect(reports).toEqual([expected]);
        }),
    );
  });

  it.effect(
    "passes safe mode to the other generation operations and keeps investigation tools",
    () => {
      const input = {
        cwd: process.cwd(),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          SYNTHETIC_CLAUDE_STANDARD_MODEL,
        ),
      };
      return Effect.gen(function* () {
        yield* withFakeClaudeEnv(
          {
            output: JSON.stringify({
              structured_output: {
                subject: "Add sorting tests",
                body: "Cover the default sort order.",
                branch: "add-sorting-tests",
                summary: "A sign-in is needed.",
                needsPerson: true,
                solutions: [
                  { title: "Sign in", detail: "Use the browser.", command: "", agentCanDo: false },
                ],
                translation: { title: "Sign in", step: "Open the browser." },
              },
            }),
          },
          (textGeneration) =>
            Effect.gen(function* () {
              yield* textGeneration.generateCommitMessage({
                ...input,
                branch: "main",
                stagedSummary: "1 file changed",
                stagedPatch: "diff --git a/sort.test.ts b/sort.test.ts",
              });
              yield* textGeneration.generateBranchName({ ...input, message: "Add sorting tests" });
              yield* textGeneration.generateManualStepReview({
                ...input,
                step: {
                  title: "Sign in",
                  step: "Open the browser.",
                  machine: "test",
                  kind: "hands-on",
                },
                notes: [],
                language: "en",
              });
            }),
        );
        yield* withFakeClaudeEnv(
          {
            output: JSON.stringify({ structured_output: { stops: [] } }),
            investigation: true,
            schemaProperty: "stops",
          },
          (textGeneration) =>
            textGeneration.generateReviewGuide({
              ...input,
              number: 1,
              title: "Add sorting tests",
              description: "",
              baseBranch: "main",
              baseCommit: "abc123",
              settledReview: "",
              language: "en",
            }),
        );
      });
    },
  );

  it.effect.each([
    { verbose: false, label: "normal" },
    { verbose: true, label: "verbose" },
  ])("unwraps a JSON title in $label Claude output", ({ verbose }) => {
    const result = {
      type: "result",
      structured_output: { title: '{"title": "Refresh ev-stg APP ASG instances"}' },
    };
    return withFakeClaudeEnv(
      { output: JSON.stringify(verbose ? [result] : result) },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Refresh ev-stg APP ASG instances",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe("Refresh ev-stg APP ASG instances");
        }),
    );
  });

  it.effect.each([
    { previousTitle: undefined, label: "generating" },
    { previousTitle: "Old thread title", label: "regenerating" },
  ])("reads the result from verbose Claude output when $label a title", ({ previousTitle }) =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify([
          { type: "system", subtype: "init" },
          { type: "assistant", message: { content: [] } },
          { type: "user", message: { content: [] } },
          { type: "rate_limit_event" },
          {
            type: "result",
            subtype: "success",
            result: '{"title":"Refresh ev-stg APP ASG Instances"}',
            structured_output: { title: "Refresh ev-stg APP ASG Instances" },
          },
        ]),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Refresh ev-stg APP ASG instances",
            previousTitle,
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe("Refresh ev-stg APP ASG Instances");
        }),
    ),
  );

  it.effect.each([
    ["empty message array", []],
    ["missing result", [{ type: "assistant", structured_output: { title: "Not a result" } }]],
    ["invalid title", [{ type: "result", structured_output: { title: 42 } }]],
    [
      "final result without structured output",
      [
        { type: "result", structured_output: { title: "Earlier result" } },
        { type: "result", subtype: "error_max_structured_output_retries" },
      ],
    ],
  ] as const)("rejects verbose Claude output with %s", ([, output]) =>
    withFakeClaudeEnv({ output: JSON.stringify(output) }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          }),
        );

        expect(error._tag).toBe("TextGenerationError");
      }),
    ),
  );

  const apiError = "API Error: 400 Model blocked by guardrail: 4 endpoints excluded";
  const wrapperNotice = "Using the OpenRouter credential from the global credential file.";
  it.effect.each([
    [
      "the stdout error over a stderr notice",
      JSON.stringify({ is_error: true, api_error_status: 400, result: apiError }),
      apiError,
    ],
    [
      "the verbose stdout error over a stderr notice",
      JSON.stringify([
        { type: "system", subtype: "init" },
        { type: "result", is_error: true, result: apiError },
        { type: "result", is_error: true, result: " " },
      ]),
      apiError,
    ],
    ["stderr when stdout has no error", "not json", wrapperNotice],
    [
      "a stdout error naming --no-session-persistence without retrying",
      JSON.stringify({
        is_error: true,
        result: "error: unknown option '--no-session-persistence'",
      }),
      "error: unknown option '--no-session-persistence'",
    ],
  ] as const)("reports %s when the Claude CLI fails", ([, output, expected]) =>
    withFakeClaudeEnv({ output, stderr: wrapperNotice, exitCode: 1 }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          }),
        );

        expect(error.detail).toBe(`Claude CLI command failed: ${expected}`);
      }),
    ),
  );

  // A retry here would drop --safe-mode, which the fake binary rejects with a different error.
  it.effect.each([
    [
      "a structured Claude error when stderr also shows a flag diagnostic",
      JSON.stringify({ is_error: true, result: "API Error: 429 rate limited" }),
      "error: unknown option '--safe-mode'",
      "API Error: 429 rate limited",
    ],
    [
      "stderr that only quotes a flag diagnostic",
      "not json",
      "wrapper: previously saw error: unknown option '--safe-mode'",
      "wrapper: previously saw error: unknown option '--safe-mode'",
    ],
  ] as const)("reports %s without retrying", ([, output, stderr, expected]) =>
    withFakeClaudeEnv({ output, stderr, exitCode: 1 }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          }),
        );

        expect(error.detail).toBe(`Claude CLI command failed: ${expected}`);
      }),
    ),
  );

  it.effect.each([
    [
      "structured 5-hour limit error",
      JSON.stringify({ is_error: true, result: "5-hour limit reached ∙ resets 3pm" }),
      "",
      false,
    ],
    [
      "structured organization model-disabled error",
      JSON.stringify({ is_error: true, result: "Your organization has disabled this model" }),
      "",
      false,
    ],
    [
      "structured api_error_status 429 envelope",
      JSON.stringify({ is_error: true, api_error_status: 429, result: "Upstream throttled" }),
      "",
      false,
    ],
    [
      "verbose assistant authentication_failed error",
      JSON.stringify([
        { type: "assistant", error: "authentication_failed" },
        { type: "result", is_error: true, result: "Session rejected" },
      ]),
      "",
      false,
    ],
    [
      "noisy MCP stderr without structured JSON",
      "not json",
      'MCP server "linear" connection failed: HTTP 403 Forbidden',
      undefined,
    ],
    [
      "transient 503 stdout error",
      JSON.stringify({ is_error: true, api_error_status: 503, result: "Service Unavailable" }),
      "",
      undefined,
    ],
  ] as const)(
    "sets retryable=%s on Claude CLI failure (%s)",
    ([, output, stderr, expectedRetryable]) =>
      withFakeClaudeEnv({ output, stderr, exitCode: 1 }, (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Name this thread",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            }),
          );

          expect(error.retryable).toBe(expectedRetryable);
        }),
      ),
  );

  it.effect.each(["interrupted", "timed out"] as const)(
    "reports one unknown-count row when a spawned Claude CLI is %s",
    (outcome) =>
      Effect.gen(function* () {
        const probe = yield* makeProcessProbe;
        const reported: TextGenerationCallUsage[] = [];
        yield* withFakeClaudeEnv({ output: "", lifecyclePort: probe.port }, (textGeneration) =>
          Effect.gen(function* () {
            const fiber = yield* textGeneration
              .generateThreadTitle({
                cwd: process.cwd(),
                message: "Name this thread",
                modelSelection: {
                  instanceId: ProviderInstanceId.make("claudeAgent"),
                  model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
                },
              })
              .pipe(
                Effect.provideService(TextGenerationUsageSink, (entries) => {
                  reported.push(...entries);
                }),
                Effect.forkScoped,
              );
            yield* probe.started;

            if (outcome === "interrupted") {
              const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
              yield* probe.exited;
              yield* Fiber.join(interrupted);
              const exit = yield* Fiber.await(fiber);
              expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
            } else {
              yield* TestClock.adjust("181 seconds");
              yield* probe.exited;
              const error = yield* Effect.flip(Fiber.join(fiber));
              expect(error.detail).toContain("timed out");
            }

            expect(reported).toEqual([
              {
                model: `${SYNTHETIC_CLAUDE_STANDARD_MODEL}[expanded]`,
                inputTokens: null,
                cacheReadTokens: null,
                cacheWriteTokens: null,
                outputTokens: null,
              },
            ]);
          }),
        );
      }),
  );
});
