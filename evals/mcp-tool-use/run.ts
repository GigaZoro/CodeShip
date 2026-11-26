#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import {
  offeredOptionSelections,
  resolveSelectableModel,
  type SelectableModelOption,
} from "@t3tools/shared/model";
import { autoModeModelFor } from "@t3tools/shared/serverSettings";
/**
 * Replays small fake threads on a Claude or Codex model to check T3's MCP tool use. A trimmed
 * harness capture supplies the prompt and native tools; a cheap model plays the shell. See
 * README.md for how to run it and add cases.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { parseCommandLine } from "../../scripts/lib/command-line.ts";
import * as NodeVM from "node:vm";
import * as NodeZlib from "node:zlib";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { formatSharedSkillPrompt, SharedSkillInstructions } from "@t3tools/shared/providerSkills";
import {
  AutoModeModel,
  ComposerContextRecord,
  DEFAULT_RUN_CONDITION_TIMEOUT_SECONDS,
  DeviceOperationError,
  DeviceSummary,
  OrchestrationV2DispatchCommandResult,
  OrchestratorMcpDeleteScheduledTaskResult,
  OrchestratorMcpListScheduledTasksResult,
  OrchestratorMcpScheduleTaskResult,
  OrchestratorMcpSaveScheduledTaskInput,
  ProjectId,
  ScheduledTaskId,
  SCHEDULED_TASK_CLAIM_PROTOCOL,
  OrchestratorMcpTaskRole,
  PreviewAutomationError,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { Tool } from "effect/ai";
import * as McpSchema from "effect/ai/McpSchema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { GIT_OUTPUT_MAX_BYTES } from "../../.github/scripts/git-history.cjs";
import { runConditionCommandProblem } from "../../apps/server/src/scheduledTasks/RunConditionCheck.ts";
import { nextScheduledRunAt } from "../../apps/server/src/scheduledTasks/Schedule.ts";
import { taskPrompt } from "../../apps/server/src/mcp/delegatedTaskModes.ts";
import * as McpInvocationContext from "../../apps/server/src/mcp/McpInvocationContext.ts";
import { advertisedJsonSchema } from "../../apps/server/src/mcp/advertisedJsonSchema.ts";
import * as Contracts from "@t3tools/contracts";
import {
  EnvironmentId,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  ProviderDriverKind,
  PullRequestState,
  ThreadId,
} from "@t3tools/contracts";
import {
  autoCoordinatorInstructions,
  AUTO_MODE_CONTEXT_KEY,
  autoModePromptBlock,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { THEME_GUIDE } from "@t3tools/shared/themeCss";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { buildCodexAdditionalContext } from "../../apps/server/src/provider/CodexDeveloperInstructions.ts";
import { PULL_REQUEST_LINKING_INSTRUCTIONS } from "@t3tools/provider-core/server/runtimeInstructions";
import { makeSideChatContext } from "../../apps/server/src/orchestration-v2/ContextHandoffService.ts";
import { withInlineContext } from "../../apps/server/src/orchestration-v2/ContextHandoffDelivery.ts";
import { AttachmentToolkit } from "../../apps/server/src/mcp/toolkits/attachment/tools.ts";
import { DeviceToolkit } from "../../apps/server/src/mcp/toolkits/device/tools.ts";
import { FeedbackToolkit } from "../../apps/server/src/mcp/toolkits/feedback/tools.ts";
import {
  FEEDBACK_AWAITING_APPROVAL_NOTE,
  FEEDBACK_SUBJECT_MESSAGE,
  FeedbackInput,
  FeedbackNotRequestedError,
  resolveFeedbackSubject,
} from "../../apps/server/src/feedback/FeedbackReport.ts";
import { scrubFeedback } from "../../apps/server/src/feedback/scrubFeedback.ts";
import { EnvironmentToolkit } from "../../apps/server/src/mcp/toolkits/environment/tools.ts";
import { HtmlToolkit } from "../../apps/server/src/mcp/toolkits/html/tools.ts";
import { IssuesToolkit } from "../../apps/server/src/mcp/toolkits/issues/tools.ts";
import { MessageToolkit } from "../../apps/server/src/mcp/toolkits/message/tools.ts";
import { OrchestratorToolkit } from "../../apps/server/src/mcp/toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "../../apps/server/src/mcp/toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "../../apps/server/src/mcp/toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "../../apps/server/src/mcp/toolkits/project/tools.ts";
import { ProviderMcpToolkit } from "../../apps/server/src/mcp/toolkits/providerMcp/tools.ts";
import {
  CHILD_PULL_REQUEST_REPORT_NEXT,
  PullRequestsToolkit,
} from "../../apps/server/src/mcp/toolkits/pullRequests/tools.ts";
import { TerminalToolkit } from "../../apps/server/src/mcp/toolkits/terminal/tools.ts";
import { ThemeToolkit } from "../../apps/server/src/mcp/toolkits/theme/tools.ts";
import { ThreadToolkit } from "../../apps/server/src/mcp/toolkits/thread/tools.ts";
import { WorktreeToolkit } from "../../apps/server/src/mcp/toolkits/worktree/tools.ts";
import {
  CLAUDE_PROVIDER,
  makeClaudeQueryOptions,
} from "../../apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  openAiConnection,
  publicResponsesRequest,
  readCodexConnection,
  selectEvalProvider,
  type OpenAiConnection,
} from "./providers.ts";
import { proxyConfig } from "../shared/proxy.ts";
import { changeRequestsCreatedBy } from "../../apps/server/src/orchestration-v2/PullRequestSyncReactor.ts";
import { AGENT_SHELL_TOOLS, DeviceExpect, gradeDevice } from "./device-grading.ts";
import { FileLinksExpect, gradeFileLinks } from "./file-link-grading.ts";
import {
  AGENT_DEVICE_SHELL,
  deviceFailure,
  type DeviceTools,
  isDeviceTool,
  launcherHelp,
  makeDeviceTools,
} from "./devices.ts";
import {
  argvForm,
  gradeSecret,
  scriptsBefore,
  UNKNOWN_SCRIPT,
  scriptSources,
  SecretExpect,
  secretDiagnostics,
} from "./secret-grading.ts";
/** Agent models by id, with the display name a harness gives them. */
const MODELS = {
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-opus-5-5": "Opus 5.5",
  "gpt-6.1-sol": "GPT-6.1 Sol",
  "gpt-6-astra": "GPT-6 Astra",
  "gpt-6-luna": "GPT-6 Luna",
} as const;
type Model = keyof typeof MODELS;
/** GPT models replay a Codex capture, the rest a Claude Code capture. */
const isCodex = (model: Model): model is Extract<Model, `gpt-${string}`> =>
  model.startsWith("gpt-");
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
// USD per million tokens. Cache writes use the 5-minute rate.
export const PRICES = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
};
type PricedModel = keyof typeof PRICES;
/** GPT models that can play the shell through CLIProxyAPI, when no Anthropic key is at hand. */
type ShellModel = PricedModel | Model;
const isPricedModel = (model: ShellModel): model is PricedModel => model in PRICES;
const T3_PREFIX = "mcp__t3-code__";
const RUNTIME_MARKER = "<runtime_info>";
const TOOL_LOADED = "Tool loaded.";

class EvalToolCallError extends Schema.TaggedError<EvalToolCallError>()("EvalToolCallError", {
  tool: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `The ${this.tool} tool call failed.`;
  }
}
const DEFERRED_LIST =
  /(The following deferred tools are now available via ToolSearch\.[^\n]*\n)((?:[^\n]+\n)*)/;
const MODEL_LINE = /You are powered by the model named .+?\. The exact model ID is [\w.-]+\./;
// API keys can be billed differently for requests that open with Claude Code's identity line,
// so every copy of it becomes a neutral line. The rest of the captured prompt is unchanged.
const IDENTITY =
  /You are Claude Code, Anthropic's official CLI for Claude(?:, running within the Claude Agent SDK)?\./g;
const NEUTRAL_IDENTITY = "You are an AI coding agent running in the user's terminal.";

type Block = { readonly type: string; readonly [key: string]: unknown };
type ApiMessage = { readonly role: "user" | "assistant"; readonly content: ReadonlyArray<Block> };
type ApiTool = { readonly name: string; readonly [key: string]: unknown };
type Usage = Record<keyof (typeof PRICES)[PricedModel], number>;
type Call = {
  readonly step: number;
  readonly tool: string;
  readonly input: unknown;
  /** The tool_use id, when the call was a tool use of its own. */
  readonly id?: string;
  /** Once answered: whether the agent saw an error, and the result text it saw. */
  failed?: boolean;
  output?: string;
};
export type SampleRun = {
  readonly calls: ReadonlyArray<Call>;
  text: string;
  stopReason: string;
  /** The agent's final answer: its last response's text, if it ended its turn. */
  readonly finalText?: string;
  /** PRs linked to the thread when the sample ends, by the agent or by T3. */
  readonly linked?: ReadonlyArray<string>;
  /** The thread's working directory, which chat resolves relative file pills against. */
  readonly cwd?: string;
  /** The `agent-device` commands T3's device_open returned, prior turns included. */
  readonly launchers?: ReadonlyArray<string>;
};

const Rest = [Schema.Record(Schema.String, Schema.Unknown)] as const;

const PriorToolCall = Schema.Struct({
  tool: Schema.String,
  input: Schema.Unknown,
  /**
   * For a device tool, `"default"` runs the call on the world's devices for T3's result.
   */
  result: Schema.Unknown,
  /** Repository-relative file whose current contents supply this tool result. */
  resultFile: Schema.optional(Schema.String),
});

/**
 * One expected call. `args` match partially: `~text` is a case-insensitive substring (`~a|b`: any one),
 * `/regex/` and `re:pattern` regexes, `"<=N"` / `">=N"` bound a number, and keys may be dotted paths. With
 * `succeeded`, only a call answered without an error matches. `null` also matches a missing key.
 */
const McpToolUseCall = Schema.Struct({
  tool: Schema.String,
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  succeeded: Schema.optional(Schema.Literal(true)),
});
const McpToolUseCallWithAlternatives = Schema.Struct({
  ...McpToolUseCall.fields,
  argsAnyOf: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
});
const McpToolUseExpectedCall = Schema.Struct({
  ...McpToolUseCallWithAlternatives.fields,
  success: Schema.optional(Schema.Literal(true)),
});
type McpToolUseCall = typeof McpToolUseExpectedCall.Type;

/** Grading rules. Tool names are bare: `delegate_task`, `Bash`, `Agent`. */
const McpToolUseCallsExpect = Schema.Struct({
  /** Each entry needs one matching call. */
  calls: Schema.optional(Schema.Array(McpToolUseExpectedCall)),
  /** At least one call must match one of these alternatives. */
  callsAnyOf: Schema.optional(Schema.Array(McpToolUseExpectedCall)),
  /** Each entry matches a different call, and no call matches two entries; tool names are exact. */
  distinctCalls: Schema.optional(Schema.Array(McpToolUseCall)),
  minCalls: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  maxCalls: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
});

/** One `anyOf` alternative: call checks, and text checks that must hold on the same path. */
const McpToolUseAlternative = Schema.Struct({
  ...McpToolUseCallsExpect.fields,
  textMust: Schema.optional(Schema.Array(Schema.String)),
  finalTextMust: Schema.optional(Schema.Array(Schema.String)),
});

const McpToolUseExpect = Schema.Struct({
  /** Keep this release's owner active and resume it once verification becomes possible. */
  pendingRelease: Schema.optional(
    Schema.Struct({
      threadId: Schema.String,
      retryAfter: Schema.String,
      /** Case-insensitive patterns identifying this delivery, its outstanding check and its evidence. */
      promptMust: Schema.NonEmptyArray(Schema.NonEmptyString),
      /** Known command exit codes at the scheduled occurrence on this fixture's machine. */
      conditionExitCodes: Schema.optional(Schema.Record(Schema.String, Schema.Int)),
    }),
  ),
  ...McpToolUseCallsExpect.fields,
  /** Passes when one alternative passes every one of its checks. */
  anyOf: Schema.optional(Schema.Array(McpToolUseAlternative)),
  /** No call may match any entry. */
  callsMustNot: Schema.optional(Schema.Array(McpToolUseCallWithAlternatives)),
  notCalls: Schema.optional(Schema.Array(Schema.String)),
  /** First calls of these tools happen in this order. */
  order: Schema.optional(Schema.Array(Schema.String)),
  /**
   * One `args`-style value per new top-level thread the agent asks for, by `t3_thread_launch` or a
   * `create_threads` entry. Each matches a different thread's request; no other thread is asked for.
   */
  newThreads: Schema.optional(Schema.Array(Schema.Unknown)),
  /** The last step with tool calls includes this tool, then the turn ends. */
  endsTurnAfter: Schema.optional(Schema.String),
  /**
   * Regexes that no shell command may match. A command also carries the source of the scripts it
   * runs that the agent wrote earlier in the sample.
   */
  shellMustNot: Schema.optional(Schema.Array(Schema.String)),
  /** Regexes that some shell command must match, each. */
  shellMust: Schema.optional(Schema.Array(Schema.String)),
  /** Case-sensitive regexes on the agent's visible text. */
  textMust: Schema.optional(Schema.Array(Schema.String)),
  textMustNot: Schema.optional(Schema.Array(Schema.String)),
  /** Case-sensitive regexes on the final answer: the last response's text, once the turn ended. */
  finalTextMust: Schema.optional(Schema.Array(Schema.String)),
  /** Each entry matches a PR URL linked at the end, as `args` values match. */
  linked: Schema.optional(Schema.Array(Schema.String)),
  /** The PR numbers linked at the end, exactly. */
  linkedNumbers: Schema.optional(Schema.Array(Schema.Number)),
  /** Device manager checks: child briefs, simulator UI over the shell, failures, recordings. */
  device: Schema.optional(DeviceExpect),
  /**
   * Secret checks: chat asks in text and question tools, where fixture values went, and how the
   * files request_secret returned were read. See `SecretExpect` in secret-grading.ts.
   */
  secret: Schema.optional(SecretExpect),
  /** File pills in the final answer resolve against the thread cwd to `world.files` entries. */
  fileLinks: Schema.optional(FileLinksExpect),
});

/**
 * The agent's machine, as the shell simulator and the gitStatus reminder see it. Only these keys
 * are typed; others (files, diff, prs, pages) are free-form facts for the simulator.
 */
const McpToolUseWorld = Schema.StructWithRest(
  Schema.Struct({
    /** GitHub `owner/name`. Defaults to `acme/app`. */
    repo: Schema.optional(Schema.String),
    /** `origin`'s host and path, such as `git.cafe/acme/app`. Defaults to `github.com/<repo>`. */
    remote: Schema.optional(Schema.String),
    /** The branch has commits but no upstream: T3's pull_request_create refuses until a push. */
    unpushed: Schema.optional(Schema.Boolean),
    branch: Schema.optional(Schema.String),
    /** `git status --short` lines. */
    status: Schema.optional(Schema.String),
    /** Newest first. On a branch other than main, these are the commits main lacks. */
    commits: Schema.optional(
      Schema.Array(
        Schema.StructWithRest(Schema.Struct({ sha: Schema.String, subject: Schema.String }), Rest),
      ),
    ),
    /** Simulators and emulators. With them, T3's device tools answer from this world. */
    devices: Schema.optional(Schema.Array(DeviceSummary)),
    /** Labels of the SSH device hosts in `devices`, by id. The local host always exists. */
    deviceHosts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    /**
     * agent-device sessions that prior turns started, by device id, with the app `open` put in
     * each. Otherwise a device's session starts at its launcher's first `open` in the sample.
     */
    agentDeviceSessions: Schema.optional(
      Schema.Record(Schema.String, Schema.Struct({ app: Schema.optional(Schema.String) })),
    ),
    /**
     * Hosts whose hub fails to list devices, by id, with the error, such as F1's
     * `{"_tag": "DeviceOperationError", "operation": "list", "reason": "request_failed", "cause": null}`.
     * T3 marks each one failed on every call and lists none of its devices.
     */
    deviceDiscoveryFailures: Schema.optional(Schema.Record(Schema.String, DeviceOperationError)),
    /** false: agent device access is off. T3 denies every device call and drops its device text. */
    deviceAgentAccess: Schema.optional(Schema.Boolean),
    /** false: agent browser access is off. T3 denies every preview call and drops its browser text. */
    browserAgentAccess: Schema.optional(Schema.Boolean),
    /** The Agent feedback mode; absent is off. On, T3 lists its tools and its text has the mode's line. */
    agentFeedback: Schema.optional(Contracts.AgentFeedbackMode),
    /** Every capture reaches T3 with adb screencap's warning ahead of the PNG: T3 reports 0×0. */
    deviceInvalidCapture: Schema.optional(Schema.Boolean),
    /** Devices another thread's agent-device session holds, by device id: that thread's id. */
    deviceOwners: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    /** The world's `prs`, bottom first, form one native stack with this number. */
    stack: Schema.optional(Schema.Number),
    /** PRs already linked to the thread, with the state T3 last saw. */
    linkedPullRequests: Schema.optional(
      Schema.Array(
        Schema.Struct({ number: Schema.Number, state: PullRequestState, title: Schema.String }),
      ),
    ),
  }),
  Rest,
);

/** One fake thread, one JSON object per line in a case file. */
export const McpToolUseCase = Schema.Struct({
  id: Schema.String,
  area: Schema.String,
  kind: Schema.Literals(["bad", "guard", "control"]),
  pattern: Schema.String,
  experience: Schema.String,
  rule: Schema.optional(Schema.String),
  privacy: Schema.optional(Schema.Literals(["commit-safe", "private"])),
  setup: Schema.Struct({
    role: Schema.Literals(["top", "delegated-child", "native-subagent"]),
    /** Runs only on this harness, for cases whose right answer depends on it. */
    harness: Schema.optional(Schema.Literals(["claude", "codex"])),
    /** The Linked environments beta is on, so T3 lists its link tools. */
    linkedEnvironments: Schema.optional(Schema.Boolean),
    /** The thread's machine runs Windows: the template's OS, shell and paths say so. */
    platform: Schema.optional(Schema.Literal("win32")),
    /** Fix the harness and simulated tools to the same UTC day for a time-sensitive scenario. */
    date: Schema.optional(Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))),
    /** false: the project is on no forge T3 reads, so T3 hides its forge tools. */
    forge: Schema.optional(Schema.Boolean),
    /** delegate_task `role` for a delegated child. T3 builds the child's first message from it. */
    delegateRole: Schema.optional(OrchestratorMcpTaskRole),
    context: Schema.optional(Schema.String),
    priorTurns: Schema.optional(
      Schema.Array(
        Schema.Struct({
          role: Schema.Literals(["user", "assistant"]),
          text: Schema.optional(Schema.String),
          toolCalls: Schema.optional(Schema.Array(PriorToolCall)),
        }),
      ),
    ),
    world: Schema.optional(McpToolUseWorld),
    /**
     * Canned tool results by bare name, T3 or native. `"default"` uses the runner's result. For a
     * device tool, a T3 `DeviceError` (`{"_tag": ..., "cause": null}`) fails it inside T3; for a
     * preview tool, a `PreviewAutomationError` fails it with that error's message. A
     * `{"$sequence": [...]}` mock answers its nth call with the nth result, then repeats the last.
     */
    mocks: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    /** Regexes on one part of a shell command. A match wins over the shell simulator. */
    shellMocks: Schema.optional(
      Schema.Array(Schema.Struct({ match: Schema.String, output: Schema.String })),
    ),
    /** The thread is a side chat's first turn: T3 puts the parent's digest ahead of `prompt`. */
    sideChat: Schema.optional(
      Schema.Struct({ parentThreadId: Schema.String, digest: Schema.Array(Schema.String) }),
    ),
    /** The turn runs in Auto mode: T3 puts the coordinator brief ahead of `prompt`. */
    autoMode: Schema.optional(Schema.Boolean),
    autoModeModels: Schema.optional(Schema.Record(Schema.String, AutoModeModel)),
    otherAutoProviders: Schema.optional(
      Schema.Array(
        Schema.Struct({
          providerInstanceId: Schema.String,
          displayName: Schema.String,
          driver: ProviderDriverKind,
          models: Schema.Array(
            Schema.Struct({
              slug: Schema.String,
              name: Schema.String,
              aliases: Schema.optionalKey(Schema.Array(Schema.String)),
              effort: Schema.optionalKey(
                Schema.Struct({ id: Schema.String, values: Schema.Array(Schema.String) }),
              ),
            }),
          ),
        }),
      ),
    ),
  }),
  /** Empty to resume a top-level thread without side-chat context after its last tool result. */
  prompt: Schema.String,
  promptSkills: Schema.optional(Schema.Array(SharedSkillInstructions)),
  /** Read the invoked project skill from .agents/skills in the checkout being evaluated. */
  projectSkill: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-z0-9-]+$/))),
  /** Records for the context chips `prompt` links, projected as T3 sends them. */
  promptContext: Schema.optional(Schema.Struct({ records: Schema.Array(ComposerContextRecord) })),
  expect: McpToolUseExpect,
  /**
   * The checks for `--arm raw`, when its right outcome differs, as when only T3 can watch a PR.
   * Otherwise both arms are graded on `expect`.
   */
  expectRaw: Schema.optional(McpToolUseExpect),
  /** Model calls this case may need. Overrides `--max-steps`. */
  maxSteps: Schema.optional(Schema.Number),
  source: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  notes: Schema.optional(Schema.String),
});
export type McpToolUseCase = typeof McpToolUseCase.Type;
const AnyBlock = Schema.StructWithRest(
  Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  Rest,
);
const Content = Schema.Union([Schema.String, Schema.Array(AnyBlock)]);
const MessagesRequest = Schema.Struct({
  system: Schema.optional(Content),
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Content })),
  tools: Schema.Array(Schema.StructWithRest(Schema.Struct({ name: Schema.String }), Rest)),
});
// A CLIProxyAPI capture keeps the Anthropic body at request.provider_native.
const Capture = Schema.Struct({ request: Schema.Struct({ provider_native: MessagesRequest }) });
const ResponsesRequest = Schema.StructWithRest(
  Schema.Struct({
    input: Schema.Array(AnyBlock),
    reasoning: Schema.StructWithRest(Schema.Struct({ effort: Schema.String }), Rest),
  }),
  Rest,
);
const CodexCapture = Schema.Struct({
  request: Schema.Struct({ provider_native: ResponsesRequest }),
});
const ToolUse = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
});
const isToolUse = Schema.is(ToolUse);
const isText = Schema.is(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }));
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const Count = Schema.optional(Schema.NullOr(Schema.Number));
const ApiResponse = Schema.Struct({
  content: Schema.Array(AnyBlock),
  stop_reason: Schema.NullOr(Schema.String),
  usage: Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
    cache_creation_input_tokens: Count,
    cache_read_input_tokens: Count,
  }),
});

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const addUsage = (total: Usage, usage: typeof ApiResponse.Type.usage) => {
  total.input += usage.input_tokens;
  total.output += usage.output_tokens;
  total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  total.cacheRead += usage.cache_read_input_tokens ?? 0;
};

const text = (value: string): Block => ({ type: "text", text: value });
const developerText = (value: string): Block => ({ ...text(value), developer: true });
const autoModeDeveloperMessage = (brief: string) =>
  `<${AUTO_MODE_CONTEXT_KEY}>${brief}</${AUTO_MODE_CONTEXT_KEY}>`;
