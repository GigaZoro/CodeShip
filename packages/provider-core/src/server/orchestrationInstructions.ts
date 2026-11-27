// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pure synchronous hashing derives pin keys inside adapter option builders.
import * as NodeCrypto from "node:crypto";

import {
  PROVIDER_DISPLAY_NAMES,
  REASONING_EFFORT_OPTION_IDS,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ProviderDriverKind,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import { supportsAutoCoordinator } from "@t3tools/shared/serverSettings";
import { CLAUDE_MODEL_FAMILIES } from "@t3tools/shared/usageLimits";

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
export const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## T3.CodeShip orchestration

Ordinary coding tasks need no T3 tools.

- Subagents: use your native tool when the child uses your provider, a model it offers, and no settings beyond yours, and it finishes in this turn (Claude \`Agent\` always with \`run_in_background:false\`; Codex \`spawn_agent\`, then wait). Use \`delegate_task\` for another provider's model, user-asked settings, a separate checkout (\`isolation:"worktree"\`), background work, or \`delegate_task\` by name. A native type running another provider's model counts too. Workflow only when asked.
- Call \`orchestrator_capabilities\` once per thread, before the first \`delegate_task\`. Again only after an error or a user-named provider change. Settings go in \`target.options\`. Provider or model unavailable: say so. Never switch unasked, or fall back to native tools, Workflow, or CLIs. Never make a child's checkout in the shell or in \`task\`. Another local repository: \`isolation:"worktree"\` plus its \`target.projectId\`.
- Every new delegate review or re-check is a new \`delegate_task\` (brief, findings, objections), never a \`t3_thread_send\`. Fix small review findings yourself; start no delegate for them. When told to proceed without a delegate, or to run fewer, \`task_cancel\` the extras. Start no replacement.
- Follow a running delegate's \`next\`. Do not poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup). Stop a delegate run you replace or no longer need with \`task_cancel\`, never \`t3_thread_interrupt\` on a \`childThreadId\`.
- If you are a subagent or child, do the work yourself. Start no subagents unless your task says to.`,
  `- \`t3_thread_launch\` and \`create_threads\` make new top-level threads, only when the user asks for a new thread. "Subagent", "delegate", and "parallel" never mean one. Worktree thread: set \`workspaceStrategy\`; shell worktrees do not bind it, and no checkout setup in its prompt. No \`workspaceStrategy\`: project root, not your worktree.
- Given a thread id, \`t3_thread_read\` it before you answer about it.
- Another machine: \`t3_environment_links\` lists linked ones. Pass its \`environmentId\` to a T3 tool to act there. Ids are then that machine's, so pass \`threadId\`.
- A machine the user names that is not linked ("delegate this to my vps"): call \`t3_environment_link\` with a \`hint\` from their words. Never ask for a pairing code in chat.
- In your reply, mention a thread by its \`link\`, verbatim. Never a plain title or bare id.
- A secret: call \`request_secret\` yourself. Pass its \`secretRef\` to a T3 tool, or use \`delivery: "file"\` for a shell command. Never ask in chat or invent one. When asked only to schedule, \`schedule_task\` without running its prompt.
- T3 tools may load late. Try the name once before you call it absent.`,
  `### Visuals and preview

- Answer data with a trend or comparison with a chart, and show any visual the user asks for here: pass its HTML to \`html_preview\`, then \`html_render\`. If the visual is a file, pass that file's HTML. A screenshot on disk or a text description does not show it. Never start a server for it. Tools a web page exposes give data only. Never use them to show results. Asked for an image to post, send, or use elsewhere: a \`.png\` file and its path, never \`html_render\`.
- Never use \`preview_*\` unasked to verify or show your own edit. Use them when the current request asks for browser work, including recording edits, or names a page or tab. Do not repeat preview calls from an earlier turn. Public pages: web fetch or search unless browser work was asked; then preview tools only, no web fetch. Close a tab you opened before you reply, unless the user asked for it or uses it.`,
  `### Background work you wait on

Run every test suite (unit or integration), build, install, push, deploy, long script or until-loop with \`t3_command_run\`, unless you know it ends within seconds. Your first call to such a command is a \`t3_command_run\` call, never a shell call. Do not run one in your own shell, in the foreground, with a short wait or in the background, even when the shell tool offers its own background mode; a suite's length is unknown until it has run, so do not start it in your shell to find out. It keeps running through a T3.CodeShip restart, and its end wakes you once with the exit code and the last output, so end your turn instead of waiting or polling. \`task_status\` and \`task_cancel\` take its \`taskId\`. Keep native background shells for work you leave running, such as dev servers and watchers.`,
];

// Bump when an instruction change must reach running threads (a security fix, say); it rebuilds every pin.
export const PINNED_INSTRUCTIONS_EPOCH = 1;

/** Stable key for the inputs that legitimately change a thread's pinned instructions. */
export function pinnedSystemInstructionsKey(
  inputs: Readonly<Record<string, string | boolean>>,
  epoch: number = PINNED_INSTRUCTIONS_EPOCH,
): string {
  const canonical = JSON.stringify([
    epoch,
    ...Object.keys(inputs)
      .toSorted()
      .map((name) => [name, inputs[name]]),
  ]);
  return NodeCrypto.createHash("sha256").update(canonical).digest("hex");
}

/** True when `next` must be stored as the thread's new pin. */
export function pinnedSystemInstructionsChanged(
  next: { readonly key: string; readonly text: string },
  stored: { readonly key: string; readonly text: string } | null | undefined,
): boolean {
  return next.key !== stored?.key || next.text !== stored.text;
}

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

// One per `supportsAutoCoordinator` driver: the native subagent tool and how it takes a model.
const AUTO_COORDINATOR_SUBAGENT_TOOLS: ReadonlyMap<string, string> = new Map([
  ["claudeAgent", "Claude `Agent` with `model`"],
  ["codex", "Codex `spawn_agent` with `model`, then wait"],
]);

const CODEX_SPAWN_EFFORT_PARAMETER = "reasoning_effort";
const MAX_AUTO_COORDINATOR_MODELS = 8;
// Other providers' models listed together, each provider at most MAX_AUTO_COORDINATOR_MODELS.
const MAX_OTHER_PROVIDER_MODELS = 16;
// Codex truncates an entry over 4,000 bytes; this leaves room for the `t3_auto_mode` tags around the brief.
const MAX_AUTO_BRIEF_BYTES = 3_900;
const AUTO_MODEL_HINTS = [
  ["opus", "hardest design, subtle bugs, reviews"],
  ["fable", "frontier: the hardest problems"],
  ["sonnet", "features, fixes and tests"],
  ["haiku", "fast and cheap: searches, mechanical edits, test runs"],
  ["astra", "frontier: the most demanding work"],
  ["sol", "coding and everyday work"],
  ["terra", "straightforward work"],
  ["luna", "fast and cheap: easier tasks"],
  ["neon", "frontier: the hardest problems"],
  ["hydrogen", "demanding reasoning and coding"],
  ["carbon", "coding and everyday work"],
  ["argon", "straightforward work"],
  ["flash", "fast and cheap: searches, mechanical edits, test runs"],
] as const;

const autoProviderName = (driver: ProviderDriverKind, fallback?: string) =>
  PROVIDER_DISPLAY_NAMES[driver] ?? fallback ?? driver;

function formatProviderChoice(names: ReadonlyArray<string>): string {
  if (names.length <= 2) return `either ${names.join(" or ")}`;
  return `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`;
}

interface AutoBriefModel {
  readonly slug: string;
  readonly name: string;
  readonly nativeModelFamily?: string | undefined;
  readonly aliases?: ReadonlyArray<string> | undefined;
  readonly capabilities?:
    | { readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor> | undefined }
    | null
    | undefined;
}

/** Codex delivers the brief as an additionalContext entry under this key and wraps it in the same tag. */
export const AUTO_MODE_CONTEXT_KEY = "t3_auto_mode";

/** The tagged form for providers whose brief rides on the prompt. */
export function autoModePromptBlock(brief: string): string {
  return `<${AUTO_MODE_CONTEXT_KEY}>\n${brief}\n</${AUTO_MODE_CONTEXT_KEY}>`;
}

/** A provider's Settings primary, else its Auto profile, on an account with room to run it as a `delegate_task` reviewer. */
interface AutoReviewer {
  readonly providerInstanceId: string;
  readonly model: string;
  readonly options?: ReadonlyArray<ProviderOptionSelection>;
}

/** The brief's body, without its `t3_auto_mode` tag. */
export function autoCoordinatorInstructions(input: {
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly primary: {
    readonly model: string;
    readonly options?: ReadonlyArray<ProviderOptionSelection>;
  } | null;
  /** Another provider's reviewer, absent while no other provider's account can run its primary. */
  readonly otherReviewer?: AutoReviewer;
  /** This provider's reviewer, which takes the independent review while no other provider can. */
  readonly ownReviewer?: AutoReviewer;
  readonly otherProviders?: ReadonlyArray<{
    readonly providerInstanceId: string;
    readonly displayName: string;
    readonly driver: ProviderDriverKind;
    readonly models: ReadonlyArray<AutoBriefModel>;
  }>;
  readonly models: ReadonlyArray<AutoBriefModel>;
}): string | null {
  const tool = AUTO_COORDINATOR_SUBAGENT_TOOLS.get(input.driver);
  if (input.primary === null || tool === undefined || !supportsAutoCoordinator(input.driver))
    return null;
  const nativeModel = (model: AutoBriefModel) =>
    input.driver === "claudeAgent"
      ? model.aliases?.find((alias) => CLAUDE_MODEL_FAMILIES.includes(alias))
      : model.slug;
  const modelHint = (model: AutoBriefModel) => {
    const tokens = new Set(
      `${model.slug} ${model.nativeModelFamily ?? ""}`
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    );
    return AUTO_MODEL_HINTS.find(([family]) => tokens.has(family))?.[1];
  };
  const effort = (model: AutoBriefModel) => {
    const descriptor =
      model.capabilities?.optionDescriptors?.find(
        (option) => option.type === "select" && option.role === "reasoning",
      ) ??
      model.capabilities?.optionDescriptors?.find(
        (option) => option.type === "select" && REASONING_EFFORT_OPTION_IDS.includes(option.id),
      );
    return descriptor?.type === "select"
      ? { id: descriptor.id, values: descriptor.options.map((option) => option.id).join(", ") }
      : null;
  };
  const effortKey = (model: AutoBriefModel) => {
    const value = effort(model);
    return value === null ? "" : `${value.id}: ${value.values}`;
  };
  // Claude's `Agent` takes only a model; Codex's `spawn_agent` also takes `reasoning_effort`, stated once on its provider line.
  const describeModels = (models: ReadonlyArray<AutoBriefModel>, native: boolean) => {
    const counts = new Map<string, number>();
    for (const model of models) {
      counts.set(effortKey(model), (counts.get(effortKey(model)) ?? 0) + 1);
    }
    const commonKey = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    const common = models
      .map(effort)
      .find((value, index) => effortKey(models[index]!) === commonKey);
    const lines = models.map((model) => {
      const hint = modelHint(model);
      const own = effort(model);
      const differs = !(native && input.driver === "claudeAgent") && effortKey(model) !== commonKey;
      const effortNote = !differs
        ? ""
        : own === null
          ? "; no effort option"
          : own.id === common?.id
            ? `; effort: ${own.values}`
            : `; \`${own.id}\`: ${own.values}`;
      return `  - ${model.name} (\`${native ? nativeModel(model) : model.slug}\`)${hint ? `: ${hint}` : ""}${effortNote}`;
    });
    return { common: common ?? null, lines: lines.join("\n") };
  };
  const nativeModels = input.models.filter((model) => nativeModel(model) !== undefined);
  const own = describeModels(nativeModels.slice(0, MAX_AUTO_COORDINATOR_MODELS), true);
  const nativeEffort =
    input.driver === "codex" && own.common !== null
      ? `, \`${CODEX_SPAWN_EFFORT_PARAMETER}\` ${own.common.values}`
      : "";
  const sections = [
    `- ${autoProviderName(input.driver)} native subagents (${tool})${nativeEffort}:\n${own.lines}`,
  ];
  const otherProviders = input.otherProviders ?? [];
  // Each provider's distinct models, in its fullest account's catalog order, so a model only a later
  // account has room for (Claude on an Antigravity account whose first sibling is out of that quota)
  // still ranks where the catalog puts it.
  const byDriver = new Map<
    ProviderDriverKind,
    { readonly accounts: typeof otherProviders; readonly slugs: string[] }
  >();
  for (const driver of new Set(otherProviders.map((provider) => provider.driver))) {
    const accounts = otherProviders.filter((provider) => provider.driver === driver);
    const catalog = accounts.reduce((fullest, account) =>
      account.models.length > fullest.models.length ? account : fullest,
    ).models;
    const slugs = [
      ...new Set([...catalog, ...accounts.flatMap((account) => account.models)].map((m) => m.slug)),
    ];
    byDriver.set(driver, { accounts, slugs });
  }
  // Water-filling: the smallest providers take their models first and hand any unused share to the
  // rest, so the shared budget fills before any provider is cut. Reversed first, so on a tie the
  // paired provider, listed first, goes last and takes the remainder.
  const limits = new Map<ProviderDriverKind, number>();
  let budget = MAX_OTHER_PROVIDER_MODELS;
  [...byDriver]
    .reverse()
    .sort(([, left], [, right]) => left.slugs.length - right.slugs.length)
    .forEach(([driver, { slugs }], index, ordered) => {
      const limit = Math.min(
        MAX_AUTO_COORDINATOR_MODELS,
        slugs.length,
        Math.floor(budget / (ordered.length - index)),
      );
      limits.set(driver, limit);
      budget -= limit;
    });
  let omitted = nativeModels.length > MAX_AUTO_COORDINATOR_MODELS;
  const otherSections: Array<{ readonly driver: ProviderDriverKind; readonly text: string }> = [];
  for (const [driver, { accounts, slugs }] of byDriver) {
    const chosen = new Set(slugs.slice(0, limits.get(driver)));
    omitted ||= slugs.length > chosen.size;
    // Each chosen model is listed once, on the first account in failover order with room for it.
    const placed = new Set<string>();
    for (const provider of accounts) {
      const models = provider.models.filter(
        (model) => chosen.has(model.slug) && !placed.has(model.slug),
      );
      if (models.length === 0) continue;
      for (const model of models) placed.add(model.slug);
      const group = describeModels(models, false);
      const target = JSON.stringify({
        providerInstanceId: provider.providerInstanceId,
        model: "<slug>",
        ...(group.common === null ? {} : { options: { [group.common.id]: "<effort>" } }),
      });
      otherSections.push({
        driver,
        text: `- ${autoProviderName(driver, provider.displayName)} via \`delegate_task\`, target \`${target}\`${group.common === null ? "" : `, effort ${group.common.values}`}:\n${group.lines}`,
      });
    }
  }
  const ownPrimary = input.models.find((model) => model.slug === input.primary!.model);
  const primary = `${ownPrimary?.name ?? input.primary.model}${(input.primary.options ?? []).map(({ id, value }) => `, ${id} ${value}`).join("")}`;
  // Both providers review while both can run; with one, the independent review stays on that one.
  const target = (reviewer: AutoReviewer) =>
    `\`${JSON.stringify({ model: reviewer.model, options: Object.fromEntries((reviewer.options ?? []).map(({ id, value }) => [id, value])), providerInstanceId: reviewer.providerInstanceId })}\``;
  const alone = "your own review is the only one: say so in your report.";
  const otherFallback =
    input.ownReviewer === undefined
      ? alone
      : `take the review from your own provider's Settings primary instead, target ${target(input.ownReviewer)}; if neither can run, ${alone}`;
  const review =
    input.otherReviewer !== undefined
      ? ` Also obtain an independent review from another provider: \`delegate_task\` role "review", target ${target(input.otherReviewer)}. Preserve its model and options. If it cannot run, ${otherFallback}`
      : input.ownReviewer !== undefined
        ? ` No other provider can review now, so take the independent review from your own provider's Settings primary: \`delegate_task\` role "review", target ${target(input.ownReviewer)}. Preserve its model and options. If it cannot run, ${alone}`
        : ` No account can run an independent reviewer now, so ${alone}`;
  const render = (kept: typeof otherSections, cut: boolean) => {
    const listedDrivers = new Set([input.driver, ...kept.map(({ driver }) => driver)]);
    const choiceNames =
      listedDrivers.size <= 1
        ? ["Claude", "Codex"]
        : [...listedDrivers].map((driver) => autoProviderName(driver));
    return `Auto: coordinate as ${input.models.find((model) => model.slug === input.model)?.name ?? input.model}. Do tiny requests yourself; otherwise choose the best model for each task from ${formatProviderChoice(choiceNames)}. Use the cheapest capable model and match effort to complexity (\`low\` for searches, mechanical edits, checks; \`medium\` for ordinary features, fixes, tests; \`high\` only for subtle bugs, architecture, reviews). Keep judgment, subtle bugs and review. Brief workers with goal, files, constraints and checks.
${[...sections, ...kept.map(({ text }) => text)].join("\n")}
- For non-trivial code changes, review the diff yourself on your Settings primary, ${primary}.${review} Skip independent review only for trivial, low-risk edits (typos, docs, comments; never auth, data, money, or concurrency changes).
- Read results and diffs, run relevant checks, fix small issues yourself; take over or reassign bigger ones.${cut ? "\n- More accounts and models: call `orchestrator_capabilities`." : ""}`;
  };
  // The review instructions close the brief, so trailing roster sections go first when it would
  // pass Codex's 4,000-byte entry limit. Every coordinator gets the same cap, so one brief fits all.
  let kept = otherSections;
  let brief = render(kept, omitted);
  while (new TextEncoder().encode(brief).length > MAX_AUTO_BRIEF_BYTES && kept.length > 0) {
    kept = kept.slice(0, -1);
    brief = render(kept, true);
  }
  return brief;
}

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3.CodeShip browser

When browser work was asked, \`preview_*\` is the browser you share with the user: \`preview_status\` first, then \`preview_open\` if no tab can be automated. Prefer snapshot locators over coordinates. Switch browsers only if the tools are absent or \`preview_open\` says unsupported, the user asks, or two preview calls fail on one step. Then quote the error and switch.
`;

const T3_CODE_DEVICE_TOOLS = ["device_list", "device_open", "device_screenshot", "device_close"];

const deviceToolInstructions = (loadTools: string) => `## T3.CodeShip devices

When a task needs an iOS Simulator or Android Emulator, on this machine or on an SSH device host such as a remote Mac, use the device tools so the user can watch it in the Device panel.${loadTools}
1. Call \`device_list\` unless you already have the device's \`hostId\` and \`id\`.
2. Call \`device_open\` with them as \`hostId\` and \`deviceId\`. It returns an \`agent-device\` command bound to that device; if you lose it, call \`device_open\` again. Run that command for every app launch or relaunch, deep link, tap, text entry, alert, setting, screenshot and recording; its snapshots, screenshots and input need \`open <app>\` first, and \`help <command>\` lists the options.
3. Call \`device_screenshot\` to look at the screen.

Never do those with \`xcrun simctl\`, \`idb\`, \`adb\`, ssh, or scripts that wrap them. ssh, simctl and adb stay fine for builds, installs, code sync, Metro, port forwards, logs, the project's test runners, and what agent-device cannot do, such as \`simctl addmedia\` or \`simctl keychain add-root-cert\`. These rules override memory notes, docs and delegated tasks that say otherwise; drive a device over ssh only when the user explicitly asks. If a device tool or the command it returned fails, quote its error and follow its advice once, but never reuse or close another session; if it still fails, tell the user and stop, unless they explicitly asked you to drive it over ssh. If the platform you need is unavailable, say so. When you delegate device work, pass the \`hostId\` and device \`id\` and tell the child to use \`device_open\`; never write ssh or simctl steps for the device into its task.`;

/** Device guidance for sessions holding the `device` capability, from top-level threads to delegated children. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = deviceToolInstructions("");

/** Claude Code defers MCP tools behind ToolSearch, so Claude's copy says how to load them. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH = deviceToolInstructions(
  ` Load them with ToolSearch \`select:${T3_CODE_DEVICE_TOOLS.map((tool) => `mcp__t3-code__${tool}`).join(",")}\`.`,
);

// ACP only: some ACP agents accept the injected MCP server but never expose
// its tools, so they need the terminal transport other harnesses never use.
const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`.`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3.CodeShip interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3.CodeShip supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3.CodeShip interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3.CodeShip supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
}

/** ACP lacks system/developer fields; inject context on first prompt and tool/mode changes. */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp &&
    input.previousState.hasDeviceTools === input.state.hasDeviceTools
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [
          T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
          ...(input.state.hasDeviceTools ? [T3_CODE_DEVICE_TOOL_INSTRUCTIONS] : []),
          T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
          T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
        ]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

const orchestrationInstructions = (hasDeviceTools: boolean) =>
  hasDeviceTools
    ? `${T3_CODE_ORCHESTRATION_INSTRUCTIONS}\n${T3_CODE_DEVICE_TOOL_INSTRUCTIONS}\n`
    : T3_CODE_ORCHESTRATION_INSTRUCTIONS;

function prependT3OrchestrationInstructions(prompt: string, instructions: string): string {
  return `<t3_code_orchestration_instructions>${instructions.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

/** For providers whose instructions ride on the prompt, so a compacted conversation loses them. */
export function t3OrchestrationPrompt(input: {
  readonly prompt: string;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
  readonly orchestrationDelivered: boolean;
  readonly deviceInstructionsDelivered: boolean;
}): string {
  if (!input.hasT3Mcp) return input.prompt;
  if (!input.orchestrationDelivered) {
    return prependT3OrchestrationInstructions(
      input.prompt,
      orchestrationInstructions(input.hasDeviceTools),
    );
  }
  return input.hasDeviceTools && !input.deviceInstructionsDelivered
    ? prependT3OrchestrationInstructions(input.prompt, T3_CODE_DEVICE_TOOL_INSTRUCTIONS)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  hasDeviceTools: boolean,
): string | undefined {
  return hasT3Mcp ? orchestrationInstructions(hasDeviceTools) : undefined;
}