const reminder = (value: string) => text(`<system-reminder>\n${value}\n</system-reminder>`);
const valueText = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");
const toolResult = (id: string, content: unknown): Block => ({
  type: "tool_result",
  tool_use_id: id,
  content: valueText(content),
});
const texts = (content: typeof Content.Type) =>
  typeof content === "string" ? [content] : content.flatMap((block) => block.text ?? []);
const isT3Name = (name: string) => name.startsWith(T3_PREFIX) || name.startsWith("mcp__t3_code__");
const hasTool = (tools: ReadonlyArray<ApiTool>, name: string) =>
  tools.some((tool) => tool.name === name);

/** Grading name: T3 tools lose their MCP prefix, native tools keep the part after the last `_`. */
const CODEX_NAMES: Readonly<Record<string, string>> = {
  exec_command: "Bash",
  shell_command: "Bash",
  shell: "Bash",
  spawn_agent: "Agent",
  apply_patch: "Edit",
  request_user_input: "AskUserQuestion",
  request_user_input_async: "AskUserQuestion",
  write_stdin: "write_stdin",
  web__run: "WebFetch",
};
export const normalizeToolName = (name: string) => {
  const bare = name.slice(name.lastIndexOf(".") + 1);
  return isT3Name(bare)
    ? bare.slice(T3_PREFIX.length)
    : (CODEX_NAMES[bare] ?? bare.slice(bare.lastIndexOf("_") + 1));
};
export const normalizeToolInput = (name: string, input: unknown) => {
  const decode = t3InputDecoders.get(normalizeToolName(name));
  if (decode !== undefined) return Option.getOrElse(decode(input), () => input);
  return normalizeToolName(name) === "Bash" && isRecord(input)
    ? { ...input, command: input.command ?? input.cmd }
    : typeof input === "string" && normalizeToolName(name) === "Edit"
      ? { patch: input }
      : input;
};

// McpHttpServer advertises each tool's JSON schema, and Claude Code passes the MCP name,
// description, and schema through unchanged.
const t3SourceTools: ReadonlyArray<Tool.Any> = [
  OrchestratorToolkit,
  ThreadToolkit,
  AttachmentToolkit,
  ProjectToolkit,
  EnvironmentToolkit,
  ProviderMcpToolkit,
  ThemeToolkit,
  FeedbackToolkit,
  PreviewControlsToolkit,
  WorktreeToolkit,
  PullRequestsToolkit,
  PreviewToolkit,
  IssuesToolkit,
  DeviceToolkit,
  HtmlToolkit,
  TerminalToolkit,
  MessageToolkit,
].flatMap((toolkit): ReadonlyArray<Tool.Any> => Object.values(toolkit.tools));
// McpHttpServer decodes arguments with each tool's JSON codec, which drops undeclared keys.
const t3InputDecoders = new Map(
  t3SourceTools.map((tool) => [
    tool.name,
    Schema.decodeUnknownOption(
      Schema.toCodecJson(tool.parametersSchema as Schema.Codec<unknown, unknown>),
    ),
  ]),
);
const t3Tools: ReadonlyArray<ApiTool> = t3SourceTools.map((tool) => ({
  name: `${T3_PREFIX}${tool.name}`,
  description: Tool.getDescription(tool) ?? "",
  input_schema: advertisedJsonSchema(tool),
}));
// T3 gates these on the `preview` capability, which agent browser access decides.
const PREVIEW_TOOLS = new Set(
  [PreviewToolkit, PreviewControlsToolkit].flatMap((toolkit) =>
    Object.values(toolkit.tools).map((tool: Tool.Any) => tool.name),
  ),
);
const decodePreviewError = Schema.decodeUnknownOption(PreviewAutomationError);
const previewFailure = (mock: unknown) => Option.getOrUndefined(decodePreviewError(mock));
const enabledWhen = (predicate: () => boolean) =>
  new Set(
    t3SourceTools
      .filter(
        (tool) => Context.getOrUndefined(tool.annotations, McpSchema.EnabledWhen) === predicate,
      )
      .map((tool) => `${T3_PREFIX}${tool.name}`),
  );
// Claude Code loads a tool whose `_meta` sets anthropic/alwaysLoad up front instead of deferring it.
const alwaysLoaded = new Set(
  t3SourceTools
    .filter((tool) => {
      const meta = Context.getOrUndefined(tool.annotations, Tool.Meta);
      return meta !== undefined && meta["anthropic/alwaysLoad"] === true;
    })
    .map((tool) => `${T3_PREFIX}${tool.name}`),
);
// Refs whose request_secret takes `value` save a secret the user already pasted, with no card.
export const savesPastedSecrets = t3Tools.some(
  (tool) =>
    tool.name === `${T3_PREFIX}request_secret` &&
    isRecord(tool.input_schema) &&
    isRecord(tool.input_schema.properties) &&
    "value" in tool.input_schema.properties,
);
/** A request_secret call that hands T3 a pasted secret, on a ref that takes one. */
const pastedSecret = (name: string, input: Readonly<Record<string, unknown>>) =>
  savesPastedSecrets && name === "request_secret" && typeof input.value === "string";
// T3 does not offer these to a delegated child, so its harness never lists them.
const hiddenFromSubagents = enabledWhen(McpInvocationContext.hiddenFromSubagents);
// The Linked environments beta starts off, and T3 lists its tools only while it is on.
const hiddenWhileLinksOff = enabledWhen(McpInvocationContext.hiddenWhileLinksOff);
// Agent feedback starts off, and T3 lists its tools only while it is on.
const hiddenWhileFeedbackOff = enabledWhen(McpInvocationContext.hiddenWhileFeedbackOff);
// T3 lists PR and CI tools only to a thread whose project is on a forge it reads.
const hiddenWithoutForge = enabledWhen(McpInvocationContext.hiddenWithoutForge);
/**
 * `tools` is T3 as shipped. `raw` takes away T3's PR, CI and issue tools and their instructions,
 * so the agent works the forge with CLIs alone, to measure what the tools save.
 */
export const ARMS = ["tools", "raw"] as const;
export type Arm = (typeof ARMS)[number];
const forgeToolNames = new Set(
  [PullRequestsToolkit, IssuesToolkit].flatMap((toolkit) =>
    Object.values(toolkit.tools).map((tool: Tool.Any) => `${T3_PREFIX}${tool.name}`),
  ),
);
/** T3's text for an arm: `raw` drops the PR linking block that names T3's PR tools. */
const forArm = (value: string, arm: Arm | undefined) =>
  arm === "raw" ? value.replace(`\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}`, "") : value;
const visibleT3Tools = (options: {
  readonly subagent?: boolean;
  readonly links?: boolean;
  readonly forge?: boolean;
  readonly agentFeedback?: Contracts.AgentFeedbackMode;
  readonly arm?: Arm;
}) =>
  t3Tools.filter(
    (tool) =>
      !(options.arm === "raw" && forgeToolNames.has(tool.name)) &&
      (options.links === true || !hiddenWhileLinksOff.has(tool.name)) &&
      ((options.agentFeedback ?? "off") !== "off" || !hiddenWhileFeedbackOff.has(tool.name)) &&
      (options.forge !== false || !hiddenWithoutForge.has(tool.name)) &&
      !(options.subagent === true && hiddenFromSubagents.has(tool.name)),
  );

/**
 * T3's Claude Code options for an eval thread: its system prompt append and its hooks. `device` and
 * `browser` say whether the thread holds the `device` and `preview` capabilities, as agent device
 * and browser access decide.
 */
const claudeQueryOptions = (
  model: Model,
  device = true,
  browser = true,
  agentFeedback: Contracts.AgentFeedbackMode = "off",
) => {
  // Refs whose text follows a capability read its flag; older ones ignore it.
  const input: Parameters<typeof makeClaudeQueryOptions>[0] & {
    readonly deviceToolsAvailable?: boolean;
    readonly browserToolsAvailable?: boolean;
  } = {
    modelSelection: { instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER), model },
    nativeThreadId: "mcp-tool-use-eval",
    resume: false,
    cwd: null,
    mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1/mcp" } },
    agentFeedback,
    deviceToolsAvailable: device,
    browserToolsAvailable: browser,
  };
  return makeClaudeQueryOptions(input);
};

/** Text T3 appends to Claude Code's system prompt. Delegated children get the same text. */
export const t3SystemAppend = (
  model: Model,
  device = true,
  browser = true,
  agentFeedback: Contracts.AgentFeedbackMode = "off",
) => {
  const { systemPrompt } = claudeQueryOptions(model, device, browser, agentFeedback);
  if (isRecord(systemPrompt) && systemPrompt.type === "preset" && systemPrompt.append) {
    return systemPrompt.append;
  }
  throw new Error("makeClaudeQueryOptions no longer appends T3 text to a preset prompt.");
};

/**
 * The context T3's SubagentStart hooks give a native subagent, which gets none of the append.
 * Empty when T3 registers no such hook.
 */
export const t3SubagentContext = async (model: Model, device = true, browser = true) => {
  const hooks = (claudeQueryOptions(model, device, browser).hooks?.SubagentStart ?? []).flatMap(
    (m) => m.hooks,
  );
  const input = {
    hook_event_name: "SubagentStart" as const,
    session_id: "mcp-tool-use-eval",
    transcript_path: "",
    cwd: "",
    agent_id: "mcp-tool-use-eval",
    agent_type: "general-purpose",
  };
  const outputs = await Promise.all(
    hooks.map((hook) => hook(input, undefined, { signal: AbortSignal.timeout(10_000) })),
  );
  return outputs
    .flatMap((output) =>
      "hookSpecificOutput" in output && output.hookSpecificOutput?.hookEventName === "SubagentStart"
        ? [output.hookSpecificOutput.additionalContext ?? ""]
        : [],
    )
    .filter(Boolean)
    .join("\n\n");
};

/**
 * Size of the context T3 adds: the system text every Claude thread gets, and the tool
 * descriptions and schemas (loaded on demand here, sent up front by harnesses without
 * deferred tools). Tokens are estimated at 4 characters each.
 */
const t3ContextReport = (model: Model) => {
  const size = (chars: number) => `${chars} chars (~${Math.round(chars / 4)} tokens)`;
  const descriptions = t3Tools.reduce((sum, tool) => sum + valueText(tool.description).length, 0);
  const schemas = JSON.stringify(t3Tools).length;
  return [
    `- T3 context: system text ${size((isCodex(model) ? JSON.stringify(buildCodexAdditionalContext({ model }, { browser: true, device: true })) : t3SystemAppend(model)).length)}`,
    `tool descriptions ${size(descriptions)}`,
    `full tool schemas ${size(schemas)} across ${t3Tools.length} tools.`,
  ].join(", ");
};

const stringProperty = (description: string) => ({ type: "string", description });
const NATIVE_SCHEMAS: Readonly<Record<string, Omit<ApiTool, "name">>> = {
  WebFetch: {
    description: "Fetches content from a URL and answers the prompt about it.",
    input_schema: {
      type: "object",
      properties: {
        url: stringProperty("The URL to fetch"),
        prompt: stringProperty("What to extract"),
      },
      required: ["url", "prompt"],
    },
  },
  WebSearch: {
    description: "Searches the web and returns result titles, links, and snippets.",
    input_schema: {
      type: "object",
      properties: { query: stringProperty("The search query") },
      required: ["query"],
    },
  },
};

/**
 * Moves a captured Linux request, as JSON text, to Windows: its OS lines, Codex's shell, and its
 * home paths under `C:\Users\user`. Claude Code's Bash tool stays bash, Git Bash on Windows.
 */
export const onWindows = (template: string) =>
  template
    .replaceAll("Platform: linux", "Platform: win32")
    .replace(/OS Version: Linux [^\\"]*/g, "OS Version: Windows 11 Pro 10.0.26200")
    .replaceAll("<shell>bash</shell>", "<shell>powershell</shell>")
    .replace(
      /\/home\/[^/\\"\s]+((?:\/[\w.-]+)*)/g,
      (_, rest: string) => `C:\\\\Users\\\\user${rest.replaceAll("/", "\\\\")}`,
    );

/** Both captures carry the current day in their native prompts. The simulator reads it there too. */
const onDate = (template: string, date: string) =>
  template
    .replaceAll(/Today's date is \d{4}-\d{2}-\d{2}/g, `Today's date is ${date}`)
    .replaceAll(
      /<current_date>\d{4}-\d{2}-\d{2}<\/current_date>/g,
      `<current_date>${date}</current_date>`,
    );

/** Rebuilds the parts of a captured request that every case shares. */
export const buildBase = (
  template: typeof MessagesRequest.Type,
  options: {
    readonly model: Model;
    readonly keepUserInstructions: boolean;
    readonly subagent?: boolean;
    readonly links?: boolean;
    readonly forge?: boolean;
    /** A native subagent starts from its task: T3 appends nothing to its system prompt. */
    readonly nativeSubagent?: boolean;
    /** false: the thread has no agent device access, so T3's text leaves devices out. */
    readonly deviceAccess?: boolean;
    /** false: the thread has no agent browser access, so T3's text leaves the browser out. */
    readonly browserAccess?: boolean;
    /** The Agent feedback mode: on, T3 lists its tools and its text includes the mode's line. */
    readonly agentFeedback?: Contracts.AgentFeedbackMode;
    readonly arm?: Arm;
  },
) => {
  const t3 = visibleT3Tools(options);
  const firstAssistant = template.messages.findIndex((message) => message.role === "assistant");
  const head = template.messages.slice(0, firstAssistant === -1 ? undefined : firstAssistant);
  const systemTexts = [
    template.system ?? [],
    ...head.flatMap((m) => (m.role === "system" ? [m.content] : [])),
  ]
    .flatMap(texts)
    .filter((value) => !value.startsWith("x-anthropic-billing-header:"));
  const deferredList = DEFERRED_LIST.exec(systemTexts.join("\n"))?.[2];
  if (systemTexts.filter((value) => value.includes(RUNTIME_MARKER)).length !== 1 || !deferredList) {
    throw new Error(`The template needs one ${RUNTIME_MARKER} block and a deferred tool list.`);
  }
  const nativeDeferred = deferredList.split("\n").filter((name) => name && !isT3Name(name));
  const names = [
    ...nativeDeferred,
    ...t3.filter((tool) => !alwaysLoaded.has(tool.name)).map((tool) => tool.name),
  ]
    .toSorted()
    .join("\n");
  const { model } = options;
  const append = options.nativeSubagent
    ? ""
    : forArm(
        t3SystemAppend(model, options.deviceAccess, options.browserAccess, options.agentFeedback),
        options.arm,
      );
  const modelLine = `You are powered by the model named ${MODELS[model]}. The exact model ID is ${model}.`;
  const joined = systemTexts.join("\n");
  // The capture's home directory names its user. Cases use `/home/user` paths instead.
  const cwd = /Primary working directory: (\S+)/.exec(joined)?.[1] ?? "/home/user/app";
  const home = /^\/(?:home|Users)\/[^/]+/.exec(cwd)?.[0];
  const anonymize = (value: string) =>
    home === undefined ? value : value.replaceAll(home, home.replace(/[^/]+$/, "user"));
  const system = systemTexts.map((value) => {
    // T3's append is the tail of its block: runtime info, PR linking, then orchestration.
    const at = value.indexOf(RUNTIME_MARKER);
    return anonymize(at === -1 ? value : value.slice(0, at) + append)
      .replace(DEFERRED_LIST, (_, header: string) => `${header}${names}\n`)
      .replace(MODEL_LINE, modelLine)
      .replace(IDENTITY, NEUTRAL_IDENTITY);
  });
  const [first] = template.messages;
  // The last block is the captured prompt.
  const reminders = (first?.role === "user" ? texts(first.content).slice(0, -1) : []).filter(
    (value) =>
      options.keepUserInstructions || !value.includes("Codebase and user instructions are"),
  );
  // gitStatus names a real repo state. Each case gets one built from its fake world instead.
  const gitStatusAt = reminders.findIndex((value) => value.includes("# gitStatus"));
  // Claude Code sends no schema for tools it only names. Web tools get their usual one, the
  // rest load open.
  const open = { type: "object", additionalProperties: true };
  const nativeSchema = (name: string) =>
    NATIVE_SCHEMAS[name] ?? { description: name, input_schema: open };
  return {
    model,
    system: system.map(text),
    reminders: reminders.filter((_, i) => i !== gitStatusAt).map((value) => text(anonymize(value))),
    gitStatusAt: gitStatusAt === -1 ? reminders.length : gitStatusAt,
    /** The shell simulator's cwd and OS follow the template's environment section. */
    environment: {
      cwd: anonymize(cwd),
      platform: /Platform: (\w+)/.exec(joined)?.[1] ?? "linux",
      date: /Today's date is ([\d-]+)/.exec(reminders.join("\n"))?.[1],
    },
    nativeTools: [
      ...template.tools.filter((tool) => !isT3Name(tool.name)),
      ...t3.filter((tool) => alwaysLoaded.has(tool.name)),
    ],
    /** Tools ToolSearch loads: T3 tools from source, and native tools the template only names. */
    t3,
    deferred: [...t3, ...nativeDeferred.map((name) => ({ name, ...nativeSchema(name) }))],
  };
};

type Base = ReturnType<typeof buildBase> & {
  readonly codex?: typeof ResponsesRequest.Type;
  /** What T3's SubagentStart hooks give a native subagent. */
  readonly subagentContext?: string;
};

/** Keep the captured harness prompt and tools; replace app-owned context and the real user. */
const buildCodexBase = (
  template: typeof ResponsesRequest.Type,
  options: {
    readonly model: Model;
    readonly keepUserInstructions: boolean;
    readonly effort?: string | undefined;
    readonly subagent?: boolean;
    readonly links?: boolean;
    readonly forge?: boolean;
    /** false: the thread has no agent device access, so T3's text leaves devices out. */
    readonly deviceAccess?: boolean;
    /** false: the thread has no agent browser access, so T3's text leaves the browser out. */
    readonly browserAccess?: boolean;
    /** The Agent feedback mode: on, T3 lists its tools and its text includes the mode's line. */
    readonly agentFeedback?: Contracts.AgentFeedbackMode;
    readonly arm?: Arm;
  },
): Base => {
  const t3 = visibleT3Tools(options);
  const contentText = (item: Block) =>
    Array.isArray(item.content)
      ? item.content.map((block: Block) => valueText(block.text)).join("\n")
      : valueText(item.content);
  const joined = template.input.map(contentText).join("\n");
  if (!joined.includes("<t3_code_runtime>"))
    throw new Error("Codex template needs full T3 context.");
  const cwd = /<cwd>(.*?)<\/cwd>/.exec(joined)?.[1] ?? "/home/user/app";
  const home = /^\/(?:home|Users)\/[^/]+/.exec(cwd)?.[0];
  const clean = (s: string) => (home ? s.replaceAll(home, home.replace(/[^/]+$/, "user")) : s);
  const effort = options.effort ?? template.reasoning.effort;
  const message = (value: string, role = "developer") => ({
    type: "message",
    role,
    content: [{ type: "input_text", text: value }],
  });
  // The captured <collaboration_mode> message stays: Codex supplies its own mode text natively.
  const input = template.input.flatMap((item) => {
    const content = contentText(item);
    if (content.includes("<t3_code_")) return [];
    if (item.role === "user") {
      const env = /<environment_context>[\s\S]*?<\/environment_context>/.exec(content)?.[0];
      return env ? [message(clean(options.keepUserInstructions ? content : env), "user")] : [];
    }
    // Only harness messages and tools. A captured turn's answers and tool calls would leak into
    // every case.
    if (item.type !== "message" && item.type !== "additional_tools") return [];
    if (item.role === "assistant") return [];
    return [JSON.parse(clean(JSON.stringify(item))) as Block];
  });
  const context = buildCodexAdditionalContext(
    {
      model: options.model,
      reasoningEffort: effort,
      agentFeedback: options.agentFeedback ?? "off",
    },
    { browser: options.browserAccess ?? true, device: options.deviceAccess ?? true },
  );
  input.push(
    ...Object.entries(context).map(([key, entry]) =>
      message(`<${key}>${forArm(entry.value, options.arm)}</${key}>`),
    ),
  );
  const nativeTools = input
    .flatMap((item) =>
      item.type === "additional_tools" && Array.isArray(item.tools)
        ? item.tools.flatMap((ns: unknown) =>
            isRecord(ns) && Array.isArray(ns.tools) ? ns.tools : [],
          )
        : [],
    )
    .filter((tool): tool is ApiTool => isRecord(tool) && typeof tool.name === "string");
  if (!nativeTools.some((tool) => tool.name === "exec"))
    throw new Error("Codex template needs code-mode exec.");
  return {
    model: options.model,
    system: [],
    reminders: [],
    gitStatusAt: 0,
    environment: {
      cwd: clean(cwd),
      platform: /^[A-Z]:\\/i.test(cwd) ? "win32" : cwd.startsWith("/Users/") ? "darwin" : "linux",
      date: /<current_date>(.*?)<\/current_date>/.exec(joined)?.[1],
    },
    nativeTools,
    t3,
    deferred: [...t3],
    codex: { ...template, input, reasoning: { ...template.reasoning, effort } },
  };
};

/** Replay prior calls in Codex's wire format, including Claude-shaped file operations. */
const codexCall = (name: string, input: unknown) => {
  const args = isRecord(input) ? input : {};
  if (name === "Bash")
    return `text(await tools.exec_command(${JSON.stringify({ ...args, cmd: args.command })}));`;
  if (["Read", "Write", "Edit"].includes(name)) {
    const file = valueText(args.file_path);
    const command =
      name === "Read"
        ? `cat ${JSON.stringify(file)}`
        : name === "Write"
          ? `cat > ${JSON.stringify(file)} <<'EVAL_EOF'\n${valueText(args.content)}\nEVAL_EOF`
          : `python3 -c ${JSON.stringify(`from pathlib import Path; p=Path(${JSON.stringify(file)}); p.write_text(p.read_text().replace(${JSON.stringify(args.old_string)}, ${JSON.stringify(args.new_string)}))`)}`;
    return `text(await tools.exec_command(${JSON.stringify({ cmd: command })}));`;
  }
  return `text(await tools.${name.replace("mcp__t3-code__", "mcp__t3_code__")}(${JSON.stringify(input)}));`;
};
export const codexMessages = (messages: ReadonlyArray<ApiMessage>): Array<Block> =>
  messages.flatMap((message) =>
    message.content.map((block): Block =>
      block.type === "tool_use"
        ? {
            type: "custom_tool_call",
            call_id: block.id,
            name: "exec",
            input: codexCall(valueText(block.name), block.input),
          }
        : block.type === "tool_result"
          ? {
              type: "custom_tool_call_output",
              call_id: block.tool_use_id,
              output: valueText(block.content),
            }
          : {
              type: "message",
              role: block.developer === true ? "developer" : message.role,
              content: [
                {
                  type: message.role === "user" ? "input_text" : "output_text",
                  text: valueText(block.text),
                },
              ],
            },
    ),
  );
/** One tool call the shell simulator has answered, or one from the case's prior turns. */
type ShellEntry = { readonly tool: string; readonly input: unknown; readonly output: string };
/** PRs T3 links by itself because a shell command created them, as `gh pr create` does. */
const createdPullRequests = ({ tool, input, output }: ShellEntry) =>
  tool === "Bash" && isRecord(input) && typeof input.command === "string"
    ? changeRequestsCreatedBy(input.command, output).map(({ url }) => url)
    : [];

/** The PR number a shell command opened for `branch`; `--head` naming another branch is not it. */
const branchPullRequestCreatedBy = (entry: ShellEntry, branch: string | undefined) => {
  const command = isRecord(entry.input) ? valueText(entry.input.command) : "";
  const head = /--head[=\s]+["']?([^\s"']+)/.exec(command)?.[1];
  if (head !== undefined && branch !== undefined && head.split(":").at(-1) !== branch) {
    return undefined;
  }
  return createdPullRequests(entry)
    .map((url) => Number(/\/pull\/(\d+)/.exec(url)?.[1]))
    .find((number) => number > 0);
};
/** The branch the agent last checked out or switched to in the shell, else the world's. */
const checkedOutBranch = (sample: Sample) => {
  let branch = sample.testCase.setup.world?.branch ?? "";
  for (const entry of sample.shell) {
    for (const part of shellParts(entry)) branch = switchedTo(part) ?? branch;
  }
  return branch;
};
/** A shell entry's commands, split at separators, with fd redirects dropped. */
const shellParts = (entry: ShellEntry) =>
  (isRecord(entry.input) ? valueText(entry.input.command) : "")
    .replace(/\s\d?>&\d/g, "")
    .split(/[;&|\n]+/);
/** The branch one command checks out or switches to, if it does. */
const switchedTo = (part: string) => {
  // `git checkout <ref> -- <paths>` restores files and stays on the branch.
  if (/\s--(\s|$)/.test(part)) return undefined;
  return /\bgit (?:checkout|switch)\s+(?:-[bcBC]\s+)?([A-Za-z0-9][\w./-]*)\s*$/.exec(
    part.trim(),
  )?.[1];
};

/**
 * One sample's state. ToolSearch adds loaded schemas to `tools`, like Claude Code. `shell` is the
 * history the simulator keeps consistent with; `linked`, `nextTask` and `threads` do the same for
 * T3 results.
 */
type Sample = {
  readonly testCase: McpToolUseCase;
  readonly base: Base;
  readonly tools: Array<ApiTool>;
  readonly repo: string;
  readonly shell: Array<ShellEntry>;
  readonly shellUsage: Usage;
  readonly linked: Set<string>;
  /** The branch PR the agent opened in this sample, which links alone do not prove. */
  openedPullRequest: number | undefined;
  /** PRs pull_request_create opened from branches other than the world's, by branch. */
  readonly openedByBranch: Map<string, number>;
  /** PR changes the agent made through T3's tools, which gh and the host show from then on. */
  readonly forgeChanges: Array<string>;
  /** PRs pull_request_merge merged, as `repo#number`, which reads show as merged from then on. */
  readonly merged: Set<string>;
  readonly codeStore: Record<string, unknown>;
  readonly scheduledTasks: Map<string, OrchestratorMcpScheduleTaskResult>;
  nextTask: number;
  /** Threads t3_thread_launch started, so a replay or a read of one answers as T3 would. */
  readonly launches: Array<{
    readonly input: Readonly<Record<string, unknown>>;
    readonly result: Record<string, unknown>;
  }>;
  /** Threads the agent launched in this sample, by id, so reading one shows its own brief. */
  readonly threads: Map<string, { readonly title: string; readonly brief: string }>;
  /** Files T3's request_secret saved in this sample, in call order. */
  readonly secretFiles: Array<string>;
  /** Files request_secret saved for `secret: false` fields, with their labels. */
  readonly plainFiles: Array<{ readonly file: string; readonly label: string }>;
  secretRequests: number;
  /** T3's device tools, once `withDevices` builds them for a world with devices. */
  devices?: DeviceTools;
  /** T3's results for prior device calls whose case result is "default". */
  readonly priorResults: Map<unknown, string>;
  /** Calls so far per mocked tool, for mocks that answer in sequence. */
  readonly mockCalls: Map<string, number>;
};

const SHELL_TOOLS = new Set(["Bash", "Read", "Edit", "Write", "WebFetch"]);

export const makeSample = (testCase: McpToolUseCase, base: Base): Sample => {
  const prior = testCase.setup.priorTurns ?? [];
  const priorCalls = prior.flatMap((turn) => turn.toolCalls ?? []);
  const repo = testCase.setup.world?.repo ?? "acme/app";
  const urls = [
    ...(testCase.setup.world?.linkedPullRequests ?? []).map(
      ({ number }) => pullRequest(repo, { number }).url,
    ),
    ...priorCalls.flatMap((call) =>
      ["link_pull_request", "watch_pull_request"].includes(call.tool) && isRecord(call.input)
        ? [pullRequest(repo, call.input).url]
        : call.tool === "link_pull_requests" &&
            isRecord(call.input) &&
            Array.isArray(call.input.urls)
          ? call.input.urls
              .filter((url) => PULL_REQUEST_URL.test(valueText(url)))
              .map((url) => pullRequest(repo, { url }).url)
          : [],
    ),
  ];
  const taskNumbers = [...valueText(prior).matchAll(/task-(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  const shell = priorCalls
    .filter((call) => SHELL_TOOLS.has(call.tool))
    .map(({ tool, input, result }) => ({ tool, input, output: valueText(result) }));
  return {
    testCase,
    base,
    tools: [...base.nativeTools],
    repo: testCase.setup.world?.repo ?? "acme/app",
    shell,
    shellUsage: emptyUsage(),
    linked: new Set([...urls, ...shell.flatMap(createdPullRequests)]),
    openedByBranch: new Map(),
    forgeChanges: [],
    merged: new Set(),
    openedPullRequest:
      shell
        .map((entry) => branchPullRequestCreatedBy(entry, testCase.setup.world?.branch))
        .find((number) => number !== undefined) ??
      priorCalls
        .filter((call) => call.tool === "pull_request_create")
        .map((call) => Number(/\/pull\/(\d+)/.exec(valueText(call.result))?.[1]))
        .find((number) => number > 0),
    codeStore: {},
    scheduledTasks: new Map(),
    nextTask: Math.max(0, ...taskNumbers) + 1,
    launches: [],
    threads: new Map(),
    secretFiles: [],
    plainFiles: [],
    secretRequests: 0,
    priorResults: new Map(),
    mockCalls: new Map(),
  };
};

/** A `{"$sequence": [...]}` mock answers its nth call with the nth result, then repeats the last. */
const nextMock = (sample: Sample, name: string, mock: unknown) => {
  if (!isRecord(mock) || !Array.isArray(mock.$sequence) || mock.$sequence.length === 0) return mock;
  const n = sample.mockCalls.get(name) ?? 0;
  sample.mockCalls.set(name, n + 1);
  return mock.$sequence[Math.min(n, mock.$sequence.length - 1)];
};

/**
 * Builds T3's device tools for a world with devices. Prior device calls whose result is "default"
 * run first, in order and without the case's mocks, so their results and sessions are T3's. As in
 * the real flow, device_open starts no agent-device session: one starts at a launcher `open` in the
 * sample's shell history, prior turns included, or where `world.agentDeviceSessions` declares it.
 */
export const withDevices = Effect.fn("evaluateMcpToolUse.withDevices")(function* (sample: Sample) {
  const world = sample.testCase.setup.world;
  if (world?.devices === undefined) return;
  sample.devices = yield* makeDeviceTools(
    { ...world, devices: world.devices },
    sample.base.environment,
  );
  for (const call of (sample.testCase.setup.priorTurns ?? []).flatMap((t) => t.toolCalls ?? [])) {
    if (call.result !== "default" || !isDeviceTool(call.tool)) continue;
    sample.priorResults.set(call, (yield* sample.devices.call(call.tool, call.input)).text);
  }
});

// Main's history under every case's world.
const MAIN_COMMITS = [
  { sha: "9f2c1ab", subject: "feat(web): show the model name in the thread header" },
  { sha: "4e7d2c0", subject: "fix(server): retry provider start once on ENOENT" },
  { sha: "b81f3d9", subject: "chore: update dependencies" },
];

/**
 * The gitStatus Claude Code shows when a session starts, built from the case's world. Commits and
 * a branch that the prior turns made (their tool results show it) came later, so they are left out.
 */
const gitStatus = ({ setup }: McpToolUseCase) => {
  const prior = valueText(setup.priorTurns ?? []);
  const branch = setup.world?.branch ?? "main";
  const commits = [...(setup.world?.commits ?? []), ...MAIN_COMMITS].filter(
    (commit) => !prior.includes(` ${commit.sha}] `),
  );
  return [
    "As you answer the user's questions, you can use the following context:",
    "# gitStatus",
    "This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.",
    "",
    `Current branch: ${prior.includes(`Switched to a new branch '${branch}'`) ? "main" : branch}`,
    "",
    "Main branch (you will usually use this for PRs): main",
    "",
    "Status:",
    setup.world?.status || "(clean)",
    "",
    "Recent commits:",
    ...commits.slice(0, 5).map((commit) => `${commit.sha} ${commit.subject}`),
    "",
    "Claude Code attached this context automatically; it isn't part of the user's message. It describes the user's own account and workspace, so they don't need it reported back.",
  ].join("\n");
};

const findTool = (base: Base, bare: string) =>
  [...base.nativeTools, ...base.deferred].find((tool) => normalizeToolName(tool.name) === bare) ??
  (base.codex ? { name: bare } : undefined);

/** Adds deferred schemas to `tools` and returns the ToolSearch result Claude Code sends. */
const loadTools = (tools: Array<ApiTool>, id: string, found: ReadonlyArray<ApiTool>): Block => {
  for (const tool of found) {
    if (!hasTool(tools, tool.name)) tools.push({ ...tool, defer_loading: true });
  }
  const content = found.map((tool) => ({ type: "tool_reference", tool_name: tool.name }));
  return { type: "tool_result", tool_use_id: id, content };
};

/** Messages for a case: reminders, context, prior turns with real tool blocks, then the prompt. */
export const buildMessages = (sample: Sample) => {
  const { testCase, base, tools } = sample;
  const messages: Array<ApiMessage> = [];
  const push = (role: ApiMessage["role"], ...blocks: ReadonlyArray<Block>) => {
    const last = messages.at(-1);
    if (last?.role !== role) messages.push({ role, content: blocks });
    else messages[messages.length - 1] = { role, content: [...last.content, ...blocks] };
  };
  const { role, context, delegateRole, priorTurns = [] } = testCase.setup;
  const sideChat = testCase.setup.sideChat;
  if (testCase.prompt === "" && (role !== "top" || sideChat !== undefined)) {
    throw new Error(
      `${testCase.id}: Empty-prompt replay requires a top-level thread without side-chat context.`,
    );
  }
  const sideChatContext =
    sideChat === undefined
      ? undefined
      : makeSideChatContext({
          parentThreadId: ThreadId.make(sideChat.parentThreadId),
          digest: sideChat.digest,
        });
  const native = role === "native-subagent";
  const notes = [
    native
      ? "You are a subagent started by the parent agent's Agent tool. Your final message goes to the parent agent, not to the user."
      : undefined,
    context,
  ];
  const reminders = base.reminders.toSpliced(base.gitStatusAt, 0, reminder(gitStatus(testCase)));
  push("user", ...reminders, ...notes.flatMap((note) => (note ? [reminder(note)] : [])));
  const toolSearch = findTool(base, "ToolSearch")?.name ?? "ToolSearch";
  let nextId = 0;
  for (const turn of priorTurns) {
    const calls = (turn.toolCalls ?? []).map((call) => {
      const tool = findTool(base, call.tool);
      if (tool === undefined) throw new Error(`${testCase.id}: unknown prior tool ${call.tool}.`);
      if (call.result === "default" && isDeviceTool(call.tool) && !sample.priorResults.has(call)) {
        throw new Error(`${testCase.id}: prior ${call.tool} needs T3's result; run withDevices.`);
      }
      return { ...call, id: `toolu_prior_${nextId++}`, name: tool.name, tool, prior: call };
    });
    // Prior T3 calls load their schemas first, as in a real deferred session.
    const unloaded = [...new Set(calls.map((call) => call.tool))].filter(
      (tool) => !hasTool(tools, tool.name),
    );
    if (unloaded.length > 0 && !base.codex) {
      const id = `toolu_prior_${nextId++}`;
      const query = `select:${unloaded.map((tool) => tool.name).join(",")}`;
      const input = { query, max_results: unloaded.length };
      push("assistant", { type: "tool_use", id, name: toolSearch, input });
      push("user", loadTools(tools, id, unloaded), text(TOOL_LOADED));
    }
    // One call per step, as most real turns run them.
    for (const { id, name, input, result, tool, prior } of calls) {
      push("assistant", { type: "tool_use", id, name, input });
      const replayed =
        normalizeToolName(tool.name) === "orchestrator_capabilities"
          ? capabilities(sample, result)
          : (sample.priorResults.get(prior) ?? result);
      const answer = toolResult(id, replayed);
      push("user", answer);
    }
    if (turn.text) push(turn.role, text(turn.text));
  }
  const expandedPrompt = formatSharedSkillPrompt(testCase.prompt, testCase.promptSkills ?? []);
  const userText =
    testCase.promptContext === undefined
      ? expandedPrompt
      : projectComposerContextForProvider({ text: expandedPrompt, ...testCase.promptContext });
  const driver = base.codex ? "codex" : "claudeAgent";
  const autoSettings = { autoModeModels: testCase.setup.autoModeModels ?? {} };
  const otherProviders = (testCase.setup.otherAutoProviders ?? []).map((provider) => ({
    ...provider,
    models: provider.models.map(({ effort, ...model }) => ({
      ...model,
      capabilities: {
        optionDescriptors:
          effort === undefined
            ? []
            : [
                {
                  id: effort.id,
                  label: "Effort",
                  type: "select" as const,
                  options: effort.values.map((id) => ({ id, label: id })),
                },
              ],
      },
    })),
  }));
  const otherDriver = ProviderDriverKind.make(driver === "codex" ? "claudeAgent" : "codex");
  const otherPrimary = autoModeModelFor(autoSettings, otherDriver);
  const primary = autoModeModelFor(autoSettings, ProviderDriverKind.make(driver));
  const ownModels = (
    PROVIDERS.find((provider) => provider.providerInstanceId === driver)?.models ?? []
  ).map((model) => ({
    slug: model.id,
    name: model.id,
    aliases: driver === "claudeAgent" ? [model.id.split("-")[1]!] : [],
    capabilities: {
      optionDescriptors: model.options.map((option) => ({
        id: option.id,
        label: "Effort",
        type: "select" as const,
        options: option.values.map((id) => ({ id, label: id })),
      })),
    },
  }));
  // Like the server, a reviewer runs the id its account lists for the saved model, found by id,
  // name or alias, with only the saved options that model still offers.
  const reviewerOn = (
    providerInstanceId: string,
    providerDriver: ProviderDriverKind,
    models: ReadonlyArray<
      SelectableModelOption & {
        readonly capabilities: {
          readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
        };
      }
    >,
    auto: typeof primary,
  ) => {
    const slug = auto === null ? null : resolveSelectableModel(providerDriver, auto.model, models);
    const model = models.find((candidate) => candidate.slug === slug);
    return model === undefined || auto === null
      ? undefined
      : {
          model: model.slug,
          providerInstanceId,
          options: offeredOptionSelections(model.capabilities.optionDescriptors, auto.options),
        };
  };
  const otherReviewer = otherProviders
    .map((provider) =>
      reviewerOn(provider.providerInstanceId, otherDriver, provider.models, otherPrimary),
    )
    .find((candidate) => candidate !== undefined);
  const ownReviewer = reviewerOn(driver, ProviderDriverKind.make(driver), ownModels, primary);
  const autoBrief = testCase.setup.autoMode
    ? autoCoordinatorInstructions({
        driver: ProviderDriverKind.make(driver),
        model: base.model,
        primary,
        otherProviders,
        ...(otherReviewer === undefined ? {} : { otherReviewer }),
        ...(ownReviewer === undefined ? {} : { ownReviewer }),
        models: ownModels,
      })
    : null;
  // The Claude adapter prepends the tagged brief to the turn text; the Codex adapter sends it as a developer message.
  const claudeBrief =
    autoBrief !== null && !base.codex ? `${autoModePromptBlock(autoBrief)}\n\n` : "";
  const prompt = `${claudeBrief}${withInlineContext(sideChatContext ?? "", userText)}`;
  if (autoBrief !== null && base.codex)
    push("user", developerText(autoModeDeveloperMessage(autoBrief)));
  const childPrompt = () => taskPrompt({ task: prompt, role: delegateRole });
  if (testCase.prompt !== "")
    push("user", text(role === "delegated-child" ? childPrompt() : prompt));
  // Claude Code gives a subagent its SubagentStart hooks' context as a reminder after the task.
  if (native && base.subagentContext) {
    push("user", reminder(`SubagentStart hook additional context: ${base.subagentContext}`));
  }
  return messages;
};

// Results for T3 tools a case does not mock. The model ids are public in this repo's catalog.
const claudeModel = (id: string) => ({ id, options: [{ id: "effort", values: EFFORTS }] });
const codexModel = (id: string) => ({ id, options: [{ id: "reasoningEffort", values: EFFORTS }] });
// Mirrors the real catalog's main models, so a case's named model is not missing by accident.
const PROVIDERS = [
  {
    providerInstanceId: "claudeAgent",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-haiku-5-5"].map(
      claudeModel,
    ),
  },
  {
    providerInstanceId: "codex",
    models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"].map(codexModel),
  },
  { providerInstanceId: "muse", models: ["muse-wonder-full", "muse-wonder"].map(codexModel) },
  { providerInstanceId: "grok", models: ["grok-4.7"].map(codexModel) },
];
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DEFAULT_THREAD = {
  title: "Fix the flaky reconnect test",
  status: "idle",
  items: [
    {
      position: 1,
      createdBy: "user",
      text: "The reconnect test in src/session.test.ts fails about 1 in 10 runs. Fix it.",
    },
    {
      position: 2,
      createdBy: "assistant",
      text: "Fixed. The test now waits for the socket close event before it reconnects. 20 runs in a row pass.",
    },
  ],
};
const HTML_RENDERED =
  "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.";

const PULL_REQUEST_URL = /\/pull\/\d+\/?$/;

/** Pull request identity from a `url` or `repository` plus `number` input, like T3's results. */
const pullRequest = (repo: string, input: Readonly<Record<string, unknown>>) => {
  const url = typeof input.url === "string" ? input.url : "";
  const repository =
    /github\.com\/([^/]+\/[^/]+)\/pull/.exec(url)?.[1] ?? valueText(input.repository ?? repo);
  const number = Number(/(\d+)\/?$/.exec(url)?.[1] ?? input.number);
  return {
    host: "github.com",
    repository,
    number,
    url: url || `https://github.com/${repository}/pull/${number}`,
  };
};

/** A linked PR as `list_thread_pull_requests` shows it. Links made in the sample are open. */
const linkedEntry = (sample: Sample, url: string) => {
  const pr = pullRequest(sample.repo, { url });
  const seeded = sample.testCase.setup.world?.linkedPullRequests?.find(
    ({ number }) => number === pr.number && pr.repository === sample.repo,
  );
  const state = mergedIn(sample, pr.repository, pr.number) ? "merged" : (seeded?.state ?? "open");
  return { ...pr, state, title: seeded?.title ?? null };
};

const mergedIn = (sample: Sample, repository: string, number: unknown) =>
  sample.merged.has(`${repository.toLowerCase()}#${Number(number)}`);

/** The world's PRs. `prs` is free-form world data: number, title, headRefName, checks. */
const worldPullRequests = (sample: Sample) => {
  const prs = sample.testCase.setup.world?.prs;
  return Array.isArray(prs) ? prs.filter(isRecord) : [];
};

/** A world PR's `reviewThreads`: id, path, line, isResolved, comments of author and body. */
const worldReviewThreads = (pr: Readonly<Record<string, unknown>> | undefined) =>
  Array.isArray(pr?.reviewThreads) ? pr.reviewThreads.filter(isRecord) : [];

/** World fixtures spell states as GitHub does (`MERGED`) or as T3 does (`merged`). */
const worldState = (pr: Readonly<Record<string, unknown>> | undefined) => {
  const state = valueText(pr?.state ?? "open").toLowerCase();
  return state === "merged" || state === "closed" ? state : "open";
};

/**
 * The PR for the sample's branch: the world's, else the one a create would open. A case that
 * mocks `gh pr create` names that URL, so the T3 tool opens the same number.
 */
const worldBranchPullRequest = (sample: Sample) => {
  const branch = sample.testCase.setup.world?.branch;
  const prs = worldPullRequests(sample);
  const own = prs.find((pr) => pr.headRefName === branch);
  if (own !== undefined) return { number: Number(own.number), created: false, pr: own };
  if (sample.openedPullRequest !== undefined) {
    return { number: sample.openedPullRequest, created: false, pr: undefined };
  }
  const mocked = (sample.testCase.setup.shellMocks ?? []).find((mock) =>
    /\b(pr|mr) create\b/.test(mock.match),
  );
  const fromMock = Number(/\/pull\/(\d+)/.exec(mocked?.output ?? "")?.[1]);
  const number =
    fromMock > 0 ? fromMock : Math.max(123, ...prs.map((pr) => Number(pr.number) || 0)) + 1;
  return { number, created: true, pr: undefined };
};

/** The PR for the checked-out branch: a stack layer's own, or the world branch's. */
const branchPullRequest = (sample: Sample) => {
  const checkedOut = checkedOutBranch(sample);
  if (checkedOut === sample.testCase.setup.world?.branch) return worldBranchPullRequest(sample);
  const known = worldPullRequests(sample).find((pr) => pr.headRefName === checkedOut);
  if (known !== undefined) return { number: Number(known.number), created: false, pr: known };
  const opened = sample.openedByBranch.get(checkedOut);
  if (opened !== undefined) return { number: opened, created: false, pr: undefined };
  const number =
    Math.max(
      worldBranchPullRequest(sample).number,
      ...sample.openedByBranch.values(),
      ...worldPullRequests(sample).map((pr) => Number(pr.number) || 0),
      ...[...sample.linked].map((url) => Number(/\/pull\/(\d+)/.exec(url)?.[1]) || 0),
    ) + 1;
  return { number, created: true, pr: undefined };
};

/** PullRequestService reads this many logs when no check is named. */
const DEFAULT_CHECK_LOGS = 5;

/** The checks `ci_logs` and `ci_rerun` act on, selected as PullRequestService does. */
const selectedWorldChecks = (sample: Sample, input: Readonly<Record<string, unknown>>) => {
  const number = typeof input.number === "number" ? input.number : branchPullRequest(sample).number;
  const world = worldPullRequests(sample).find((pr) => Number(pr.number) === number);
  const all = Array.isArray(world?.checks) ? world.checks.filter(isRecord) : [];
  const named = typeof input.check === "string" ? input.check.trim().toLowerCase() : null;
  const checks = all.filter((check) =>
    named === null
      ? check.state === "fail" || check.state === "cancelled"
      : valueText(check.name).toLowerCase() === named,
  );
  return { number, all, checks, named };
};

const EVAL_PROJECT_ID = "22222222-2222-4222-8222-222222222222";

/** A believable T3 result for a tool the case does not mock. */
export const t3Default = (
  sample: Sample,
  name: string,
  input: Readonly<Record<string, unknown>>,
) => {
  const pr = () => pullRequest(sample.repo, input);
  const newThread = (request: unknown, brief: unknown) => {
    const n = sample.nextTask++;
    const title =
      isRecord(request) && typeof request.title === "string" ? request.title : "New thread";
    const text = typeof brief === "string" ? brief.trim() : "";
    sample.threads.set(uuid(n), { title, brief: text });
    return {
      threadId: uuid(n),
      title,
      ...(text ? { runId: `run-${n}`, status: "starting" } : { status: "idle" }),
    };
  };
  switch (name) {
    case "create_threads":
      return {
        threads: (Array.isArray(input.threads) ? input.threads : []).map((request) => {
          const target = isRecord(request) && isRecord(request.target) ? request.target : {};
          return {
            ...newThread(request, isRecord(request) ? request.prompt : undefined),
            createdBy: "agent",
            creationSource: "mcp",
            providerInstanceId:
              target.providerInstanceId ?? (sample.base.codex ? "codex" : "claudeAgent"),
            model: target.model ?? sample.base.model,
          };
        }),
      };
    case "orchestrator_capabilities":
      return {
        inheritedProviderInstanceId: "claudeAgent",
        inheritedModel: sample.base.model,
        providers: PROVIDERS,
      };
    case "delegate_task": {
      const n = sample.nextTask++;
      const target = isRecord(input.target) ? input.target : {};
      return {
        taskId: `task-${n}`,
        childThreadId: uuid(n),
        childRunId: `run-${n}`,
        status: "running",
        workState: "working",
        hasPendingChildRuns: false,
        providerInstanceId:
          target.providerInstanceId ?? (sample.base.codex ? "codex" : "claudeAgent"),
        model: target.model ?? sample.base.model,
        summary: null,
        hasPendingQuestion: false,
        pendingApproval: null,
      };
    }
    case "t3_thread_launch": {
      const replayed = sample.launches.find(
        (launch) =>
          input.clientRequestId !== undefined &&
          launch.input.clientRequestId === input.clientRequestId,
      );
      if (replayed) return replayed.result;
      const n = sample.nextTask++;
      const started = input.message !== undefined || input.attachments !== undefined;
      const result = {
        threadId: uuid(n),
        projectId: input.projectId ?? EVAL_PROJECT_ID,
        modelSelection: input.modelSelection ?? {
          instanceId: sample.base.codex ? "codex" : "claudeAgent",
          model: sample.base.model,
        },
        runId: started ? `run-${n}` : null,
        status: started ? "starting" : "idle",
      };
      sample.launches.push({ input, result });
      sample.threads.set(result.threadId, {
        title: String(input.title ?? "New thread"),
        brief: typeof input.message === "string" ? input.message : "",
      });
      return result;
    }
    case "task_status":
      return {
        taskId: input.taskId,
        status: "running",
        workState: "working",
        hasPendingChildRuns: false,
        summary: null,
      };
    case "task_cancel":
      return { taskId: input.taskId, status: "cancel_requested" };
    case "link_pull_request": {
      const alreadyLinked = sample.linked.has(pr().url);
      sample.linked.add(pr().url);
      return { ...pr(), alreadyLinked };
    }
    case "link_pull_requests": {
      const urls = Array.isArray(input.urls) ? input.urls.map(valueText) : [];
      const invalidUrls = urls.filter((url) => !PULL_REQUEST_URL.test(url));
      const targets = [...new Set(urls.filter((url) => PULL_REQUEST_URL.test(url)))].map((url) =>
        pullRequest(sample.repo, { url }),
      );
      const fresh = targets.filter(({ url }) => !sample.linked.has(url));
      for (const { url } of targets) sample.linked.add(url);
      const byRepository = (prs: ReadonlyArray<ReturnType<typeof pullRequest>>) =>
        [...Map.groupBy(prs, (pr) => pr.repository).values()].map((group) => ({
          host: "github.com",
          repository: group[0]!.repository,
          numbers: group.map((pr) => pr.number),
        }));
      return {
        linked: byRepository(fresh),
        alreadyLinked: byRepository(targets.filter((pr) => !fresh.includes(pr))),
        linkedCount: targets.length,
        ...(invalidUrls.length > 0 ? { invalidUrls } : {}),
      };
    }
    case "pull_request_create": {
      const checkedOut = checkedOutBranch(sample);
      const { number, created } = branchPullRequest(sample);
      const target = pullRequest(sample.repo, { number });
      sample.linked.add(target.url);
      // Another layer of a stack gets its own PR, opened once per branch like the real tool.
      if (checkedOut !== sample.testCase.setup.world?.branch) {
        sample.openedByBranch.set(checkedOut, number);
      } else if (created) sample.openedPullRequest = number;
      return { ...target, created };
    }
    case "pull_request_read": {
      const own = branchPullRequest(sample);
      const number = typeof input.number === "number" ? input.number : own.number;
      const world = worldPullRequests(sample).find((pr) => Number(pr.number) === number);
      const include = Array.isArray(input.include) ? input.include : [];
      const checks = Array.isArray(world?.checks) ? world.checks.filter(isRecord) : [];
      const checkRuns = checks.map((check) => ({
        name: valueText(check.name),
        status:
          check.state === "fail"
            ? "failure"
            : check.state === "cancelled" ||
                check.state === "pending" ||
                check.state === "action-required"
              ? check.state
              : "success",
        description: null,
        url: null,
      }));
      const comments = (Array.isArray(world?.comments) ? world.comments : []).filter(isRecord);
      return {
        ...pullRequest(sample.repo, { number }),
        title: valueText(world?.title ?? sample.testCase.setup.world?.commits?.[0]?.subject),
        state: mergedIn(sample, sample.repo, number) ? "merged" : worldState(world),
        isDraft: false,
        author: "user",
        headBranch: valueText(world?.headRefName ?? sample.testCase.setup.world?.branch),
        baseBranch: valueText(world?.baseRefName ?? "main"),
        // Only the branch's own PR is at the checkout's latest commit.
        headSha:
          typeof world?.headRefOid === "string"
            ? world.headRefOid
            : number === own.number
              ? (sample.testCase.setup.world?.commits?.[0]?.sha ?? null)
              : null,
        mergeability: valueText(world?.mergeability ?? "mergeable"),
        behindBy: typeof world?.behindBy === "number" ? world.behindBy : 0,
        autoMergeEnabled: false,
        checks: {
          passed: checkRuns.filter((check) => check.status === "success").length,
          pending: checkRuns.filter(
            (check) => check.status === "pending" || check.status === "action-required",
          ).length,
          failed: checkRuns
            .filter((check) => check.status === "failure" || check.status === "cancelled")
            .map((check) => check.name),
        },
        unresolvedThreads: worldReviewThreads(world).filter((thread) => thread.isResolved !== true)
          .length,
        ...(include.includes("body") ? { body: valueText(world?.body ?? "") } : {}),
        ...(include.includes("checks") ? { checkRuns } : {}),
        ...(include.includes("diff")
          ? { diff: { patch: valueText(world?.diff ?? ""), truncated: false, nextCursor: null } }
          : {}),
        ...(include.includes("threads") || include.includes("comments")
          ? {
              conversation: {
                ...(include.includes("threads")
                  ? {
                      reviewThreads: worldReviewThreads(world)
                        .filter(
                          (thread) => input.includeResolved === true || thread.isResolved !== true,
                        )
                        .map((thread) => ({
                          id: valueText(thread.id),
                          path: valueText(thread.path),
                          line: typeof thread.line === "number" ? thread.line : null,
                          isResolved: thread.isResolved === true,
                          isOutdated: false,
                          comments: (Array.isArray(thread.comments) ? thread.comments : [])
                            .filter(isRecord)
                            .map((comment) => ({
                              author: valueText(comment.author),
                              body: valueText(comment.body),
                              createdAt: "2026-10-27T10:00:00Z",
                            })),
                          moreComments: false,
                        })),
                    }
                  : {}),
                ...(include.includes("comments")
                  ? {
                      comments: comments.map((comment, index) => ({
                        id: `comment-${index + 1}`,
                        kind: "issue-comment",
                        author: valueText(comment.author),
                        body: valueText(comment.body),
                        createdAt: "2026-10-27T10:00:00Z",
                        path: null,
                        reviewState: null,
                      })),
                    }
                  : {}),
                truncated: false,
                nextCursor: null,
              },
            }
          : {}),
      };
    }
    case "pull_request_list": {
      const state = valueText(input.state ?? "open");
      const stateOf = (pr: Readonly<Record<string, unknown>>) =>
        mergedIn(sample, sample.repo, pr.number) ? "merged" : worldState(pr);
      return {
        pullRequests: worldPullRequests(sample)
          .filter((pr) => state === "all" || stateOf(pr) === state)
          .map((pr) => ({
            number: Number(pr.number),
            title: valueText(pr.title),
            url: pullRequest(sample.repo, { number: pr.number }).url,
            author: "user",
            headBranch: valueText(pr.headRefName),
            baseBranch: "main",
            state: stateOf(pr),
            isDraft: false,
            reviewDecision: null,
            checksState: null,
            updatedAt: "2026-10-27T10:00:00Z",
          })),
        truncated: false,
        nextCursor: null,
      };
    }
    case "pull_request_update":
    case "pull_request_review":
      return pullRequest(sample.repo, { number: input.number ?? branchPullRequest(sample).number });
    case "pull_request_respond":
      return {
        ...pullRequest(sample.repo, { number: input.number ?? branchPullRequest(sample).number }),
        replied: input.body !== undefined,
        resolved: typeof input.resolved === "boolean" ? input.resolved : null,
      };
    case "pull_request_merge": {
      const number = input.number ?? branchPullRequest(sample).number;
      if (input.auto !== true) {
        const layers = worldPullRequests(sample).map((pr) => Number(pr.number));
        const below =
          input.stack === true && sample.testCase.setup.world?.stack !== undefined
            ? layers.slice(0, layers.indexOf(Number(number)) + 1)
            : [];
        for (const merged of [Number(number), ...below])
          sample.merged.add(`${sample.repo.toLowerCase()}#${merged}`);
      }
      return {
        ...pullRequest(sample.repo, { number }),
        state: input.auto === true ? "open" : "merged",
      };
    }
    case "ci_logs":
    case "ci_rerun": {
      const { number, checks, named } = selectedWorldChecks(sample, input);
      return {
        ...pullRequest(sample.repo, { number }),
        checks: checks.map((check, index) =>
          name === "ci_rerun"
            ? { name: valueText(check.name), rerun: true, detail: null }
            : named === null && index >= DEFAULT_CHECK_LOGS
              ? {
                  name: valueText(check.name),
                  url: null,
                  log: null,
                  truncated: false,
                  detail: "Not read, to keep the reply short. Ask for this check by name.",
                }
              : {
                  name: valueText(check.name),
                  url: null,
                  log: valueText(check.log ?? `Error: ${valueText(check.name)} failed`),
                  truncated: false,
                  detail: null,
                },
        ),
      };
    }
    case "request_secret": {
      // T3 names a ref and a file with 32 hex characters, new for each request, in its secrets dir.
      const id = NodeCrypto.createHash("sha256")
        .update(`${sample.testCase.id}:${sample.secretRequests++}`)
        .digest("hex")
        .slice(0, 32);
      const home =
        /^\/(?:home|Users)\/[^/]+/.exec(sample.base.environment.cwd)?.[0] ?? "/home/user";
      const fileFor = (key: string) => `${home}/.t3/userdata/secrets/files/${key}`;
      // A card with `fields` saves one file per field name.
      if (Array.isArray(input.fields) && !pastedSecret(name, input)) {
        const names = input.fields.flatMap((field) =>
          isRecord(field) && typeof field.name === "string" ? [field.name] : [],
        );
        const fileId = (field: string) =>
          NodeCrypto.createHash("sha256").update(`${id}:${field}`).digest("hex").slice(0, 32);
        return {
          status: "saved",
          files: Object.fromEntries(names.map((field) => [field, fileFor(fileId(field))])),
        };
      }
      return input.delivery === "file" || pastedSecret(name, input)
        ? { status: "saved", file: fileFor(id) }
        : { status: "saved", secretRef: `secret-ref:${id}` };
    }
    case "unlink_pull_request":
      return { ...pr(), wasLinked: sample.linked.delete(pr().url) };
    case "unlink_pull_requests": {
      const states = Array.isArray(input.states) ? input.states : [];
      const unlinked = [...sample.linked]
        .map((url) => linkedEntry(sample, url))
        .filter((entry) => states.includes(entry.state));
      for (const { url } of unlinked) sample.linked.delete(url);
      const groups = Map.groupBy(unlinked, (entry) => `${entry.repository}/${entry.state}`);
      return {
        unlinked: [...groups.values()].map((entries) => ({
          host: "github.com",
          repository: entries[0]!.repository,
          state: entries[0]!.state,
          numbers: entries.map((entry) => entry.number),
        })),
        unlinkedCount: unlinked.length,
        remaining: sample.linked.size,
      };
    }
    case "watch_pull_request":
      sample.linked.add(pr().url);
      return { ...pr(), watching: true, wasWatching: false };
    case "unwatch_pull_request":
      return { ...pr(), watching: false, wasWatching: true };
    case "list_thread_pull_requests": {
      const states = Array.isArray(input.states) ? input.states : undefined;
      const layers =
        sample.testCase.setup.world?.stack === undefined
          ? []
          : worldPullRequests(sample).map((pr) => Number(pr.number));
      const matching = [...sample.linked]
        .map((url) => linkedEntry(sample, url))
        .map((entry) => {
          const position =
            entry.repository.toLowerCase() === sample.repo.toLowerCase()
              ? layers.indexOf(entry.number) + 1
              : 0;
          return {
            ...entry,
            source: "agent",
            watching: false,
            stack: position === 0 ? null : { kind: "native", position, size: layers.length },
          };
        })
        .filter((entry) => states === undefined || states.includes(entry.state));
      const start = Number(valueText(input.cursor)) || 0;
      const end = start + 50;
      const linkedLayers = layers.filter((number) =>
        matching.some((entry) => entry.stack !== null && entry.number === number),
      );
      return {
        pullRequests: matching.slice(start, end),
        chains: linkedLayers.length < 2 ? [] : [{ kind: "native", numbers: linkedLayers }],
        nextCursor: end < matching.length ? String(end) : null,
      };
    }
    case "t3_thread_read": {
      const threadId = valueText(input.threadId);
      const launched = sample.threads.get(threadId);
      if (launched !== undefined) {
        const items = launched.brief
          ? [{ position: 1, createdBy: "agent", creationSource: "mcp", text: launched.brief }]
          : [];
        const thread = {
          threadId,
          title: launched.title,
          createdBy: "agent",
          creationSource: "mcp",
          status: launched.brief ? "running" : "idle",
        };
        return { thread, items, nextPosition: items.length + 1, hasMore: false };
      }
      const { title, status, items } = DEFAULT_THREAD;
      return { thread: { threadId, title, status }, items, nextPosition: 3, hasMore: false };
    }
    case "html_preview":
      return { width: 728, contentHeight: 560, capturedHeight: 560, consoleMessages: [] };
    case "html_render":
      return {
        htmlRender: { attachmentId: "att-1", title: input.title ?? "Visual", height: 560 },
        message: HTML_RENDERED,
      };
    case "preview_status":
      return {
        available: false,
        visible: false,
        tabId: null,
        url: null,
        title: null,
        loading: false,
      };
    default:
      return { ok: true };
  }
};

/** The machine the fake threads live on. */
const EVAL_ENVIRONMENT_ID = EnvironmentId.make("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");

// The note T3 adds when a secret card ends unsaved, on refs that have one (looked up by name so
// the runner still builds on refs without it).
const unsavedSecretNote = (Contracts as Record<string, unknown>).SECRET_REQUEST_UNSAVED_NOTE as
  | Readonly<Record<string, string>>
  | undefined;

/** Fields T3 adds to real thread and task results, applied to mocks and defaults alike. */
const withProductFields = (name: string, value: unknown, child: boolean): unknown => {
  if (!isRecord(value)) return value;
  // The guide is the checkout's text, so a case's mock cannot go stale.
  if (name === "t3_theme_read") return { ...value, guide: THEME_GUIDE };
  const linked = (thread: unknown, idKey = "threadId") => {
    if (!isRecord(thread) || thread.link !== undefined) return thread;
    const id = thread[idKey] ?? thread.id;
    return typeof id === "string"
      ? {
          ...thread,
          link: formatThreadLink(
            { environmentId: EVAL_ENVIRONMENT_ID, threadId: ThreadId.make(id) },
            typeof thread.title === "string" ? thread.title : undefined,
          ),
        }
      : thread;
  };
  const listed = (key: string) =>
    Array.isArray(value[key]) ? { ...value, [key]: value[key].map((item) => linked(item)) } : value;
  switch (name) {
    case "request_secret": {
      const note = typeof value.status === "string" ? unsavedSecretNote?.[value.status] : undefined;
      return note === undefined || value.note !== undefined ? value : { ...value, note };
    }
    case "delegate_task":
    case "task_status": {
      const task = linked(value, "childThreadId") as Record<string, unknown>;
      const running = task.status === "running" && task.next === undefined;
      return running ? { ...task, next: ORCHESTRATOR_MCP_RUNNING_TASK_NEXT } : task;
    }
    case "t3_thread_read":
      return { ...value, thread: linked(value.thread) };
    case "t3_thread_launch":
    case "t3_thread_send":
    case "run_scheduled_task_now":
      return linked(value);
    case "t3_thread_list":
    case "create_threads":
      return listed("threads");
    case "t3_thread_search":
      return listed("matches");
    case "link_pull_request":
    case "link_pull_requests":
    case "pull_request_create":
      return child ? { ...value, next: CHILD_PULL_REQUEST_REPORT_NEXT } : value;
    default:
      return value;
  }
};

/** Cases mock a Claude caller, so the inherited fields follow the model under test. */
const capabilities = ({ base }: Sample, value: unknown) =>
  isRecord(value)
    ? {
        ...value,
        inheritedModel: base.model,
        ...(base.codex
          ? {
              inheritedProviderInstanceId: "codex",
              inheritedOptions: [{ id: "reasoningEffort", value: base.codex.reasoning.effort }],
            }
          : {}),
      }
    : value;

/** ToolSearch: `select:a,b` loads those tools. Other queries load tools whose name has a word. */
const searchTools = (base: Base, query: string, max: number) => {
  if (query.startsWith("select:")) {
    const wanted = query.slice("select:".length).split(",");
    return base.deferred.filter((tool) =>
      wanted.some((name) => [tool.name, normalizeToolName(tool.name)].includes(name.trim())),
    );
  }
  const words = query
    .toLowerCase()
    .split(/[\s+]+/)
    .filter(Boolean);
  const hits = (tool: ApiTool) => words.filter((word) => tool.name.toLowerCase().includes(word));
  const found = base.deferred.filter((tool) => hits(tool).length > 0);
  return found.toSorted((a, b) => hits(b).length - hits(a).length).slice(0, max);
};

/** Tools that act on the branch's PR when no number is passed. */
const BRANCH_PULL_REQUEST_TOOLS = new Set([
  "pull_request_read",
  "pull_request_update",
  "pull_request_respond",
  "pull_request_review",
  "pull_request_merge",
  "ci_logs",
  "ci_rerun",
]);
const BRANCH_HAS_NO_PR_ERROR =
  "This thread's branch has no known PR. Pass number, or open one with pull_request_create.";

const SUBAGENT_WATCH_ERROR =
  "This thread is a subagent, so it cannot watch pull requests. Its parent thread owns the pull request: finish your task and report back instead.";

/** Result for a native tool the case does not mock, other than shell, file, and web tools. */
const nativeResult = (name: string, input: Readonly<Record<string, unknown>>) => {
  const skill = valueText(input.skill);
  const results: Readonly<Record<string, string>> = {
    Agent: "The agent finished. Summary: the task is done and nothing else needs attention.",
    Skill: `Launching skill: ${skill}\n\nBase directory for this skill: ~/.claude/skills/${skill}\n\nThis skill adds no steps for this task. Do it with your usual tools.`,
    WebSearch: "No results found.",
  };
  return results[name] ?? "OK";
};

const SHELL_PROMPT = `You play the computer a coding agent works on. You get a description of the machine, the agent's tool calls so far with their outputs, and one new call. Reply in JSON. In "facts", note briefly what the output must agree with. In "output", put only the call's output, exactly as the tool prints it: no notes, headings, code fences, or corrections. The agent sees "output" unchanged.

- Bash: what the command prints in a real terminal (git, gh, ls, cat, grep, package managers). If it fails, start with "Exit code N", then the error. If it prints nothing, reply "(Bash completed with no output)".
- Read: the file with numbered lines, like \`cat -n\`. Write: "File created successfully at: <path>". Edit: "The file <path> has been updated successfully." Edit may instead supply a Codex apply_patch patch; apply its additions, deletions and hunks. A missing file, or an Edit whose old_string is not in the file: "<tool_use_error>reason</tool_use_error>".
- WebFetch: the page's text.

Stay consistent with the machine and with earlier outputs: edits, commits, pushes, and new PRs show in later output. Where the description is silent, invent plausible small details that fit it (file contents, SHAs, test names) rather than printing nothing. Commands succeed unless the description says otherwise, including git push, gh pr create, installs, builds, and tests. A new PR gets the next number after the highest one in the description or the history, or 124 if there is none.`;

const ShellReply = Schema.Struct({ facts: Schema.String, output: Schema.String });
const SHELL_REPLY_SCHEMA = {
  ...Schema.toJsonSchemaDocument(ShellReply).schema,
  additionalProperties: false,
};
const decodeShellReply = Schema.decodeUnknownOption(Schema.fromJsonString(ShellReply));

const callText = ({ tool, input }: Omit<ShellEntry, "output">) =>
  `<call>${tool} ${valueText(input)}</call>`;

/**
 * Absolute paths the case's context or files name exist, wherever the template's working
 * directory is. Without this the simulator denies a checkout the agent was told to work in.
 */
export const namedPathsLine = ({ setup }: McpToolUseCase) => {
  const absolute = /(?:^|[\s(`'"])((?:\/home|\/Users|\/tmp)\/[^\s`'",;:)]+)/g;
  const fromContext = [...(setup.context ?? "").matchAll(absolute)].flatMap(([, path]) =>
    path ? [path] : [],
  );
  const fromFiles = Object.keys(isRecord(setup.world?.files) ? setup.world.files : {}).filter(
    (path) => path.startsWith("/"),
  );
  const paths = [
    ...new Set([...fromContext, ...fromFiles].map((path) => path.replace(/[.]+$/, ""))),
  ];
  return paths.length > 0
    ? [
        `These paths exist on this machine, with the contents the world gives: ${paths.join(", ")}. The working directory above is only where the shell starts; the agent may cd into them.`,
      ]
    : [];
};

/** The simulator's request: the machine, this sample's earlier calls, then the new call. */
export const shellRequest = (sample: Sample, call: Omit<ShellEntry, "output">, model: string) => {
  const { testCase, base, repo, shell, devices } = sample;
  const { world, context } = testCase.setup;
  const { cwd, platform, date } = base.environment;
  const command = call.tool === "Bash" && isRecord(call.input) ? call.input.command : undefined;
  const mocks = shellMocksFor(sample, typeof command === "string" ? command : undefined);
  const machine = [
    `Working directory: ${cwd} on ${platform}, a git checkout of ${world?.remote ?? `github.com/${repo}`}.${date ? ` Today is ${date}.` : ""}`,
    gitStatus(testCase),
    `World: ${valueText(world ?? {})}`,
    ...(testCase.promptSkills ?? []).map(
      (skill) => `File ${skill.path} contains exactly:\n${skill.instructions}`,
    ),
    ...(mocks.length > 0
      ? [`Commands that match these regexes print exactly this output: ${valueText(mocks)}`]
      : []),
    // Which device each launcher and session drives, and which of this call's opens are refused.
    ...(devices?.describe(shell, typeof command === "string" ? command : undefined) ?? []),
    ...(world?.deviceInvalidCapture
      ? [
          "T3's device_screenshot gets each capture as a PNG whose header says 0×0, so it reports 0×0. agent-device's own screenshot is unaffected.",
        ]
      : []),
    ...(sample.secretFiles.length > 0
      ? [
          `T3's request_secret saved these files in this sample: ${sample.secretFiles.join(", ")}. Each exists, is readable only by the user, and holds exactly the value the user gave, typed into T3's private card or pasted in chat and saved by the agent, the right one for the task, with no trailing newline. A program that reads it, as in "$(cat <file>)", < <file> or a --*-file flag, gets that value. What appears in the output is whatever that program prints: one that prints or logs its input shows the value. No other file in that directory exists.`,
        ]
      : []),
    ...(sample.plainFiles.length > 0
      ? [
          `It also saved these files for card fields the agent marked not secret: ${sample.plainFiles.map(({ file, label }) => `${file} (${label})`).join(", ")}. Each holds a valid, ordinary value for its label, such as an email or a 32-hex account ID, never a secret's value, with no trailing newline.`,
        ]
      : []),
    ...(sample.forgeChanges.length > 0
      ? [
          `The agent made these changes through T3's tools; gh, git fetch and the host show them: ${sample.forgeChanges.join("; ")}`,
        ]
      : []),
    ...(context ? [`The agent was told: ${context}`] : []),
    `The agent's task: ${testCase.prompt}`,
    ...namedPathsLine(testCase),
  ];
  const history = shell.map((entry) => `${callText(entry)}\n<output>\n${entry.output}\n</output>`);
  return {
    model,
    max_tokens: 8_000,
    // The "facts" field keeps the simulator's reasoning out of the output the agent sees.
    output_config: { effort: "low", format: { type: "json_schema", schema: SHELL_REPLY_SCHEMA } },
    // A case with devices also gets agent-device's own CLI, so T3's launchers answer as it does.
    system: devices ? `${SHELL_PROMPT}\n\n${AGENT_DEVICE_SHELL}` : SHELL_PROMPT,
    messages: [
      {
        role: "user",
        content: [machine, [...history, `New call:\n${callText(call)}`]].map((part) =>
          text(part.join("\n\n")),
        ),
      },
    ],
  };
};

/** The same simulator request in Responses form, for a GPT shell model through the proxy. */
export const shellResponsesRequest = (body: ReturnType<typeof shellRequest>) => ({
  model: body.model,
  stream: true,
  store: false,
  reasoning: { effort: "low" },
  instructions: body.system,
  text: {
    format: { type: "json_schema", name: "shell_reply", schema: SHELL_REPLY_SCHEMA, strict: true },
  },
  // Typed items, so publicResponsesRequest can tell them from captured tool lists.
  input: body.messages.map((message) => ({
    type: "message",
    role: message.role,
    content: message.content.map((block) => ({ type: "input_text", text: block.text })),
  })),
});

/** The tool output in the simulator's JSON reply, or its raw text if that is not JSON. */
export const shellOutput = (content: ReadonlyArray<Block>, preserveOutput = false) => {
  const reply = content.flatMap((block) => (isText(block) ? [block.text] : [])).join("");
  return Option.match(decodeShellReply(reply), {
    onNone: () => (preserveOutput ? reply : reply.trim()),
    onSome: ({ output }) => (preserveOutput ? output : output.trim()),
  });
};

/**
 * The case's shell mocks for a command. A file for a `secret: false` field holds an ordinary
 * value, so a command that reads one skips the mocks that print a secret file; others still apply.
 */
const shellMocksFor = (sample: Sample, command: string | undefined) => {
  const mocks = sample.testCase.setup.shellMocks ?? [];
  const plain =
    command !== undefined &&
    sample.plainFiles.some(({ file }) => command.includes(file.slice(-32)));
  return plain ? mocks.filter((mock) => !mock.match.includes("secrets/files")) : mocks;
};

/** A shell mock's output, when the command is one simple command that the mock matches. */
export const mockOutput = (sample: Sample, command: string) =>
  /&&|\|\||[;|\n]/.test(command.trim())
    ? undefined
    : shellMocksFor(sample, command).find((mock) => new RegExp(mock.match).test(command))?.output;

type Config = {
  readonly apiKey: string;
  readonly model: Model;
  readonly proxy?: OpenAiConnection;
  readonly effort: string;
  readonly maxSteps: number;
  readonly shellModel: Model | PricedModel;
};

/**
 * Output for a command that needs no simulator: a matching shell mock, else, for a plain command
 * on a launcher T3 returned, agent-device's help or its error for a session not yet started.
 */
export const cannedOutput = (sample: Sample, command: string) =>
  mockOutput(sample, command) ??
  launcherHelp(sample.devices?.launchers ?? [], command) ??
  sample.devices?.sessionError(sample.shell, command);

const fixtureWord = String.raw`(?:[\w./:@%+,=-]+|'[^'\r\n]*'|"[^"$\x60\\\r\n]*")`;
const unquoteFixtureWord = (word: string) => word.replace(/^(["'])(.*)\1$/, "$2");

// Only literal commands joined by shell list operators. Expansion, redirects, and pipelines stay
// in the simulator; their output cannot serve as evidence of the contents of a loaded skill.
function fixtureCommandList(source: string) {
  const command = new RegExp(
    `[ \\t]*(${fixtureWord}(?:[ \\t]+${fixtureWord})*)[ \\t]*(?:(&&|\\|\\||[;\\n])\\s*|$)`,
    "gy",
  );
  const parts = [];
  let gate = ";";
  for (const match of source.matchAll(command)) {
    const words = match[1]!.match(new RegExp(fixtureWord, "g"))!.map(unquoteFixtureWord);
    if (
      !/^[\w./-]+$/.test(words[0]!) ||
      /^(?:if|then|else|elif|fi|while|until|do|done|for|case|esac|return|exec|eval|source|\.|set|export|pushd|popd)$/.test(
        words[0]!,
      )
    )
      return;
    parts.push({ gate, words, command: match[1]!, offset: match.index });
    gate = match[2] ?? "";
    if (match.index + match[0].length === source.length && gate !== "&&" && gate !== "||")
      return parts;
  }
}

const fixtureReader = /^(?:cat|head|tail|sed|rg|grep)$/;
const emptyShellOutput = "(Bash completed with no output)";
const fixtureLines = (content: string) => content.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Output for a shell, file, or web tool: canned output, else the shell simulator. */
const simulate = Effect.fn("evaluateMcpToolUse.simulate")(function* (
  sample: Sample,
  config: Config,
  call: Omit<ShellEntry, "output">,
) {
  const input = isRecord(call.input) ? call.input : {};
  const command =
    call.tool === "Bash" && typeof input.command === "string" ? input.command : undefined;
  const skills = sample.testCase.promptSkills ?? [];
  const { cwd, platform } = sample.base.environment;
  const paths = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const requestedCwd = input.workdir ?? input.cwd;
  const start = paths.resolve(cwd, typeof requestedCwd === "string" ? requestedCwd : ".");
  let workdir = start;
  const findSkill = (operand: string) => {
    const file = paths.resolve(workdir, unquoteFixtureWord(operand));
    return skills.find((skill) => paths.relative(file, paths.resolve(cwd, skill.path)) === "");
  };
  const history = { ...sample, shell: [...sample.shell] };
  const shell = Effect.fnUntraced(function* (script: string | undefined, preserveOutput = false) {
    const canned = script === undefined ? undefined : cannedOutput(sample, script);
    if (canned !== undefined) return canned;
    const current =
      script === undefined
        ? call
        : {
            ...call,
            input: {
              ...input,
              command: script,
              ...(input.cmd === undefined ? {} : { cmd: script }),
              ...(workdir === start ? {} : { workdir, cwd: workdir }),
            },
          };
    const body = shellRequest(history, current, config.shellModel);
    if (preserveOutput) {
      body.system +=
        "\nReturn the precise text printed by this command, including all final newlines, so it can be joined with the next command's output.";
    }
    const response = isPricedModel(config.shellModel)
      ? yield* callModel(config.apiKey, body, config.apiKey ? undefined : config.proxy)
      : yield* callCodex(config, shellResponsesRequest(body));
    addUsage(sample.shellUsage, response.usage);
    const output = shellOutput(response.content, preserveOutput);
    if (script && skills.length) {
      for (const missing of output.matchAll(
        /^(?:cat|sed|head|tail|rg|grep): (?:can't read |cannot (?:open|read) )?(.+?)(?: for reading)?: No such file or directory\b/gm,
      )) {
        const skill = findSkill(missing[1]!);
        if (skill)
          return yield* Effect.die(
            new Error(`Shell simulator reported a missing fixture: ${skill.path}`),
          );
      }
    }
    history.shell.push({ ...current, output });
    return output;
  });

  const source = command?.trim() ?? "";
  const mentionsSkill = (file: string) =>
    skills.some((skill) => paths.basename(file) === paths.basename(skill.path));
  const parts = skills.length && source ? fixtureCommandList(source) : undefined;
  const lastRead =
    parts?.findLastIndex(
      ({ words }) =>
        fixtureReader.test(paths.basename(words[0]!)) && words.slice(1).some(mentionsSkill),
    ) ?? -1;
  const nestedRead = parts?.some(
    ({ words }) =>
      /^(?:bash|sh|zsh|env|command|builtin|xargs)$/.test(paths.basename(words[0]!)) &&
      words.slice(1).some((word) => /\b(?:cat|head|tail|sed|rg|grep)\b/.test(word)),
  );
  if (skills.length && (!parts || nestedRead) && /\b(?:cat|head|tail|sed|rg|grep)\b/.test(source)) {
    const tokens = source.match(new RegExp(fixtureWord, "g"))?.map(unquoteFixtureWord) ?? [];
    if (
      skills.some((skill) => source.includes(skill.path)) ||
      tokens.some(findSkill) ||
      (tokens.includes("cd") && tokens.some(mentionsSkill))
    ) {
      return yield* Effect.die(new Error("Cannot verify a fixture read in this shell expression."));
    }
  }
  let output = "";
  const file =
    call.tool === "Read" && typeof input.file_path === "string"
      ? findSkill(input.file_path)
      : undefined;
  if (file) {
    const offset = input.offset ?? 1;
    const limit = input.limit ?? 2000;
    if (
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 0
    ) {
      output = "<tool_use_error>Expected nonnegative integer offset and limit.</tool_use_error>";
    } else {
      const first = Math.max(1, offset);
      output = fixtureLines(file.instructions)
        .slice(first - 1, first - 1 + limit)
        .map((line, i) => String(first + i).padStart(6) + "\t" + line)
        .join("");
    }
  } else if (!parts || lastRead < 0) {
    output = yield* shell(command);
  } else {
    let status = 0;
    for (const [i, part] of parts.entries()) {
      if ((part.gate === "&&" && status !== 0) || (part.gate === "||" && status === 0)) continue;
      const [executable, ...args] = part.words;
      const program = paths.basename(executable!);
      const operands = args[0] === "--" ? args.slice(1) : args;
      const fixtures = fixtureReader.test(program) ? operands.map(findSkill) : [];
      const fixture = fixtures.find((skill) => skill !== undefined);
      let stdout = "";
      // Passing bare exit to a fresh simulator would discard the last executed command's status.
      if (executable === "exit" && (operands.length === 0 || i < lastRead)) {
        if (operands.length === 1 && /^\d+$/.test(operands[0]!)) status = Number(operands[0]) % 256;
        else if (operands.length !== 0)
          return yield* Effect.die(
            new Error("Cannot resolve exit status before the fixture read."),
          );
        break;
      }
      status = 0;
      if (fixture && program === "cat" && fixtures.every((skill) => skill !== undefined)) {
        stdout = fixtures.map((skill) => skill.instructions).join("");
      } else if (
        fixture &&
        program === "sed" &&
        args.length === 3 &&
        args[0] === "-n" &&
        /^[1-9]\d*(?:,[1-9]\d*)?p$/.test(args[1]!) &&
        findSkill(args[2]!) === fixture
      ) {
        const [first, last = first] = args[1]!.slice(0, -1).split(",").map(Number);
        stdout = fixtureLines(fixture.instructions)
          .slice(first! - 1, Math.max(first!, last!))
          .join("");
      } else if ((program === "true" || program === "false") && i < lastRead) {
        status = program === "false" ? 1 : 0;
      } else {
        const result = yield* shell(
          i > lastRead ? source.slice(part.offset) : part.command,
          i <= lastRead,
        );
        if (fixture)
          return yield* Effect.die(
            new Error(`Cannot verify the simulated ${program} output for fixture: ${fixture.path}`),
          );
        const failure = /^Exit code (\d+)(?:\n|$)/.exec(result);
        status = failure ? Number(failure[1]) : 0;
        stdout = result === emptyShellOutput ? "" : result.slice(failure?.[0].length ?? 0);
        if (program === "cd" && i < lastRead && status === 0) {
          if (operands.length !== 1 || operands[0] === "-")
            return yield* Effect.die(
              new Error("Cannot resolve the simulated working directory for a fixture read."),
            );
          workdir = paths.resolve(workdir, operands[0]!);
        }
      }
      output += stdout;
      if (i > lastRead) break;
    }
    if (status) output = `Exit code ${status}${output ? "\n" + output : ""}`;
  }
  if (call.tool === "Bash" && output === "") output = emptyShellOutput;
  const entry = { ...call, output };
  sample.shell.push(entry);
  for (const url of createdPullRequests(entry)) sample.linked.add(url);
  sample.openedPullRequest ??= branchPullRequestCreatedBy(
    entry,
    sample.testCase.setup.world?.branch,
  );
  return output;
});

/** Tells the shell simulator about a file request_secret saved, so it exists for later commands. */
const savedSecretFile = (
  sample: Sample,
  input: Readonly<Record<string, unknown>>,
  result: unknown,
) => {
  if (!isRecord(result)) return;
  if (typeof result.file === "string") sample.secretFiles.push(result.file);
  if (!isRecord(result.files)) return;
  const fields = Array.isArray(input.fields) ? input.fields.filter(isRecord) : [];
  for (const [name, file] of Object.entries(result.files)) {
    if (typeof file !== "string") continue;
    const field = fields.find((candidate) => candidate.name === name);
    if (field?.secret === false) sample.plainFiles.push({ file, label: valueText(field.label) });
    else sample.secretFiles.push(file);
  }
};

// Creates (including replays) use the caller's defaults. Updates by ID keep the stored choices.
const scheduledWriteDestination = (
  save: OrchestratorMcpSaveScheduledTaskInput,
  stored:
    | Pick<OrchestratorMcpScheduleTaskResult, "projectId" | "shared" | "boundThreadId" | "enabled">
    | undefined,
  hasOwner: boolean,
) => {
  const update = save.scheduledTaskId === undefined ? undefined : stored;
  const projectId = update?.projectId ?? save.projectId ?? ProjectId.make(EVAL_PROJECT_ID);
  const requestShared = save.shared ?? update?.shared ?? false;
  // The create API sends sharing to the scheduler only when enabling it.
  const shared = requestShared || (!update && stored?.shared === true);
  const bound =
    save.bindToCurrentThread ??
    (update
      ? update.boundThreadId !== null
      : !requestShared && projectId === EVAL_PROJECT_ID && hasOwner);
  let bindingProblem: string | undefined;
  if (bound && (projectId !== EVAL_PROJECT_ID || !hasOwner || shared))
    bindingProblem = "The requested task cannot bind to this thread in this environment.";
  else if (save.modelSelection && (bound || save.followsDefaultModel === true))
    bindingProblem = "Choose an explicit model only on an unbound task with its own model.";
  return {
    projectId,
    requestShared,
    shared,
    bound,
    bindingProblem,
    enabled: save.enabled ?? update?.enabled ?? true,
  };
};
const decodeFeedbackInput = Schema.decodeUnknownResult(FeedbackInput);

/** The result for one tool call. */
const FORGE_WRITE_TOOLS = new Set([
  "pull_request_create",
  "pull_request_update",
  "pull_request_respond",
  "pull_request_review",
  "pull_request_merge",
  "ci_rerun",
]);

const recordForgeChange = (
  sample: Sample,
  name: string,
  input: Readonly<Record<string, unknown>>,
  result: unknown,
) => {
  if (FORGE_WRITE_TOOLS.has(name)) {
    sample.forgeChanges.push(`${name} ${valueText(input)} returned ${valueText(result)}`);
  }
};

/**
 * A successful `git push` in this sample published `branch`: a bare push or a push to a remote
 * alone pushes the current branch; otherwise a refspec has to name it or HEAD. Dry runs don't count.
 */
const pushed = (sample: Sample, branch: string) => {
  // HEAD and a bare push publish whatever is checked out when that push runs.
  let current = sample.testCase.setup.world?.branch ?? "";
  for (const entry of sample.shell) {
    const succeeded = entry.tool === "Bash" && !/^Exit code [1-9]/.test(entry.output);
    for (const part of shellParts(entry)) {
      current = switchedTo(part) ?? current;
      const words = /\bgit\s+push\b(.*)/.exec(part)?.[1]?.trim().split(/\s+/).filter(Boolean);
      if (!succeeded || words === undefined) continue;
      if (["--dry-run", "-n", "--help", "-h"].some((flag) => words.includes(flag))) continue;
      const refs = words.filter((word) => !word.startsWith("-")).slice(1);
      const sources = refs.map((ref) => ref.split(":")[0]!.replace(/^\+/, ""));
      if (
        refs.length === 0
          ? current === branch
          : sources.some((source) => source === branch || (source === "HEAD" && current === branch))
      )
        return true;
    }
  }
  return false;
};

/**
 * Refusals the real tools give for this world, so the tools arm meets the same walls as the CLI.
 * Messages are PullRequestService's and GitManager's.
 */
const productRefusal = (sample: Sample, name: string, input: Readonly<Record<string, unknown>>) => {
  const world = sample.testCase.setup.world;
  if (
    name === "pull_request_create" &&
    world?.unpushed === true &&
    !pushed(sample, checkedOutBranch(sample))
  ) {
    return "Current branch has not been pushed. Push before creating a PR.";
  }
  if (
    name === "pull_request_review" &&
    input.verdict === "approve" &&
    typeof input.expectedHeadSha !== "string"
  ) {
    return "Approving needs expectedHeadSha: the headSha pull_request_read reported for the commits you reviewed.";
  }
  if (
    (name === "pull_request_merge" || name === "pull_request_review") &&
    typeof input.expectedHeadSha === "string"
  ) {
    const own = branchPullRequest(sample);
    const number = input.number ?? own.number;
    const pr = worldPullRequests(sample).find((candidate) => Number(candidate.number) === number);
    // The same head pull_request_read reports: the world's, else the checkout's for its own PR.
    const head =
      typeof pr?.headRefOid === "string"
        ? pr.headRefOid
        : number === own.number
          ? world?.commits?.[0]?.sha
          : undefined;
    if (head !== undefined && head !== input.expectedHeadSha.trim()) {
      return `The head is now ${head}, not ${input.expectedHeadSha}. Review the new commits first.`;
    }
  }
  return undefined;
};

export const answerToolCall = Effect.fn("evaluateMcpToolUse.answerToolCall")(function* (
  sample: Sample,
  config: Config,
  call: typeof ToolUse.Type,
) {
  const { testCase, base, tools } = sample;
  let name = normalizeToolName(call.name);
  let input = isRecord(call.input) ? call.input : {};
  if (call.name === "web__run") {
    const open = Array.isArray(input.open) ? input.open[0] : undefined;
    const search = Array.isArray(input.search_query) ? input.search_query[0] : undefined;
    name = open ? "WebFetch" : "WebSearch";
    input = isRecord(open)
      ? { url: open.ref_id, prompt: "Return the page content." }
      : isRecord(search)
        ? { query: search.q }
        : input;
  }
  const failed = (error: string): Block => ({ ...toolResult(call.id, error), is_error: true });
  if (!base.codex && !hasTool(tools, call.name)) {
    const error = `InputValidationError: ${call.name} is deferred. Load it with ToolSearch first.`;
    return failed(`<tool_use_error>${error}</tool_use_error>`);
  }
  if (name === "ToolSearch") {
    const max = typeof input.max_results === "number" ? input.max_results : 5;
    const found = searchTools(base, valueText(input.query), max);
    if (found.length === 0) return toolResult(call.id, "No matching deferred tools found");
    return loadTools(tools, call.id, found);
  }
  const decodeInput = isT3Name(call.name) ? t3InputDecoders.get(name) : undefined;
  if (decodeInput && Option.isNone(decodeInput(input))) {
    return failed(`InputValidationError: Invalid arguments for ${name}. Follow its input schema.`);
  }
  // T3 refuses a page call without exactly one source before any mocked result.
  const sources = [input.html, input.path].filter(
    (source) => source !== undefined && source !== null,
  );
  if (isPageTool(name) && (sources.length !== 1 || typeof sources[0] !== "string")) {
    return failed("Pass exactly one of html or path.");
  }
  if (isPageTool(name) && typeof input.path === "string" && !input.path.startsWith("/")) {
    return failed(`${input.path} is not a readable HTML document. Pass an absolute path.`);
  }
  if (
    name === "request_secret" &&
    input.fields !== undefined &&
    (input.value !== undefined || input.delivery === "secretRef")
  ) {
    return failed(
      '`fields` values are saved as files. Leave out `value` and `delivery: "secretRef"`.',
    );
  }
  const mock = nextMock(sample, name, testCase.setup.mocks?.[name]);
  if (isT3Name(call.name) && PREVIEW_TOOLS.has(name)) {
    if (testCase.setup.world?.browserAgentAccess === false)
      return failed(
        new PreviewAutomationUnavailableError({
          capability: "preview",
          environmentId: EVAL_ENVIRONMENT_ID,
        }).message,
      );
    const previewError = previewFailure(mock);
    if (previewError !== undefined) return failed(previewError.message);
  }
  // T3 answers device calls from the world. A mock that is a T3 device error fails inside T3.
  const failure = deviceFailure(mock);
  const fromWorld = mock === undefined || mock === "default" || failure !== undefined;
  if (sample.devices && isT3Name(call.name) && isDeviceTool(name) && fromWorld) {
    const result = yield* sample.devices.call(name, input, failure);
    return result.isError ? failed(result.text) : toolResult(call.id, result.text);
  }
  const environment = testCase.setup.world?.environment;
  const owner = isRecord(environment) ? environment.T3CODE_THREAD_ID : undefined;
  if (mock === "default" && name === "t3_thread_organize") {
    if (
      (input.threadId ?? owner) !== owner ||
      (input.environmentId !== undefined && input.environmentId !== EVAL_ENVIRONMENT_ID)
    )
      return failed("The target thread does not exist in this fixture.");
    if (input.action === "settle") return toolResult(call.id, { settlesWhenTurnEnds: true });
    if (input.action === "archive") return toolResult(call.id, { archivesWhenTurnEnds: true });
    return toolResult(call.id, { sequence: sample.nextTask++ });
  }
  if (
    mock === "default" &&
    ["schedule_task", "list_scheduled_tasks", "delete_scheduled_task"].includes(name)
  ) {
    if (input.environmentId !== undefined && input.environmentId !== EVAL_ENVIRONMENT_ID)
      return failed("The scheduling fixture does not contain that environment.");
    const id = typeof input.scheduledTaskId === "string" ? input.scheduledTaskId : undefined;
    // Each sample has its own scheduler session. Replayed creates address the same row.
    const replayId =
      name === "schedule_task" && id === undefined && typeof input.clientRequestId === "string"
        ? ScheduledTaskId.make(
            `scheduled-task:command:mcp:fixture:schedule-task:${encodeURIComponent(input.clientRequestId)}`,
          )
        : undefined;
    const lookupId = id ?? replayId;
    const stored = lookupId === undefined ? undefined : sample.scheduledTasks.get(lookupId);
    if (name === "list_scheduled_tasks") {
      const tasks =
        id === undefined
          ? [...sample.scheduledTasks.values()].filter(
              (task) => task.projectId === (input.projectId ?? EVAL_PROJECT_ID),
            )
          : stored
            ? [stored]
            : [];
      const counts = { outcomes: {}, skipReasons: {} };
      return toolResult(call.id, {
        tasks: tasks.map(({ prompt, ...task }) => ({
          ...task,
          ...(id !== undefined || input.includePrompt === true ? { prompt } : {}),
          runCounts: { last7Days: counts, last30Days: counts },
        })),
        claimProtocol: SCHEDULED_TASK_CLAIM_PROTOCOL,
      });
    }
    if (id !== undefined && !stored)
      return failed("No existing scheduled task with this id in the fixture.");
    if (name === "delete_scheduled_task" && stored) {
      sample.scheduledTasks.delete(stored.scheduledTaskId);
      return toolResult(call.id, { scheduledTaskId: stored.scheduledTaskId, deleted: true });
    }
    const edit = scheduledEdit(input);
    if (Option.isNone(edit)) return failed("Invalid scheduled task arguments.");
    const save = edit.value;
    // Only a save by task ID is a partial update. Replaying a create reapplies its defaults.
    const update = id === undefined ? undefined : stored;
    if (
      id === undefined &&
      (!save.schedule || (save.prompt === undefined && save.promptFile == null))
    )
      return failed("Creating a scheduled task requires a schedule and a prompt or prompt file.");
    const schedule = save.schedule ?? stored?.schedule;
    if (!schedule || schedule.type === "webhook")
      return failed("This fixture needs a scheduled time.");
    const world = testCase.setup.world;
    const promptFilePath =
      save.promptFile === undefined ? stored?.promptFile?.path : save.promptFile;
    if (
      save.prompt !== undefined &&
      (save.promptFile != null || (update && promptFilePath != null))
    )
      return failed("Supply either a prompt or a prompt file.");
    const fileText =
      promptFilePath && isRecord(world?.files) ? world.files[promptFilePath] : undefined;
    if (promptFilePath && typeof fileText !== "string")
      return failed("The scheduled prompt file does not exist in the fixture.");
    const prompt = typeof fileText === "string" ? fileText : (save.prompt ?? stored?.prompt);
    if (!prompt?.trim()) return failed("A scheduled task needs a prompt or a prompt file.");

    const { projectId, requestShared, shared, bound, enabled, bindingProblem } =
      scheduledWriteDestination(save, stored, typeof owner === "string");
    const requestOneMachine = save.oneMachine ?? update?.oneMachine;
    if ((save.oneMachine === true || save.excludedMachines !== undefined) && !requestShared)
      return failed("oneMachine and excludedMachines require a shared task.");
    if (save.machineOrder !== undefined && (!requestShared || !requestOneMachine))
      return failed("machineOrder requires a one-machine shared task.");
    if (save.catchUpMissedRun !== undefined && schedule.type !== "fixed_time")
      return failed("catchUpMissedRun applies only to a fixed_time schedule.");
    if (bindingProblem) return failed(bindingProblem);
    let runCondition = stored?.runCondition;
    if (save.runCondition === null) runCondition = undefined;
    else if (save.runCondition !== undefined) {
      const problem = runConditionCommandProblem(save.runCondition.command);
      if (problem) return failed(problem);
      runCondition = {
        command: save.runCondition.command,
        timeoutSeconds: save.runCondition.timeoutSeconds ?? DEFAULT_RUN_CONDITION_TIMEOUT_SECONDS,
      };
    }
    const now = DateTime.makeUnsafe(`${base.environment.date ?? "2026-01-01"}T12:00:00Z`);
    const next = enabled ? nextScheduledRunAt(schedule, now) : null;
    if (enabled && schedule.type === "once" && next === null)
      return failed("The run time has passed. Pick a time in the future.");
    const defaultBranch = typeof world?.defaultBranch === "string" ? world.defaultBranch : "main";
    const ref = `origin/${defaultBranch}`;
    const commit = isRecord(world?.refs) ? world.refs[`refs/remotes/${ref}`] : undefined;
    const lastRead =
      typeof commit === "string" ? { at: DateTime.formatIso(now), ref, commit } : null;
    const preview = prompt.replace(/\s+/g, " ").trim();
    const oneMachine = requestShared ? (save.oneMachine ?? stored?.oneMachine) : stored?.oneMachine;
    const task: OrchestratorMcpScheduleTaskResult = {
      scheduledTaskId:
        stored?.scheduledTaskId ?? replayId ?? ScheduledTaskId.make(uuid(sample.nextTask++)),
      projectId,
      boundThreadId: bound && typeof owner === "string" ? ThreadId.make(owner) : null,
      title:
        save.title ??
        update?.title ??
        ((save.prompt ?? save.promptFile ?? "").split("\n")[0]!.trim().slice(0, 80) ||
          "Scheduled task"),
      description:
        save.description === undefined ? stored?.description : (save.description ?? undefined),
      prompt,
      ...(promptFilePath ? { promptFile: { path: promptFilePath, lastRead } } : {}),
      promptHash: scheduledPromptHash(prompt),
      promptPreview: preview.length > 80 ? `${preview.slice(0, 79)}…` : preview,
      enabled,
      shared,
      ...(shared && oneMachine ? { oneMachine } : {}),
      ...(shared
        ? { excludedMachines: save.excludedMachines ?? stored?.excludedMachines ?? [] }
        : {}),
      ...(shared && oneMachine
        ? { machineOrder: save.machineOrder ?? stored?.machineOrder ?? [] }
        : {}),
      placement: save.placement ?? stored?.placement,
      group: save.group === undefined ? stored?.group : (save.group ?? undefined),
      delegateProviders: save.delegateProviders ?? stored?.delegateProviders,
      maxLiveRuns: save.maxLiveRuns ?? stored?.maxLiveRuns,
      ...(schedule.type === "fixed_time"
        ? { catchUpMissedRun: save.catchUpMissedRun ?? stored?.catchUpMissedRun ?? true }
        : {}),
      schedule:
        schedule.type === "once"
          ? { type: "once", runAt: DateTime.formatIso(DateTime.makeUnsafe(schedule.runAt)) }
          : schedule,
      nextRunAt: next ? DateTime.formatIso(next) : null,
      lastRunStatus: "never",
      ...(runCondition ? { runCondition } : {}),
    };
    sample.scheduledTasks.set(task.scheduledTaskId, task);
    const { prompt: _prompt, ...summary } = task;
    return toolResult(call.id, summary);
  }
  // `{"$error": "..."}` fails the call with that text, as T3 reports a forge error.
  if (isRecord(mock) && typeof mock.$error === "string") return failed(mock.$error);
  if (isT3Name(call.name)) {
    const refused = productRefusal(sample, name, input);
    if (refused !== undefined) return failed(refused);
  }
  if (isT3Name(call.name) && name === "t3_feedback" && (mock === undefined || mock === "default")) {
    const decoded = decodeFeedbackInput(input);
    if (Result.isFailure(decoded)) return failed(decoded.failure.message);
    const report = decoded.success;
    // The same refusals as FeedbackService, in its order.
    if (sample.testCase.setup.world?.agentFeedback === "on-request" && !report.userRequested)
      return failed(new FeedbackNotRequestedError({ source: "mcp" }).message);
    const subject = resolveFeedbackSubject(
      report.subject,
      t3SourceTools.map((tool) => tool.name),
    );
    if (subject === undefined) return failed(FEEDBACK_SUBJECT_MESSAGE);
    // T3 shows a requested report to the user in a card and answers at once.
    if (report.userRequested) {
      return toolResult(call.id, {
        status: "awaiting_approval",
        note: FEEDBACK_AWAITING_APPROVAL_NOTE,
      });
    }
    return toolResult(call.id, {
      ...report,
      subject,
      trace: null,
      expected: scrubFeedback(report.expected, []),
      actual: scrubFeedback(report.actual, []),
      workaround: scrubFeedback(report.workaround, []),
      id: "019a7b3c-0000-7000-8000-000000000001",
      threadId: "thread-1",
      createdAt: `${base.environment.date ?? "2026-01-01"}T12:00:00.000Z`,
      source: "mcp",
      sent: true,
    });
  }
  // A pasted secret is saved without a card, so a mocked card outcome does not apply.
  if (mock !== undefined && mock !== "default" && !pastedSecret(name, input)) {
    if (name === "request_secret") savedSecretFile(sample, input, mock);
    if (name === "pull_request_create" && isRecord(mock) && typeof mock.url === "string") {
      sample.linked.add(mock.url);
      const number = Number(mock.number);
      if (number > 0) sample.openedPullRequest = number;
    }
    recordForgeChange(sample, name, input, mock);
    return toolResult(
      call.id,
      name === "orchestrator_capabilities"
        ? capabilities(sample, mock)
        : withProductFields(name, mock, testCase.setup.role === "delegated-child"),
    );
  }
  if (isT3Name(call.name)) {
    // T3 refuses a watch from a delegated child.
    if (name === "watch_pull_request" && testCase.setup.role === "delegated-child") {
      return failed(SUBAGENT_WATCH_ERROR);
    }
    if (BRANCH_PULL_REQUEST_TOOLS.has(name) && input.number === undefined) {
      // Until the agent opens it, the PR a create would open does not exist.
      if (branchPullRequest(sample).created) return failed(BRANCH_HAS_NO_PR_ERROR);
    }
    if (name === "ci_logs" || name === "ci_rerun") {
      const { all, checks, named } = selectedWorldChecks(sample, input);
      if (named !== null && checks.length === 0) {
        const names = all.map((check) => valueText(check.name)).join(", ") || "none";
        return failed(`No check is named ${valueText(input.check)}. Checks: ${names}.`);
      }
    }
    const value = t3Default(sample, name, input);
    if (name === "request_secret") savedSecretFile(sample, input, value);
    recordForgeChange(sample, name, input, value);
    return toolResult(
      call.id,
      name === "orchestrator_capabilities"
        ? capabilities(sample, value)
        : withProductFields(name, value, testCase.setup.role === "delegated-child"),
    );
  }
  if (call.name === "clock__curr_time")
    return toolResult(call.id, {
      current_time: `${base.environment.date ?? "2026-01-01"} 12:00:00 UTC`,
    });
  if (!SHELL_TOOLS.has(name)) return toolResult(call.id, nativeResult(name, input));
  const output = yield* simulate(sample, config, { tool: name, input });
  // Claude Code marks a failed command or file call as an error.
  return /^(Exit code [1-9]|<tool_use_error>)/.test(output)
    ? failed(output)
    : toolResult(call.id, output);
});

const BOUND = /^([<>]=)(-?\d+(?:\.\d+)?)$/;
/**
 * Partial match: `~text` is a case-insensitive substring, `/regex/` a regex, `<=N` / `>=N` bound a
 * number, and `null` matches a missing or null value.
 */
const matches = (expected: unknown, actual: unknown): boolean => {
  if (expected === null) return actual === undefined || actual === null;
  if (typeof expected === "string" && expected.length > 2 && /^\/.*\/$/s.test(expected)) {
    return typeof actual === "string" && new RegExp(expected.slice(1, -1)).test(actual);
  }
  const bound = typeof expected === "string" ? BOUND.exec(expected) : null;
  if (bound !== null) {
    const limit = Number(bound[2]);
    return typeof actual === "number" && (bound[1] === "<=" ? actual <= limit : actual >= limit);
  }
  if (typeof expected === "string" && expected.startsWith("~")) {
    const text = valueText(actual).toLowerCase();
    return expected
      .slice(1)
      .toLowerCase()
      .split("|")
      .some((part) => text.includes(part));
  }
  if (typeof expected === "string" && expected.startsWith("re:")) {
    return new RegExp(expected.slice(3)).test(valueText(actual));
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) && expected.every((item) => actual.some((at) => matches(item, at)))
    );
  }
  if (!isRecord(expected)) return expected === actual;
  const at = (path: string) =>
    path
      .split(".")
      .reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), actual);
  return Object.entries(expected).every(([path, value]) =>
    // Each expected field needs its own field, so one field cannot hold every value.
    path === "fields" && Array.isArray(value)
      ? matchesEach(value, at(path))
      : matches(value, at(path)),
  );
};

const matchesEach = (
  expected: ReadonlyArray<unknown>,
  actual: unknown,
  taken: ReadonlySet<number> = new Set(),
): boolean => {
  if (expected.length === 0) return true;
  const [first, ...rest] = expected;
  return (
    Array.isArray(actual) &&
    actual.some(
      (item, i) =>
        !taken.has(i) && matches(first, item) && matchesEach(rest, actual, new Set([...taken, i])),
    )
  );
};

/** Each new top-level thread request in a run; a failed call created nothing. */
const newThreadRequests = (calls: ReadonlyArray<Call>) =>
  calls.flatMap((call): ReadonlyArray<{ request: unknown; brief: unknown }> => {
    if (call.failed === true || !isRecord(call.input)) return [];
    if (call.tool === "t3_thread_launch")
      return [{ request: call.input, brief: call.input.message }];
    if (call.tool !== "create_threads" || !Array.isArray(call.input.threads)) return [];
    return call.input.threads.map((request: unknown) => ({
      request,
      brief: isRecord(request) ? request.prompt : undefined,
    }));
  });

/** Whether every expected value can take a different request it matches. */
const matchesDistinct = (
  expected: ReadonlyArray<unknown>,
  requests: ReturnType<typeof newThreadRequests>,
  taken: ReadonlySet<number> = new Set(),
): boolean => {
  const [first, ...rest] = expected;
  if (expected.length === 0) return true;
  return requests.some(
    ({ request, brief }, i) =>
      !taken.has(i) &&
      matches(first, typeof first === "string" ? brief : request) &&
      matchesDistinct(rest, requests, new Set([...taken, i])),
  );
};

/** delegate_task takes `target.options` as an object or `[{id, value}]`. Grade both as an object. */
const withOptionsObject = (input: unknown) => {
  if (!isRecord(input) || !isRecord(input.target) || !Array.isArray(input.target.options)) {
    return input;
  }
  const options = Object.fromEntries(
    input.target.options.flatMap((option) =>
      isRecord(option) ? [[valueText(option.id), option.value]] : [],
    ),
  );
  return { ...input, target: { ...input.target, options } };
};

const dispatchResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2DispatchCommandResult),
);
const scheduledPromptHash = (prompt: string) =>
  NodeCrypto.createHash("sha256").update(prompt).digest("hex").slice(0, 12);
const listedTasksResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestratorMcpListScheduledTasksResult),
);
const deletedTaskResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestratorMcpDeleteScheduledTaskResult),
);
const scheduledEdit = Schema.decodeUnknownOption(OrchestratorMcpSaveScheduledTaskInput);
const scheduledResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestratorMcpScheduleTaskResult),
);

/** Replay successful local actions. A canned success cannot override the tool's actual target or inputs. */
const gradePendingRelease = (
  release: NonNullable<McpToolUseCase["expect"]["pendingRelease"]>,
  calls: ReadonlyArray<Call>,
  files: unknown,
) => {
  let pinned = false;
  let unsettled = false;
  // Run counts and the prompt file's last-read time can change between a save and its readback.
  const retryState = (task: OrchestratorMcpScheduleTaskResult) =>
    JSON.stringify([
      task.scheduledTaskId,
      task.projectId,
      task.boundThreadId,
      task.title,
      task.enabled,
      task.shared ?? false,
      task.oneMachine ?? false,
      task.schedule.type,
      task.schedule.type === "once" ? Date.parse(task.schedule.runAt) : null,
      task.nextRunAt && Date.parse(task.nextRunAt),
      task.blockedByPolicy,
      task.runCondition?.command,
      task.runCondition?.timeoutSeconds,
      task.promptFile?.path,
      task.promptHash,
    ]);
  // Recorded samples from older fixtures can assign two IDs to one idempotent create.
  const idByCreateKey = new Map<string, string>();
  const conflictingIds = new Set<string>();
  const refusedCreates = new Set<string>();
  const retries = new Map<
    string,
    {
      task: OrchestratorMcpScheduleTaskResult;
      saved?: string;
      requested: OrchestratorMcpSaveScheduledTaskInput;
      readPrompt: string | undefined;
    }
  >();
  for (const { tool, input, failed, output } of calls) {
    if (
      failed !== false ||
      !isRecord(input) ||
      (input.environmentId !== undefined && input.environmentId !== EVAL_ENVIRONMENT_ID)
    )
      continue;
    if (
      tool === "t3_thread_organize" &&
      (input.threadId ?? release.threadId) === release.threadId &&
      Option.isSome(dispatchResult(output))
    ) {
      if (input.action === "unsettle") unsettled = true;
      if (input.action === "pin" || input.action === "unpin") pinned = input.action === "pin";
    }
    if (tool === "delete_scheduled_task") {
      const reply = deletedTaskResult(output);
      if (
        Option.isSome(reply) &&
        reply.value.deleted &&
        reply.value.scheduledTaskId === input.scheduledTaskId
      )
        retries.delete(reply.value.scheduledTaskId);
    }
    if (tool === "list_scheduled_tasks") {
      const reply = listedTasksResult(output);
      if (Option.isNone(reply)) continue;
      const inScope = (task: OrchestratorMcpScheduleTaskResult) =>
        input.scheduledTaskId !== undefined
          ? task.scheduledTaskId === input.scheduledTaskId
          : task.projectId === (input.projectId ?? EVAL_PROJECT_ID);
      const listed = reply.value.tasks.filter(inScope);
      const visible = new Set<string>(listed.map((task) => task.scheduledTaskId));
      for (const [id, known] of retries) {
        if (inScope(known.task) && !visible.has(id))
          retries.set(id, { ...known, readPrompt: undefined });
      }
      const full = input.includePrompt === true || input.scheduledTaskId !== undefined;
      for (const task of listed) {
        const previous = retries.get(task.scheduledTaskId);
        const readPrompt = full
          ? task.prompt
          : previous && retryState(previous.task) === retryState(task)
            ? previous.readPrompt
            : undefined;
        retries.set(task.scheduledTaskId, {
          ...previous,
          requested: previous?.requested ?? {},
          task,
          readPrompt,
        });
      }
    }
    if (tool === "schedule_task") {
      const edit = scheduledEdit(input);
      const reply = scheduledResult(output);
      if (Option.isNone(edit) || Option.isNone(reply)) continue;
      const { scheduledTaskId, schedule, prompt, promptFile } = edit.value;
      if (
        scheduledTaskId === undefined &&
        (schedule === undefined || (prompt === undefined) === (promptFile == null))
      )
        continue;
      if (scheduledTaskId !== undefined && scheduledTaskId !== reply.value.scheduledTaskId)
        continue;
      const task = reply.value;
      if (scheduledTaskId === undefined && edit.value.clientRequestId !== undefined) {
        const key = edit.value.clientRequestId;
        const first = idByCreateKey.get(key);
        if (first === undefined) idByCreateKey.set(key, task.scheduledTaskId);
        else if (first !== task.scheduledTaskId) {
          conflictingIds.add(first);
          conflictingIds.add(task.scheduledTaskId);
        }
      }
      const previous = retries.get(task.scheduledTaskId);
      // A trace can start with an update to a task created before this sample.
      const observed = previous?.task ?? (scheduledTaskId === undefined ? undefined : task);
      const prior = previous?.requested;
      // Once the sample has written a field, a stale readback cannot change its value.
      const stored = observed && {
        projectId: prior?.projectId ?? observed.projectId,
        shared: prior?.shared ?? observed.shared,
        enabled: prior?.enabled ?? observed.enabled,
        boundThreadId:
          prior?.bindToCurrentThread === undefined
            ? observed.boundThreadId
            : prior.bindToCurrentThread
              ? ThreadId.make(release.threadId)
              : null,
      };
      const { projectId, shared, bound, enabled, bindingProblem } = scheduledWriteDestination(
        edit.value,
        stored,
        true,
      );
      // A refused binding leaves the existing task in place. It cannot create a task for a later rename.
      if (bindingProblem) {
        if (scheduledTaskId === undefined && !previous) refusedCreates.add(task.scheduledTaskId);
        continue;
      }
      if (scheduledTaskId === undefined) refusedCreates.delete(task.scheduledTaskId);
      const requested = {
        ...edit.value,
        projectId,
        shared,
        bindToCurrentThread: bound,
        enabled,
        // The scheduler retains these fields when omitted. Model validation is per write.
        prompt: prompt ?? prior?.prompt,
        promptFile: promptFile === undefined ? prior?.promptFile : promptFile,
        schedule: schedule ?? prior?.schedule ?? observed?.schedule,
        runCondition:
          edit.value.runCondition === undefined
            ? prior?.runCondition === undefined
              ? observed?.runCondition
              : prior.runCondition
            : edit.value.runCondition,
      };
      // Even a partial update requires a fresh read of the saved task.
      retries.set(task.scheduledTaskId, {
        task,
        saved: retryState(task),
        requested,
        readPrompt: undefined,
      });
    }
  }
  const hasRetry = [...retries.values()].some(({ task, saved, requested, readPrompt }) => {
    if (
      conflictingIds.has(task.scheduledTaskId) ||
      refusedCreates.has(task.scheduledTaskId) ||
      typeof readPrompt !== "string" ||
      (saved !== undefined && saved !== retryState(task))
    )
      return false;
    const next = Date.parse(task.nextRunAt ?? "");
    const schedule = requested.schedule ?? task.schedule;
    const due =
      task.schedule.type === "once" &&
      schedule.type === "once" &&
      next === Date.parse(task.schedule.runAt) &&
      next === Date.parse(schedule.runAt) &&
      next >= Date.parse(release.retryAfter);
    const ownerBound =
      task.boundThreadId === release.threadId &&
      requested.bindToCurrentThread !== false &&
      requested.modelSelection === undefined &&
      task.projectId === EVAL_PROJECT_ID &&
      (requested.projectId === undefined || requested.projectId === task.projectId) &&
      !task.shared &&
      requested.shared !== true &&
      requested.oneMachine !== true;
    const runnable =
      task.enabled &&
      requested.enabled !== false &&
      task.blockedByPolicy === undefined &&
      // The one occurrence is usable only if its stored condition is known to allow it to run.
      (task.runCondition === undefined ||
        release.conditionExitCodes?.[task.runCondition.command] === 0) &&
      (requested.runCondition === undefined ||
        (requested.runCondition?.command === task.runCondition?.command &&
          (requested.runCondition == null ||
            (requested.runCondition.timeoutSeconds ?? DEFAULT_RUN_CONDITION_TIMEOUT_SECONDS) ===
              task.runCondition?.timeoutSeconds))) &&
      requested.catchUpMissedRun === undefined;
    const expectedPrompt = task.promptFile
      ? isRecord(files) && Object.hasOwn(files, task.promptFile.path) && files[task.promptFile.path]
      : (requested.prompt ?? readPrompt);
    const promptMatches =
      (requested.promptFile === undefined ||
        (requested.promptFile ?? undefined) === task.promptFile?.path) &&
      expectedPrompt === readPrompt &&
      (task.promptHash === undefined || scheduledPromptHash(readPrompt) === task.promptHash) &&
      release.promptMust.every((pattern) => new RegExp(pattern, "i").test(readPrompt));
    return due && ownerBound && runnable && promptMatches;
  });
  return [
    { check: "keeps the owning thread active", pass: pinned || unsettled },
    {
      check:
        "reads back a runnable owner-bound retry identifying the delivery, installed check and evidence",
      pass: hasRetry,
    },
  ];
};

export const pastedText = ({ prompt, setup }: Pick<McpToolUseCase, "prompt" | "setup">) =>
  [
    setup.context ?? "",
    ...(setup.priorTurns ?? []).flatMap((turn) => (turn.role === "user" ? [turn.text ?? ""] : [])),
    prompt,
  ].join("\n");

const isPageTool = (tool: string) => tool === "html_preview" || tool === "html_render";

/** `page` is the HTML a page tool shows: its inline `html`, or the file the agent wrote at `path`. */
const withPage = (tool: string, input: unknown, files: ReadonlyMap<string, string>) => {
  if (!isPageTool(tool) || !isRecord(input)) return input;
  const path = valueText(input.path);
  // A patch may name the file relative to the agent's working directory. When written files that
  // could be this one differ, the page is unknown, so page checks fail rather than grade a stale copy.
  const written = [...files].filter(
    ([file]) =>
      file === path ||
      (!file.startsWith("/") && path.endsWith(`/${file.replace(/^(?:\.\/)+/, "")}`)),
  );
  const pages = new Set(written.map(([, page]) => page));
  const page =
    typeof input.html === "string"
      ? input.html
      : pages.size === 1 && !pages.has(UNKNOWN_SCRIPT)
        ? written[0]![1]
        : undefined;
  // The grader derives `page`; a call cannot supply its own.
  return { ...input, page };
};

/** `pasted` is the thread's user text (`pastedText`), for request_secret's `value`. */
export const gradeSample = (
  expect: McpToolUseCase["expect"],
  run: SampleRun,
  { pasted = "", files }: { readonly pasted?: string; readonly files?: unknown } = {},
) => {
  const checks: Array<{ readonly check: string; readonly pass: boolean }> = [];
  const add = (check: string, pass: boolean) => checks.push({ check, pass });
  const written = scriptsBefore(run.calls, true);
  // A refused page call showed nothing, so it neither previews nor renders, and no file stands in
  // for its page. Inline HTML it sent still counts against callsMustNot.
  const attempted = run.calls.map((call, index) => ({
    ...call,
    input: withPage(
      call.tool,
      withOptionsObject(call.input),
      call.failed ? new Map() : written[index]!,
    ),
  }));
  const calls = attempted.filter((call) => !(call.failed && isPageTool(call.tool)));
  // `tool` may list alternatives, as in "link_pull_request|watch_pull_request"; counts add up.
  const count = (tool: string) =>
    calls.filter((call) => tool.split("|").includes(call.tool)).length;
  const found = (
    { tool, args = {}, argsAnyOf, success, succeeded }: McpToolUseCall,
    among = calls,
  ) =>
    among.some(
      (call) =>
        tool.split("|").includes(call.tool) &&
        (!(success || succeeded) || call.failed === false) &&
        matches(args, call.input) &&
        (argsAnyOf === undefined ||
          argsAnyOf.some((alternative) => matches(alternative, call.input))),
    );
  const label = ({ tool, args, succeeded, success }: McpToolUseCall) =>
    [tool, ...(args ? [valueText(args)] : []), ...(succeeded || success ? ["succeeded"] : [])].join(
      " ",
    );
  for (const call of expect.calls ?? []) add(`calls ${label(call)}`, found(call));
  if (expect.callsAnyOf !== undefined)
    add(
      `callsAnyOf ${expect.callsAnyOf.map(label).join(" or ")}`,
      expect.callsAnyOf.some((call) => found(call)),
    );
  if (expect.distinctCalls !== undefined) {
    const expected = expect.distinctCalls.map(({ tool, args }) => ({ tool, input: args ?? {} }));
    add(
      "distinctCalls",
      calls.every((call) => expected.filter((entry) => matches(entry, call)).length <= 1) &&
        matchesDistinct(
          expected,
          calls.map((request) => ({ request, brief: "" })),
        ),
    );
  }
  if (expect.anyOf !== undefined) {
    const passes = (alternative: (typeof expect.anyOf)[number]) =>
      gradeSample(alternative, run, { pasted, files }).every((check) => check.pass);
    add("anyOf", expect.anyOf.some(passes));
  }
  for (const call of expect.callsMustNot ?? [])
    add(`callsMustNot ${label(call)}`, !found(call, attempted));
  // A page check must not pass because the grader never saw the file a path call shows.
  const pageTools = [...(expect.calls ?? []), ...(expect.callsMustNot ?? [])].flatMap((call) =>
    call.args?.page === undefined ? [] : call.tool.split("|"),
  );
  for (const call of calls)
    if (
      pageTools.includes(call.tool) &&
      isRecord(call.input) &&
      call.input.path !== undefined &&
      call.input.page === undefined
    )
      add(`page known ${call.tool} ${valueText(call.input.path)}`, false);
  for (const tool of expect.notCalls ?? [])
    add(`notCalls ${tool}`, !attempted.some((call) => call.tool === tool));
  if (expect.order !== undefined) {
    const firsts = expect.order.map((tool) => calls.findIndex((call) => call.tool === tool));
    const inOrder = firsts.every((at, i) => at > (firsts[i - 1] ?? -1));
    add(`order ${expect.order.join(" > ")}`, inOrder);
  }
  for (const [t, n] of Object.entries(expect.minCalls ?? {}))
    add(`minCalls ${t} >= ${n}`, count(t) >= n);
  for (const [t, n] of Object.entries(expect.maxCalls ?? {}))
    add(`maxCalls ${t} <= ${n}`, count(t) <= n);
  if (expect.newThreads !== undefined) {
    const requests = newThreadRequests(calls);
    add(
      `newThreads ${valueText(expect.newThreads)}`,
      requests.length === expect.newThreads.length && matchesDistinct(expect.newThreads, requests),
    );
  }
  if (expect.endsTurnAfter !== undefined) {
    const lastStep = Math.max(-1, ...calls.map((call) => call.step));
    const last = calls.filter((call) => call.step === lastStep).map((call) => call.tool);
    const ended = run.stopReason === "end_turn" && last.includes(expect.endsTurnAfter);
    add(`endsTurnAfter ${expect.endsTurnAfter}`, ended);
  }
  // Shell checks also read, one by one, the scripts the agent wrote and a command ran: `node run.mjs
  // signup.mjs` after a Write of signup.mjs. A t3_command_run `command` is the background run the
  // shellMustNot checks steer to, so they read only the agent's own shell; shellMust reads both.
  const sources = scriptSources(calls);
  const commands = calls.flatMap((call, i) =>
    isRecord(call.input) && typeof call.input.command === "string"
      ? [{ tool: call.tool, texts: [call.input.command, ...(sources[i] ?? [])] }]
      : [],
  );
  const shell = commands.filter((c) => AGENT_SHELL_TOOLS.has(c.tool)).flatMap((c) => c.texts);
  const ran = commands.flatMap((c) => c.texts);
  const test = (pattern: string, value: string) => new RegExp(pattern).test(value);
  for (const p of expect.shellMustNot ?? [])
    add(`shellMustNot /${p}/`, !shell.some((c) => test(p, c)));
  // A positive check also reads argv lists as command lines: spawnSync('pnpm', ['exec', …]).
  for (const p of expect.shellMust ?? [])
    add(
      `shellMust /${p}/`,
      ran.some((c) => test(p, c) || test(p, argvForm(c))),
    );
  for (const p of expect.textMust ?? []) add(`textMust /${p}/`, test(p, run.text));
  for (const p of expect.textMustNot ?? []) add(`textMustNot /${p}/`, !test(p, run.text));
  for (const p of expect.finalTextMust ?? [])
    add(`finalTextMust /${p}/`, run.stopReason === "end_turn" && test(p, run.finalText ?? ""));
  const isLinked = (url: string) => (run.linked ?? []).some((at) => matches(url, at));
  for (const url of expect.linked ?? []) add(`linked ${url}`, isLinked(url));
  if (expect.linkedNumbers !== undefined) {
    const numbers = (run.linked ?? []).map((url) => Number(/(\d+)\/?$/.exec(url)?.[1]));
    const exact = valueText(numbers.toSorted((a, b) => a - b));
    add("linkedNumbers", exact === valueText(expect.linkedNumbers.toSorted((a, b) => a - b)));
  }
  if (expect.pendingRelease)
    checks.push(...gradePendingRelease(expect.pendingRelease, calls, files));
  checks.push(...gradeDevice(expect.device, run));
  checks.push(
    ...gradeFileLinks(
      expect.fileLinks,
      run.stopReason === "end_turn" ? run.finalText : undefined,
      run.cwd,
      Object.keys(isRecord(files) ? files : {}),
    ),
  );
  checks.push(...gradeSecret(expect.secret, run, pasted));
  return checks;
};

// Checks that can only go from pass to fail as a sample goes on.
const SETTLED =
  /^(?:(?:notCalls|callsMustNot|shellMustNot|maxCalls|textMustNot) |secret\.(?:chatAsk|askTools|values|fileUse|noCardDemand|afterDecline) )/;
/** True once the sample has failed for good, so the rest of it cannot change the result. */
export const failedEarly = (expect: McpToolUseCase["expect"], run: SampleRun, pasted = "") =>
  gradeSample(
    expect,
    // A page call T3 has not answered yet may still be refused, so it is graded once it settles.
    {
      ...run,
      calls: run.calls.filter((call) => !isPageTool(call.tool) || call.failed !== undefined),
    },
    { pasted },
  ).some((check) => !check.pass && SETTLED.test(check.check));

const requestBody = ({ base, tools }: Sample, effort: string, messages: unknown) => ({
  model: base.model,
  max_tokens: 16_000,
  thinking: { type: "adaptive", display: "summarized" },
  output_config: { effort },
  cache_control: { type: "ephemeral" },
  // Like Claude Code, cache the shared system prompt so every sample reuses it.
  system: base.system.map((block, i) =>
    i === base.system.length - 1 ? { ...block, cache_control: { type: "ephemeral" } } : block,
  ),
  tools,
  messages,
});

const codexRequest = (base: Base, input: ReadonlyArray<Block>) => ({
  model: base.model,
  stream: true,
  store: false,
  parallel_tool_calls: true,
  reasoning: base.codex?.reasoning,
  instructions: base.codex?.instructions,
  text: base.codex?.text,
  tool_choice: base.codex?.tool_choice,
  include: ["reasoning.encrypted_content"],
  input: [...(base.codex?.input ?? []), ...input],
});

/** The bridge only accepts serialized data. Model code never receives host objects/functions. */
export const executeCodex = async (
  code: string,
  catalog: ReadonlyArray<{ name: string; description: string }>,
  answer: (name: string, input: unknown) => Promise<unknown>,
  saved: Record<string, unknown> = {},
) => {
  const pending: Array<{ name: string; input: string; resolve: (value: string) => void }> = [];
  const bridge = Object.setPrototypeOf(
    (name: string, input: string, resolve: (value: string) => void) =>
      pending.push({ name, input, resolve }),
    null,
  );
  const context = NodeVM.createContext(
    { __bridge: bridge, __catalog: JSON.stringify(catalog), __storeJson: JSON.stringify(saved) },
    { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" },
  );
  const run = (source: string) => NodeVM.runInContext(source, context, { timeout: 250 });
  run(`((bridge, catalog) => {
    delete globalThis.__bridge; delete globalThis.__catalog;
    globalThis.ALL_TOOLS = catalog;
    globalThis.tools = Object.fromEntries(catalog.map(({name}) => [name, (input) => new Promise(resolve => bridge(name, JSON.stringify(input ?? {}), value => resolve(JSON.parse(value))))]));
    globalThis.__output = []; globalThis.__done = false;
    globalThis.text = globalThis.notify = value => __output.push(typeof value === 'string' ? value : JSON.stringify(value));
    globalThis.__stored = JSON.parse(__storeJson); delete globalThis.__storeJson;
    globalThis.store = (k,v) => __stored[k] = v; globalThis.load = k => __stored[k];
  })(__bridge, JSON.parse(__catalog));
  (async () => { ${code}\n })().then(() => { __done = true; }, e => { text(String(e)); __done = true; });`);
  // Unawaited calls still run, as they do in Codex, so they are answered and graded too.
  for (let count = 0; !context.__done || pending.length > 0; count++) {
    if (count === 128) throw new Error("Code cell exceeded 128 tool calls.");
    const job = pending.shift();
    if (!job) throw new Error("Code cell stalled without a tool call.");
    const result = await answer(job.name, JSON.parse(job.input));
    context.__resolve = job.resolve;
    context.__result = JSON.stringify(result ?? null);
    run("__resolve(__result); delete globalThis.__resolve; delete globalThis.__result;");
  }
  Object.assign(saved, JSON.parse(run("JSON.stringify(__stored)")));
  return valueText(context.__output.join("\n"));
};

const codexCatalog = (base: Base) => [
  ...base.t3.map((tool) => ({
    name: tool.name.replace("mcp__t3-code__", "mcp__t3_code__"),
    description: `${valueText(tool.description)}\nInput JSON schema: ${JSON.stringify(tool.input_schema)}`,
  })),
  ...[
    ...valueText(base.nativeTools.find((tool) => tool.name === "exec")?.description).matchAll(
      /### `([^`]+)`/g,
    ),
  ].map((match) => ({ name: match[1]!, description: match[1]! })),
];

const CodexResponse = Schema.Struct({
  output: Schema.Array(AnyBlock),
  usage: Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
    input_tokens_details: Schema.Struct({ cached_tokens: Schema.Number }),
  }),
});

const decodeCodexResponse = Schema.decodeUnknownEffect(CodexResponse);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const callCodex = Effect.fn("evaluateMcpToolUse.callCodex")(function* (
  config: Config,
  body: { input: ReadonlyArray<Block> },
) {
  const raw = yield* postModel(
    "",
    config.proxy?.publicApi ? publicResponsesRequest(body) : body,
    config.proxy,
    true,
  );
  const completed = raw
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line.slice(6).trim() !== "[DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    .find((event) => event.type === "response.completed");
  if (!completed)
    return yield* Effect.die(new Error("Responses stream ended without response.completed."));
  const response = yield* decodeCodexResponse(completed.response);
  return {
    raw: response.output,
    content: response.output.flatMap((item): Array<Block> => {
      if (item.type === "message" && Array.isArray(item.content))
        return item.content.map((part: Block) => text(valueText(part.text)));
      if (item.type === "function_call" || item.type === "custom_tool_call")
        return [
          {
            type: "tool_use",
            id: item.call_id,
            name: item.name,
            input:
              item.type === "custom_tool_call" ? item.input : JSON.parse(valueText(item.arguments)),
          },
        ];
      return [];
    }),
    stop_reason: response.output.some(
      (item) => item.type.endsWith("tool_call") || item.type === "function_call",
    )
      ? "tool_use"
      : "end_turn",
    usage: {
      ...response.usage,
      input_tokens: response.usage.input_tokens - response.usage.input_tokens_details.cached_tokens,
      cache_read_input_tokens: response.usage.input_tokens_details.cached_tokens,
    },
  };
});

// Concurrent runs share an organization's rate limits. Backing off for up to about 4 minutes
// lets a sample wait out a busy spell, with jitter so samples do not retry in step.
const RETRY = Schedule.min([Schedule.exponential("2 seconds"), Schedule.spaced("1 minute")]).pipe(
  Schedule.jittered,
);

const postModel = Effect.fn("evaluateMcpToolUse.postModel")(function* (
  apiKey: string,
  body: unknown,
  proxy?: Config["proxy"],
  responses = false,
) {
  const client = (yield* HttpClient.HttpClient).pipe(
    // Anthropic answers 529 when it is overloaded; retryTransient already retries 429 and 5xx.
    HttpClient.filterStatus((status) => status !== 529),
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      while: (error) =>
        error.reason._tag === "StatusCodeError" && error.reason.response.status === 529,
      schedule: RETRY,
      times: 8,
    }),
  );
  const response = yield* HttpClientRequest.post(
    `${proxy?.url ?? "https://api.anthropic.com/v1"}/${responses ? "responses" : "messages"}`,
  ).pipe(
    HttpClientRequest.setHeaders({
      ...(!responses
        ? {
            ...(apiKey ? { "x-api-key": apiKey } : {}),
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "advanced-tool-use-2025-11-20",
          }
        : {}),
      ...proxy?.headers,
    }),
    HttpClientRequest.bodyJson(body),
    Effect.flatMap(client.execute),
  );
  if (response.status !== 200) {
    const body = yield* response.text;
    return yield* Effect.die(new Error(`Model API ${response.status}: ${body}`));
  }
  return yield* response.text;
});
const callModel = (apiKey: string, body: unknown, proxy?: Config["proxy"]) =>
  postModel(apiKey, body, proxy).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ApiResponse))),
  );

/** A tool call as graded. Claude Code runs an `Agent` in the background unless told otherwise. */
const recordedCall = (step: number, use: typeof ToolUse.Type): Call => {
  const tool = normalizeToolName(use.name);
  const input = normalizeToolInput(use.name, use.input);
  const claudeAgent = tool === "Agent" && !use.name.endsWith("spawn_agent") && isRecord(input);
  return {
    step,
    tool,
    input: claudeAgent ? { run_in_background: true, ...input } : input,
    id: use.id,
  };
};

/** Records on a call what the agent saw, so graders can count failed attempts. */
const settle = (call: Call | undefined, result: Block) => {
  if (call !== undefined) {
    call.failed = result.is_error === true;
    call.output = valueText(result.content);
  }
  return result;
};

/** Calls that ran. Claude Code rejects a deferred tool that was not loaded, so it never runs. */
export const ranCalls = (
  { base, tools }: Sample,
  step: number,
  uses: ReadonlyArray<typeof ToolUse.Type>,
) =>
  uses
    .filter((use) => base.codex !== undefined || hasTool(tools, use.name))
    .map((use) => recordedCall(step, use));

/**
 * Runs one sample until the model ends its turn, uses up its steps, or fails a check that no
 * later step can undo. Tokens add up in `spent`, so a sample that errors still reports them.
 */
const runSample = Effect.fn("evaluateMcpToolUse.runSample")(function* (
  testCase: McpToolUseCase,
  config: Config,
  base: Base,
  spent: { readonly usage: Usage; readonly shellUsage: Usage },
) {
  const sample = { ...makeSample(testCase, base), shellUsage: spent.shellUsage };
  yield* withDevices(sample);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<HttpClient.HttpClient>());
  const messages = buildMessages(sample);
  const input = base.codex ? codexMessages(messages) : undefined;
  const transcript: Array<unknown> = [];
  const start = messages.length;
  const calls: Array<Call> = [];
  const said: Array<string> = [];
  const { usage } = spent;
  let stopReason = "max_steps";
  let finalText = "";
  // Codex's code-mode cells take more model calls, so a case's own budget grows for it too.
  const extra = isCodex(config.model) ? 4 : 0;
  const maxSteps = testCase.maxSteps === undefined ? config.maxSteps : testCase.maxSteps + extra;
  let modelCalls = 0;
  for (let step = 0; step < maxSteps; step++) {
    modelCalls++;
    const response = input
      ? yield* callCodex(config, codexRequest(base, input))
      : yield* callModel(config.apiKey, requestBody(sample, config.effort, messages));
    addUsage(usage, response.usage);
    if ("raw" in response) {
      input?.push(...response.raw);
      transcript.push(...response.raw);
    }
    messages.push({ role: "assistant", content: response.content });
    const texts = response.content.filter(isText).map((block) => block.text);
    said.push(...texts);
    const uses = response.content.filter(isToolUse);
    calls.push(...ranCalls(sample, step, uses));
    if (response.stop_reason !== "tool_use") {
      stopReason = response.stop_reason ?? "unknown";
      finalText = texts.join("\n\n");
      break;
    }
    if (
      failedEarly(
        testCase.expect,
        { calls, text: said.join("\n\n"), stopReason },
        pastedText(testCase),
      )
    ) {
      stopReason = "failed_early";
      break;
    }
    const results = yield* Effect.forEach(uses, (use) =>
      Effect.gen(function* () {
        const own = calls.find((call) => call.id === use.id);
        if (!input) {
          return settle(own, yield* answerToolCall(sample, config, use));
        }
        const answer = (name: string, args: unknown, record = true) => {
          const tool = normalizeToolName(name);
          const normalized = normalizeToolInput(name, args);
          // A code cell's calls are recorded here; a direct function call already was.
          let recorded = own;
          if (record) {
            recorded = { step, tool, input: normalized };
            calls.push(recorded);
          }
          const call = { ...use, name, input: normalized };
          return answerToolCall(sample, config, call).pipe(
            Effect.map((result) => settle(recorded, result)),
            Effect.map((result) => {
              const output = valueText(result.content);
              if (isT3Name(name))
                return {
                  content: [text(output)],
                  ...(!result.is_error
                    ? { structuredContent: Option.getOrElse(decodeJson(output), () => output) }
                    : { isError: true }),
                };
              return tool === "Bash"
                ? {
                    output,
                    exit_code: /^Exit code [1-9]/.test(output) ? 1 : 0,
                    wall_time_seconds: 0,
                  }
                : output;
            }),
            runPromise,
          );
        };
        return yield* Effect.tryPromise({
          try: async () => {
            const output =
              use.name === "exec"
                ? await executeCodex(
                    valueText(use.input),
                    codexCatalog(base),
                    answer,
                    sample.codeStore,
                  )
                : await answer(use.name, use.input, false);
            const item = {
              type: use.name === "exec" ? "custom_tool_call_output" : "function_call_output",
              call_id: use.id,
              output: valueText(output),
            };
            input.push(item);
            transcript.push(item);
            return toolResult(use.id, output);
          },
          catch: (cause) => new EvalToolCallError({ tool: use.name, cause }),
        });
      }),
    );
    // Claude Code adds this text after a ToolSearch that loaded tools.
    const loaded = results.some((result) => Array.isArray(result.content));
    messages.push({ role: "user", content: [...results, ...(loaded ? [text(TOOL_LOADED)] : [])] });
    if (
      failedEarly(
        testCase.expect,
        { calls, text: said.join("\n\n"), stopReason },
        pastedText(testCase),
      )
    ) {
      stopReason = "failed_early";
      break;
    }
  }
  // The transcript (model turns and tool results) shows what the agent saw when a case fails.
  return {
    calls,
    text: said.join("\n\n"),
    stopReason,
    finalText,
    modelCalls,
    cwd: base.environment.cwd,
    linked: [...sample.linked],
    ...(sample.devices ? { launchers: [...sample.devices.launchers] } : {}),
    usage,
    shellUsage: sample.shellUsage,
    transcript: input ? transcript : messages.slice(start),
  };
}, Effect.scoped);

/**
 * Model requests a sample made. Rows from before `modelCalls` was recorded count up to the last
 * step with tool calls, plus the final answer's request when the turn ended.
 */
export const modelRequests = (row: {
  readonly modelCalls?: number | undefined;
  readonly calls?: ReadonlyArray<{ readonly step: number }> | undefined;
  readonly stopReason?: string | undefined;
}) => {
  if (row.modelCalls !== undefined) return row.modelCalls;
  const calls = row.calls ?? [];
  if (calls.length === 0) return 1;
  return Math.max(...calls.map((call) => call.step)) + 1 + (row.stopReason === "end_turn" ? 1 : 0);
};

type ResultRow = Pick<McpToolUseCase, "id" | "kind" | "pattern"> & {
  readonly role: string;
  readonly pass: boolean;
  /** Set when the sample could not run to the end, even after retries. It is not graded. */
  readonly error?: string;
  readonly usage: Usage;
  readonly shellUsage: Usage;
};

/** The share of samples that passed. Samples that errored are left out: NaN if all did. */
const passRate = (
  rows: ReadonlyArray<{ readonly pass: boolean; readonly error?: string | undefined }>,
) => {
  const finished = rows.filter((row) => row.error === undefined);
  return finished.filter((row) => row.pass).length / finished.length;
};
const percent = (rate: number) => (Number.isNaN(rate) ? "-" : `${Math.round(rate * 100)}%`);
const groups = <A>(rows: ReadonlyArray<A>, key: (row: A) => string) =>
  [...Map.groupBy(rows, key)].toSorted(([left], [right]) => left.localeCompare(right));

const USAGE_KEYS = ["input", "output", "cacheWrite", "cacheRead"] as const;
/** Token totals and their cost in USD at one model's prices. Proxy runs have no price. */
const spend = (usages: ReadonlyArray<Usage>, model: ShellModel | undefined) => {
  const total = (key: keyof Usage) => usages.reduce((sum, usage) => sum + usage[key], 0);
  const price = (key: keyof Usage) => (model && isPricedModel(model) ? PRICES[model][key] : 0);
  const cost = USAGE_KEYS.reduce((sum, key) => sum + total(key) * price(key), 0) / 1e6;
  return { cost, tokens: USAGE_KEYS.map((key) => `${key} ${total(key)}`).join(", ") };
};

/** Markdown report. With a baseline, each case shows its earlier pass rate and the change. */
export const summarize = (
  rows: Array<ResultRow>,
  options: {
    readonly header: string;
    readonly shellModel: Model | PricedModel;
    readonly model: Model;
  },
  before?: Map<string, number>,
) => {
  const codex = isCodex(options.model);
  const agent = spend(
    rows.map((row) => row.usage),
    codex ? undefined : options.model,
  );
  const shell = spend(
    rows.map((row) => row.shellUsage),
    options.shellModel in PRICES ? (options.shellModel as PricedModel) : undefined,
  );
  const cost = agent.cost + shell.cost;
  const table = (title: string, key: (row: ResultRow) => string, compare = false) => [
    `## ${title}\n`,
    compare ? "| Group | Pass | Baseline | Delta |" : "| Group | Pass |",
    compare ? "| --- | --- | --- | --- |" : "| --- | --- |",
    ...groups(rows, key).map(([group, members]) => {
      const now = passRate(members);
      const was = before?.get(group);
      const errored = members.filter((row) => row.error !== undefined).length;
      const delta =
        was === undefined
          ? "new | |"
          : `${percent(was)} | ${Number.isNaN(now) ? "" : `${Math.round((now - was) * 100)} pts`} |`;
      const pass = `${percent(now)} of ${members.length - errored}${errored > 0 ? `, ${errored} errored` : ""}`;
      return `| ${group} | ${pass} |${compare ? ` ${delta}` : ""}`;
    }),
    "",
  ];
  const errors = groups(
    rows.filter((row) => row.error !== undefined),
    (row) => row.id,
  );
  const errorNote = `- Errored: ${errors.map(([id, failed]) => `${id} ×${failed.length}`).join(", ")}. These samples did not finish, even after retries, so pass rates leave them out; tokens they spent are counted.`;
  const nativeNote =
    "- native-subagent cases are approximate: the harness gives subagents their own system prompt, which this runner does not rebuild. T3's append is left out and its SubagentStart hook context added after the task.";
  const identityNote = `- The captured Claude Code identity line is replaced with "${NEUTRAL_IDENTITY}"`;
  const finished = rows.filter((row) => row.error === undefined).length;
  return [
    "# MCP tool-use eval\n",
    `- ${options.header}`,
    `- Pass: ${percent(passRate(rows))} of ${finished} samples.`,
    ...(errors.length > 0 ? [errorNote] : []),
    codex
      ? "- Cost: not estimated for OpenAI; usage follows the selected API key or Codex subscription."
      : `- Estimated cost $${cost.toFixed(2)}, $${(cost / rows.length).toFixed(3)} per sample.`,
    `- Agent tokens: ${agent.tokens}${codex ? "." : ` ($${agent.cost.toFixed(2)}).`}`,
    `- Shell simulator (${options.shellModel}) tokens: ${shell.tokens} ${codex ? "(cost not estimated)" : `(API-price estimate $${shell.cost.toFixed(2)})`}.`,
    ...(codex
      ? [
          "- Code-mode tools use case mocks and a simulated machine. Native subagent prompts and asynchronous notifications are approximate.",
        ]
      : [identityNote]),
    ...(rows.some((row) => row.role === "native-subagent") ? [nativeNote] : []),
    "",
    ...table("Cases", (row) => row.id, before !== undefined),
    ...table("By kind", (row) => row.kind),
    ...table("By pattern", (row) => row.pattern),
  ].join("\n");
};

const PositiveInt = Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThan(0));
const PositiveIntOrZero = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
const Flags = Schema.Struct({
  model: Schema.Literals(Object.keys(MODELS) as Array<Model>),
  provider: Schema.Literals(["openai", "anthropic"]),
  template: Schema.String,
  cases: Schema.optional(Schema.Array(Schema.String)),
  out: Schema.optional(Schema.String),
  baseline: Schema.optional(Schema.String),
  case: Schema.optional(Schema.Array(Schema.String)),
  samples: Schema.optional(PositiveInt),
  concurrency: PositiveInt,
  "max-steps": Schema.optional(PositiveInt),
  effort: Schema.optional(Schema.Literals(EFFORTS)),
  "shell-model": Schema.Literals([...Object.keys(PRICES), ...Object.keys(MODELS)] as Array<
    Model | PricedModel
  >),
  "user-instructions": Schema.Literals(["keep", "drop"]),
  arm: Schema.Literals(ARMS),
  "dry-run": Schema.Boolean,
  "stop-on-regression": Schema.Boolean,
  "regression-budget": Schema.optional(PositiveIntOrZero),
  context: Schema.Boolean,
});
const decodeFlags = Schema.decodeUnknownEffect(Flags);
const decodeCapture = Schema.decodeUnknownEffect(Schema.fromJsonString(Capture));
const decodeCodexCapture = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexCapture));
const decodeCase = Schema.decodeUnknownEffect(Schema.fromJsonString(McpToolUseCase));
const decodeBaselineRow = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      pass: Schema.Boolean,
      error: Schema.optional(Schema.String),
    }),
  ),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const string = { type: "string" } as const;

const main = Effect.gen(function* () {
  const { values } = parseCommandLine({
    options: {
      model: string,
      provider: string,
      proxy: { type: "boolean", default: false },
      template: string,
      cases: { ...string, multiple: true },
      out: string,
      baseline: string,
      case: { ...string, multiple: true },
      // Unset: 2 samples per case, and a 3rd when those 2 disagree.
      samples: string,
      // Samples in flight at once, across all cases.
      concurrency: { ...string, default: "8" },
      // Unset: 6 for Claude, 10 for Codex, whose code-mode cells take more steps.
      "max-steps": string,
      effort: string,
      "shell-model": string,
      // T3's text must work for every user, so the captured CLAUDE.md is dropped by default.
      "user-instructions": { ...string, default: "drop" },
      // `raw` runs without T3's PR, CI and issue tools, to compare against the CLIs.
      arm: { ...string, default: "tools" },
      "dry-run": { type: "boolean", default: false },
      "stop-on-regression": { type: "boolean", default: false },
      "regression-budget": string,
      // Prints the size of T3's text and tool schemas, then exits. Needs no template or key.
      context: { type: "boolean", default: false },
    },
  });
  const offline = values["dry-run"] || values.context;
  const requestedProvider =
    values.provider ??
    (values.model
      ? values.model.startsWith("gpt-")
        ? "openai"
        : "anthropic"
      : values.proxy
        ? "openai"
        : undefined);
  const decodeProvider = Schema.decodeUnknownEffect(Schema.Literals(["openai", "anthropic"]));
  const preferred = (yield* Config.String("CODESHIP_EVAL_PROVIDER").pipe(
    Config.withDefault(""),
  )).trim();
  const requested =
    requestedProvider === undefined ? undefined : yield* decodeProvider(requestedProvider);
  const preference = preferred ? yield* decodeProvider(preferred) : undefined;
  if (values.proxy && (requested ?? preference) === "anthropic")
    return yield* Effect.die(new Error("--proxy requires the OpenAI provider."));
  const apiKey = (yield* Config.String("ANTHROPIC_API_KEY").pipe(Config.withDefault(""))).trim();
  const openAiKey = (yield* Config.String("OPENAI_API_KEY").pipe(Config.withDefault(""))).trim();
  const connection =
    offline || (requested ?? preference) === "anthropic"
      ? undefined
      : values.proxy
        ? { ...proxyConfig(), publicApi: false }
        : openAiKey
          ? openAiConnection({ authMethod: "apikey", authToken: openAiKey })
          : yield* readCodexConnection().pipe(Effect.orElseSucceed(() => undefined));
  const provider = offline
    ? (requested ?? preference ?? "openai")
    : selectEvalProvider({
        available: [
          ...(connection ? ["openai" as const] : []),
          ...(apiKey ? ["anthropic" as const] : []),
        ],
        requested,
        preferred: preference,
      });
  const flags = yield* decodeFlags({
    template: "",
    ...values,
    provider,
    model: values.model ?? (provider === "openai" ? "gpt-6-luna" : "claude-sonnet-5-5"),
    effort:
      values.effort ?? (provider === "openai" && values.model === undefined ? "low" : undefined),
    "shell-model":
      values["shell-model"] ?? (provider === "openai" ? "gpt-6-luna" : "claude-haiku-5-5"),
  });
  if (
    (flags.model.startsWith("gpt-") ? "openai" : "anthropic") !== provider ||
    (flags["shell-model"].startsWith("gpt-") ? "openai" : "anthropic") !== provider
  ) {
    return yield* Effect.die(
      new Error("--model and --shell-model must belong to the selected --provider."),
    );
  }
  if (flags.context) {
    process.stdout.write(`${t3ContextReport(flags.model)}\n`);
    return;
  }
  if (flags["stop-on-regression"] && flags.baseline === undefined) {
    return yield* Effect.die(new Error("--stop-on-regression needs --baseline."));
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readNdjson = <A, E>(file: string, decode: (line: string) => Effect.Effect<A, E>) =>
    fs.readFileString(file).pipe(
      Effect.map((content) => content.split("\n").filter((line) => line.trim() !== "")),
      Effect.flatMap((lines) => Effect.forEach(lines, (line) => decode(line))),
    );
  const casesDir = path.join(import.meta.dirname, "cases");
  const caseFiles =
    flags.cases ??
    (yield* fs.readDirectory(casesDir))
      .filter((name) => name.endsWith(".ndjson"))
      .toSorted()
      .map((name) => path.join(casesDir, name));
  const cases = (yield* Effect.forEach(caseFiles, (file) => readNdjson(file, decodeCase))).flat();
  const wanted = flags.case?.flatMap((ids) => ids.split(","));
  const codex = isCodex(flags.model);
  const harness = codex ? "codex" : "claude";
  const selectedCases = cases.filter(
    ({ id, setup }) =>
      (wanted === undefined || wanted.includes(id)) &&
      (setup.harness === undefined || setup.harness === harness),
  );
  if (selectedCases.length === 0) return yield* Effect.die(new Error("No case matches --case."));
  // The raw arm has no PR or issue tools, so a case whose prior turns call one cannot be replayed.
  const replaysForgeTool = (testCase: McpToolUseCase) =>
    (testCase.setup.priorTurns ?? []).some((turn) =>
      (turn.toolCalls ?? []).some((call) => forgeToolNames.has(`${T3_PREFIX}${call.tool}`)),
    );
  const unreplayable =
    flags.arm === "raw" ? selectedCases.filter(replaysForgeTool).map(({ id }) => id) : [];
  if (unreplayable.length > 0) {
    yield* Effect.logWarning(
      `--arm raw skips ${unreplayable.length} cases whose prior turns call PR or issue tools: ${unreplayable.join(", ")}`,
    );
  }
  const armCases = selectedCases.filter(({ id }) => !unreplayable.includes(id));
  if (armCases.length === 0)
    return yield* Effect.die(new Error("No selected case can run with --arm raw."));
  const selected = yield* Effect.forEach(armCases, (testCase) =>
    Effect.gen(function* () {
      const priorTurns = yield* Effect.forEach(testCase.setup.priorTurns ?? [], (turn) =>
        Effect.gen(function* () {
          const toolCalls = yield* Effect.forEach(turn.toolCalls ?? [], (call) =>
            call.resultFile === undefined
              ? Effect.succeed(call)
              : fs
                  .readFileString(path.resolve(import.meta.dirname, "../..", call.resultFile))
                  .pipe(Effect.map((result) => ({ ...call, result }))),
          );
          return { ...turn, toolCalls };
        }),
      );
      const name = testCase.projectSkill;
      const promptSkills = [...(testCase.promptSkills ?? [])];
      if (name !== undefined) {
        const baseDirectory = `.agents/skills/${name}`;
        const skillPath = `${baseDirectory}/SKILL.md`;
        const instructions = yield* fs.readFileString(
          path.resolve(import.meta.dirname, "../..", skillPath),
        );
        promptSkills.push({ name, path: skillPath, baseDirectory, instructions });
      }
      return {
        ...testCase,
        promptSkills,
        expect: flags.arm === "raw" ? (testCase.expectRaw ?? testCase.expect) : testCase.expect,
        setup: {
          ...testCase.setup,
          priorTurns,
        },
      };
    }),
  );
  // Trimmed captures without user data ship beside the cases. `--template` also takes a raw
  // CLIProxyAPI capture.
  const templatePath =
    flags.template ||
    path.join(import.meta.dirname, "templates", codex ? "codex.json.gz" : "claude.json.gz");
  const templateBytes = yield* fs.readFile(templatePath);
  const template = new TextDecoder().decode(
    templatePath.endsWith(".gz") ? NodeZlib.gunzipSync(templateBytes) : templateBytes,
  );
  const keepUserInstructions = flags["user-instructions"] === "keep";
  const baseOptions = (setup: McpToolUseCase["setup"]) => ({
    role: codex && setup.role === "native-subagent" ? ("top" as const) : setup.role,
    deviceAccess: setup.world?.deviceAgentAccess !== false,
    browserAccess: setup.world?.browserAgentAccess !== false,
    links: setup.linkedEnvironments === true,
    windows: setup.platform === "win32",
    date: setup.date,
    forge: setup.forge !== false,
    agentFeedback: setup.world?.agentFeedback ?? "off",
  });
  const buildFor = ({
    role,
    deviceAccess,
    browserAccess,
    links,
    windows,
    date,
    forge,
    agentFeedback,
  }: ReturnType<typeof baseOptions>): Effect.Effect<Base, Schema.SchemaError> => {
    const platformTemplate = windows ? onWindows(template) : template;
    const request = date === undefined ? platformTemplate : onDate(platformTemplate, date);
    return codex
      ? decodeCodexCapture(request).pipe(
          Effect.map((capture) =>
            buildCodexBase(capture.request.provider_native, {
              model: flags.model,
              keepUserInstructions,
              effort: flags.effort,
              subagent: role === "delegated-child",
              links,
              forge,
              deviceAccess,
              browserAccess,
              agentFeedback,
              arm: flags.arm,
            }),
          ),
        )
      : decodeCapture(request).pipe(
          Effect.flatMap((capture) => {
            const built = buildBase(capture.request.provider_native, {
              model: flags.model,
              keepUserInstructions,
              subagent: role === "delegated-child",
              nativeSubagent: role === "native-subagent",
              links,
              forge,
              deviceAccess,
              browserAccess,
              agentFeedback,
              arm: flags.arm,
            });
            return role === "native-subagent"
              ? Effect.promise(() =>
                  t3SubagentContext(flags.model, deviceAccess, browserAccess),
                ).pipe(Effect.map((subagentContext): Base => ({ ...built, subagentContext })))
              : Effect.succeed(built);
          }),
        );
  };
  const defaults = baseOptions({ role: "top" });
  const base = yield* buildFor(defaults);
  const baseKey = (options: typeof defaults) => JSON.stringify(options);
  const bases = new Map<string, Base>([[baseKey(defaults), base]]);
  for (const { setup } of selected) {
    const options = baseOptions(setup);
    const key = baseKey(options);
    if (!bases.has(key)) bases.set(key, yield* buildFor(options));
  }
  const baseFor = ({ setup }: McpToolUseCase) => bases.get(baseKey(baseOptions(setup)))!;
  const effort = flags.effort ?? base.codex?.reasoning.effort ?? "high";
  if (flags["dry-run"]) {
    // One JSON line per case. Without --case this also checks that every case builds.
    for (const testCase of selected) {
      const sample = makeSample(testCase, baseFor(testCase));
      yield* Effect.scoped(withDevices(sample));
      const messages = buildMessages(sample);
      const body = sample.base.codex
        ? codexRequest(sample.base, codexMessages(messages))
        : requestBody(sample, effort, messages);
      process.stdout.write(`${yield* encodeJson(body)}\n`);
    }
    return;
  }
  const out = flags.out;
  if (out === undefined)
    return yield* Effect.die(new Error("Pass --out <directory> to save the eval results."));
  const config: Config = {
    apiKey,
    model: flags.model,
    ...(connection && provider === "openai" ? { proxy: connection } : {}),
    effort,
    maxSteps: flags["max-steps"] ?? (codex ? 10 : 6),
    shellModel: flags["shell-model"],
  };
  const previous =
    flags.baseline === undefined ? [] : yield* readNdjson(flags.baseline, decodeBaselineRow);
  const baseline = new Map(
    groups(previous, (row) => row.id)
      .map(([id, r]) => [id, passRate(r)] as const)
      .filter(([, rate]) => !Number.isNaN(rate)),
  );
  // Only a case that passed every baseline sample can stop a run; flaky ones are just reported.
  const passedBefore = (id: string) => baseline.get(id) === 1;
  // Before the paid runs, so a missing git cannot lose their results.
  const commit = yield* Effect.sync(() =>
    Option.getOrElse(
      Option.liftThrowable(() =>
        NodeChildProcess.execFileSync("git", ["describe", "--always", "--dirty"], {
          encoding: "utf8",
          maxBuffer: GIT_OUTPUT_MAX_BYTES,
        }).trim(),
      )(),
      () => "unknown",
    ),
  );
  const inFlight = yield* Semaphore.make(flags.concurrency);
  const runOne = (testCase: McpToolUseCase) => {
    const { id, kind, pattern } = testCase;
    const identity = {
      id,
      kind,
      pattern,
      role: testCase.setup.role,
      arm: flags.arm,
      shellModel: config.shellModel,
    };
    const usage = { usage: emptyUsage(), shellUsage: emptyUsage() };
    const privateValues = [config.apiKey, ...Object.values(config.proxy?.headers ?? {})]
      .flatMap((value) => [value, value.replace(/^Bearer /i, "")])
      .filter(Boolean);
    return runSample(testCase, config, baseFor(testCase), usage).pipe(
      inFlight.withPermits(1),
      Effect.matchCause({
        // Not graded: a sample that errors is left out of pass rates, with its tokens so far.
        onFailure: (cause) => ({
          ...identity,
          ...usage,
          pass: false,
          error: privateValues.reduce(
            (message, value) => message.replaceAll(value, "[redacted]"),
            Cause.pretty(cause),
          ),
        }),
        onSuccess: (sample) => {
          const checks = gradeSample(testCase.expect, sample, {
            pasted: pastedText(testCase),
            files: testCase.setup.world?.files,
          });
          const { secret } = testCase.expect;
          return {
            ...identity,
            pass: checks.every((check) => check.pass),
            checks,
            // Not graded: how the agent handled a secret it needed, for a person reading the run.
            ...(secret ? { secret: secretDiagnostics(sample, secret) } : {}),
            ...sample,
          };
        },
      }),
      Effect.tap((row) =>
        Effect.log(`${row.id}: ${"error" in row ? "ERROR" : row.pass ? "pass" : "FAIL"}`),
      ),
    );
  };
  // Without --samples, a case whose 2 samples disagree gets a 3rd to settle it.
  const runCase = Effect.fn("evaluateMcpToolUse.runCase")(function* (testCase: McpToolUseCase) {
    const samples = Array.from({ length: flags.samples ?? 2 }, () => testCase);
    const first = yield* Effect.forEach(samples, runOne, { concurrency: "unbounded" });
    const split = flags.samples === undefined && new Set(first.map((row) => row.pass)).size > 1;
    return split ? [...first, yield* runOne(testCase)] : first;
  });
  // --stop-on-regression runs cases that passed in the baseline first and stops once more than
  // --regression-budget of them fail, so a copy change that breaks passing cases fails fast.
  // A budget lets a quirky model miss a case or two without ending the run.
  const stopEarly = flags["stop-on-regression"];
  const budget = flags["regression-budget"] ?? 0;
  const ordered = stopEarly
    ? selected.toSorted((a, b) => Number(passedBefore(b.id)) - Number(passedBefore(a.id)))
    : selected;
  const rows: Array<Effect.Success<ReturnType<typeof runOne>>> = [];
  const regressions: Array<string> = [];
  yield* Effect.forEach(
    ordered,
    (testCase) =>
      runCase(testCase).pipe(
        Effect.flatMap((caseRows) => {
          rows.push(...caseRows);
          // A case whose samples all errored has no rate, so it is no regression either.
          if (!stopEarly || !passedBefore(testCase.id) || !(passRate(caseRows) <= 0.5)) {
            return Effect.void;
          }
          regressions.push(testCase.id);
          return regressions.length > budget ? Effect.fail(testCase.id) : Effect.void;
        }),
      ),
    { concurrency: flags.concurrency, discard: true },
  ).pipe(Effect.ignore);
  const samples = flags.samples === undefined ? "2-3 (adaptive)" : flags.samples;
  const login = connection?.login ? `, Codex login \`${connection.login}\`` : "";
  const header = `Commit \`${commit}\`, ${flags.model} at ${effort} effort${login}, user instructions ${flags["user-instructions"]}, arm ${flags.arm}, ${samples} samples per case, template \`${path.basename(templatePath)}\``;
  const finished = new Set(rows.map((row) => row.id)).size;
  const stopped =
    regressions.length === 0
      ? []
      : [
          `- Regressions (passed every baseline sample, now fail): ${regressions.map((id) => `\`${id}\``).join(", ")}.${regressions.length > budget ? ` Stopped with ${finished} of ${selected.length} cases finished.` : ""}`,
        ];
  const summary = summarize(
    rows,
    {
      header: [header, t3ContextReport(flags.model), ...stopped].join("\n"),
      shellModel: config.shellModel,
      model: config.model,
    },
    flags.baseline === undefined ? undefined : baseline,
  );
  yield* fs.makeDirectory(out, { recursive: true });
  const lines = yield* Effect.forEach(rows, (row) => encodeJson(row));
  yield* fs.writeFileString(path.join(out, "results.jsonl"), `${lines.join("\n")}\n`);
  yield* fs.writeFileString(path.join(out, "summary.md"), summary);
  yield* Effect.log(`Wrote ${rows.length} samples to ${out}.\n\n${summary}`);
});

if (import.meta.main) {
  main.pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer, FetchHttpClient.layer),
    ),
    NodeRuntime.runMain,
  );
}
