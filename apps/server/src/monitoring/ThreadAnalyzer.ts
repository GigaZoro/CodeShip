import type {
  MonitoringCommandGroup,
  MonitoringCommandPhase,
  MonitoringCommandRecord,
  MonitoringFinding,
  MonitoringFindingSeverity,
  MonitoringLane,
  MonitoringLaneKind,
  MonitoringMarker,
  MonitoringPhaseStats,
  MonitoringPromptSource,
  MonitoringRunStep,
  MonitoringSegmentStatus,
  MonitoringThreadDetail,
  MonitoringThreadKind,
  MonitoringThreadSummary,
  MonitoringTimeBuckets,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/** Bump when the analysis changes, so stored analyses are made again. */
export const ANALYZER_VERSION = 4;

export interface AnalysisThread {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly model: string | null;
  readonly createdAt: string;
  readonly settledAt: string;
  readonly createdBy: string | null;
  /** Another environment delegated the chat here. */
  readonly delegated: boolean;
}

export interface AnalysisRun {
  readonly runId: RunId;
  readonly ordinal: number;
  readonly status: string;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly userMessageId: string;
  readonly model: string | null;
  readonly automaticContinuation: boolean;
  readonly restartContinuation: boolean;
}

export interface AnalysisAttempt {
  readonly runId: string;
  readonly reason: string;
  readonly startedAt: string | null;
}

export interface AnalysisMessage {
  readonly messageId: string;
  readonly createdBy: string | null;
  readonly scheduled: boolean;
  /** Sent by an agent in another chat. */
  readonly fromThread: boolean;
  /** The tasks whose end woke the chat, for the app's wake after its helpers finished. */
  readonly delegatedTaskIds: ReadonlyArray<string> | null;
  /** The start of the text; the reader shortens it. */
  readonly text: string;
}

export interface AnalysisTurnUsage {
  readonly usageStatus: string;
  readonly inputTokens?: number | undefined;
  readonly cachedInputTokens?: number | undefined;
  readonly cacheCreationTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly reasoningTokens?: number | undefined;
  readonly models?: ReadonlyArray<string> | undefined;
  readonly localCommand?: boolean | undefined;
}

export interface AnalysisTurn {
  readonly runId: string | null;
  readonly usage: AnalysisTurnUsage | null;
  readonly contextUsedTokens: number | null;
  readonly contextMaxTokens: number | null;
  /** From Usage's prices; null when the turn has no counts or its model has no price. */
  readonly costUsd: number | null;
}

/** A turn item; only the fields of its type are set. */
export interface AnalysisItem {
  readonly runId: string | null;
  readonly type: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
  readonly command: string | null;
  readonly exitCode: number | null;
  readonly outputIndicatesFailure: boolean;
  readonly monitor: boolean;
  readonly failureClass: string | null;
  readonly fileName: string | null;
  readonly toModel: string | null;
}

export interface AnalysisRequest {
  readonly kind: string;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface AnalysisWorkflowAgent {
  readonly label: string;
  readonly model: string | null;
  readonly state: string;
  /** Epoch milliseconds, as the workflow reports them. */
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly totalTokens: number | null;
}

export interface AnalysisSubagent {
  readonly id: string;
  readonly origin: string;
  readonly childThreadId: ThreadId | null;
  readonly remote: boolean;
  readonly command: string | null;
  readonly title: string | null;
  readonly prompt: string;
  readonly model: string | null;
  readonly status: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
  readonly workflow: {
    readonly totalTokens: number | null;
    readonly agents: ReadonlyArray<AnalysisWorkflowAgent>;
  } | null;
}

export interface ThreadAnalysisInput {
  readonly thread: AnalysisThread;
  readonly runs: ReadonlyArray<AnalysisRun>;
  readonly attempts: ReadonlyArray<AnalysisAttempt>;
  readonly messages: ReadonlyArray<AnalysisMessage>;
  readonly turns: ReadonlyArray<AnalysisTurn>;
  readonly items: ReadonlyArray<AnalysisItem>;
  readonly requests: ReadonlyArray<AnalysisRequest>;
  readonly subagents: ReadonlyArray<AnalysisSubagent>;
  /** Times the chat was reopened after its first settle. */
  readonly reopens: number;
}

export const MINUTE_MS = 60_000;
const PROMPT_EXCERPT_LENGTH = 160;
const COMMAND_EXCERPT_LENGTH = 200;
const LANE_LABEL_LENGTH = 80;
const MAX_HELPER_LANES = 300;
const MAX_LANE_SEGMENTS = 400;
const MAX_MARKERS = 500;
const MAX_STEPS = 500;
const MAX_COMMAND_RECORDS = 15;
export const SLOW_COMMAND_MS = 10 * MINUTE_MS;
export const REPEATED_COMMAND_MIN_COUNT = 4;
export const FAILING_COMMANDS_MIN_COUNT = 3;
export const LONG_QUEUE_MS = 2 * MINUTE_MS;
export const APPROVAL_WAIT_MS = 2 * MINUTE_MS;
export const DELEGATE_WAIT_MS = 10 * MINUTE_MS;
export const LOW_CACHE_REUSE_RATIO = 0.7;
export const LOW_CACHE_REUSE_MIN_INPUT = 500_000;
export const CONTEXT_PRESSURE_RATIO = 0.9;
export const MANY_PROMPTS = 6;
/** Requests the app answers by itself; only the rest wait on a person. */
const NON_PERSON_REQUEST_KINDS: ReadonlySet<string> = new Set([
  "dynamic_tool_call",
  "auth_refresh",
]);
const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set(["dynamic_tool", "file_search", "web_search"]);
/** Commands whose repeats and failures are routine: reading files, searching, git status. */
const ROUTINE_PHASES: ReadonlySet<MonitoringCommandPhase> = new Set(["inspect", "git"]);

// Commands arrive capped in length, so a wrapper, quote or heredoc may run to the end of the text.
const WRAPPER_PATTERN = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*?)(?:\1\s*)?$/;
const SHELL_WORD_PART = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"';&|])`;
const ASSIGNMENT = String.raw`[A-Za-z_]\w*=${SHELL_WORD_PART}*`;
const LEADING_CD_PATTERN = new RegExp(String.raw`^cd\s+${SHELL_WORD_PART}+\s*(?:&&|;|\n)\s*`);
const LEADING_ASSIGNMENTS_PATTERN = new RegExp(
  String.raw`^(?:export\s+)?${ASSIGNMENT}(?:[ \t]+${ASSIGNMENT})*[ \t]*(?:&&|;|\n)\s*`,
);
const LEADING_ENV_PATTERN = new RegExp(String.raw`^(?:${ASSIGNMENT}[ \t]+)+`);
const ABSOLUTE_PATH_WORD_PATTERN =
  /(?<=^|\s)(?:"(\/[^"]*)"|'(\/[^']*)'|(\/[^\s"';&|]+))(?=[\s;&|]|$)/g;

function unwrapShell(command: string): string {
  const text = command.trim();
  const wrapped = WRAPPER_PATTERN.exec(text);
  if (wrapped === null) return text;
  const body = (wrapped[2] ?? "").trim();
  // The wrapper's quoting escapes the quotes of the command inside it.
  return wrapped[1] === '"' ? body.replace(/\\(["\\$`])/g, "$1") : body.replace(/'\\''/g, "'");
}

function fileName(match: string, ...paths: ReadonlyArray<string | undefined>): string {
  const path = paths.find((candidate) => candidate !== undefined) ?? match;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "") return match;
  return /\s/.test(name) ? `"${name}"` : name;
}

/**
 * The command line a person recognizes: no shell wrapper, no leading `cd` or variable
 * assignments, and absolute paths by their file name.
 */
export function normalizeCommand(command: string): string {
  let text = unwrapShell(command);
  for (;;) {
    const next = text
      .replace(LEADING_CD_PATTERN, "")
      .replace(LEADING_ASSIGNMENTS_PATTERN, "")
      .replace(LEADING_ENV_PATTERN, "")
      .trim();
    if (next === text) break;
    text = next;
  }
  return text
    .replace(ABSOLUTE_PATH_WORD_PATTERN, (match, double, single, bare) =>
      fileName(match, double, single, bare),
    )
    .replace(/\s+/g, " ");
}

/** When the segments of one line disagree, the phase listed first wins. */
const PHASE_PRECEDENCE: ReadonlyArray<MonitoringCommandPhase> = [
  "ship",
  "test",
  "build",
  "typecheck",
  "lint",
  "format",
  "install",
  "git",
  "run",
  "inspect",
  "other",
];

const SEGMENT_SEPARATOR = /&&|\|\||[;|\n]/;
const LINE_CONTINUATION = /\\\n/g;
/** A heredoc's body is data, not commands; the rest of its opening line stays. */
const HEREDOC_PATTERN =
  /<<-?\s*(['"]?)([A-Za-z_]\w*)\1([^\n]*)\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;
const QUOTED_PATTERN = /"(?:[^"\\]|\\.)*(?:"|$)|'[^']*(?:'|$)/g;
const QUOTED_PATH_PATTERN = /^(["'])\/(?:[^"']*\/)?([\w.+-]+)\1$/;
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const LANDING_SCRIPT_PATTERN = /landing-(?:turn|lease)/;
const WRAPPER_TOOLS: ReadonlySet<string> = new Set([
  "env",
  "time",
  "sudo",
  "nohup",
  "command",
  "npx",
  "bunx",
  "vpx",
]);
const NEUTRAL_TOOLS: ReadonlySet<string> = new Set([
  "cd",
  "export",
  "echo",
  "printf",
  "true",
  "set",
]);
const INSPECT_TOOLS: ReadonlySet<string> = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "sed",
  "grep",
  "rg",
  "find",
  "fd",
  "wc",
  "tree",
  "jq",
  "awk",
  "less",
  "file",
  "diff",
  "nl",
  "stat",
  "pwd",
  "which",
  "du",
  "df",
  "ps",
  "lsof",
  "sqlite3",
  "sort",
  "uniq",
  "xxd",
  "date",
  "test",
  "sleep",
]);
const SCRIPT_RUNNERS: ReadonlySet<string> = new Set([
  "node",
  "python",
  "python3",
  "bash",
  "sh",
  "zsh",
  "deno",
  "tsx",
]);
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun", "vp", "vpr"]);
const INSTALL_SUBCOMMANDS: ReadonlySet<string> = new Set(["install", "i", "add", "ci"]);
const TOOL_SUBCOMMAND_PHASES: Readonly<Record<string, MonitoringCommandPhase>> = {
  test: "test",
  build: "build",
  publish: "build",
  restore: "install",
  clippy: "lint",
  fmt: "format",
  format: "format",
  run: "run",
};

function scriptPhase(script: string): MonitoringCommandPhase {
  switch (script.split(":")[0]) {
    case "build":
      return "build";
    case "test":
    case "check":
      return "test";
    case "lint":
      return "lint";
    case "typecheck":
    case "type-check":
    case "tsc":
      return "typecheck";
    case "fmt":
    case "format":
      return "format";
    default:
      return "run";
  }
}

const firstOperand = (words: ReadonlyArray<string>) => words.find((word) => !word.startsWith("-"));

/** Git's global options that take the next word as their value, as in `git -C repo push`. */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
]);

function gitSubcommand(args: ReadonlyArray<string>): string | undefined {
  let skipValue = false;
  for (const arg of args) {
    if (skipValue) skipValue = false;
    else if (GIT_VALUE_OPTIONS.has(arg)) skipValue = true;
    else if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}
const operandsAfter = (words: ReadonlyArray<string>, operand: string | undefined) =>
  operand === undefined ? [] : words.slice(words.indexOf(operand) + 1);

function packageManagerPhase(tool: string, args: ReadonlyArray<string>): MonitoringCommandPhase {
  const subcommand = firstOperand(args);
  const rest = operandsAfter(args, subcommand);
  if (tool === "vpr") return scriptPhase(subcommand ?? "");
  if (subcommand === undefined) return tool === "yarn" ? "install" : "other";
  if (INSTALL_SUBCOMMANDS.has(subcommand)) return "install";
  switch (subcommand) {
    case "run":
    case "run-script":
      return scriptPhase(firstOperand(rest) ?? "");
    case "exec":
    case "dlx":
    case "x":
      return segmentPhase(rest) ?? "other";
    default:
      if (tool !== "npm") return scriptPhase(subcommand);
      if (subcommand === "test" || subcommand === "t") return "test";
      return subcommand === "start" ? "run" : "other";
  }
}

/** The phase of one command of a line; null for the ones that only set up or print. */
function segmentPhase(words: ReadonlyArray<string>): MonitoringCommandPhase | null {
  let rest = words;
  let afterWrapper = false;
  for (;;) {
    const [head, ...tail] = rest;
    if (head === undefined) return null;
    const wrapper = WRAPPER_TOOLS.has(head);
    if (ASSIGNMENT_PATTERN.test(head) || wrapper || (afterWrapper && head.startsWith("-"))) {
      afterWrapper = wrapper || afterWrapper;
      rest = tail;
      continue;
    }
    const tool = head.slice(head.lastIndexOf("/") + 1);
    if (NEUTRAL_TOOLS.has(tool)) return null;
    return toolPhase(tool, tail);
  }
}

function toolPhase(tool: string, args: ReadonlyArray<string>): MonitoringCommandPhase {
  const subcommand = firstOperand(args);
  if (PACKAGE_MANAGERS.has(tool)) return packageManagerPhase(tool, args);
  if (INSPECT_TOOLS.has(tool)) return "inspect";
  if (SCRIPT_RUNNERS.has(tool)) {
    return LANDING_SCRIPT_PATTERN.test(subcommand ?? "") ? "ship" : "run";
  }
  switch (tool) {
    case "git":
      return gitSubcommand(args) === "push" ? "ship" : "git";
    case "gh":
      return subcommand === "pr" && ["merge", "create"].includes(args[1] ?? "") ? "ship" : "git";
    case "az":
      return args.join(" ").startsWith("repos pr create") ? "ship" : "other";
    case "tsc":
    case "tsc-rs":
    case "mypy":
    case "pyright":
      return "typecheck";
    case "vitest":
    case "jest":
    case "mocha":
    case "pytest":
    case "playwright":
      return "test";
    case "eslint":
    case "oxlint":
    case "knip":
      return "lint";
    case "prettier":
    case "oxfmt":
    case "gofmt":
      return "format";
    case "biome":
    case "ruff":
      return subcommand === "format" ? "format" : "lint";
    case "go":
    case "cargo":
    case "dotnet":
      return TOOL_SUBCOMMAND_PHASES[subcommand ?? ""] ?? "other";
    case "make":
    case "webpack":
    case "tsup":
    case "esbuild":
    case "rollup":
    case "xcodebuild":
    case "gradlew":
      return "build";
    case "pip":
    case "pip3":
    case "brew":
    case "pod":
      return subcommand === "install" ? "install" : "other";
    case "uv":
      return subcommand === "sync" || subcommand === "add" || subcommand === "pip"
        ? "install"
        : "other";
    default:
      return "other";
  }
}

/**
 * Classifies by executable and subcommand of each command in the line. Quoted text never
 * counts, except a quoted absolute path, which counts by its file name.
 */
export function commandPhase(command: string): MonitoringCommandPhase {
  const phases = unwrapShell(command)
    .replace(LINE_CONTINUATION, " ")
    .replace(HEREDOC_PATTERN, "$3")
    .replace(QUOTED_PATTERN, (quoted) => QUOTED_PATH_PATTERN.exec(quoted)?.[2] ?? '""')
    .split(SEGMENT_SEPARATOR)
    .map((segment) => segmentPhase(segment.split(/\s+/).filter((word) => word !== "")));
  return PHASE_PRECEDENCE.find((phase) => phases.includes(phase)) ?? "other";
}

function epoch(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: DateTime.toEpochMillis,
  });
}

function iso(value: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(value));
}

function shorten(text: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= length ? flat : `${flat.slice(0, length - 1)}…`;
}

function itemEnd(item: AnalysisItem): number | null {
  return epoch(item.completedAt) ?? epoch(item.updatedAt);
}

function itemAt(item: AnalysisItem): number | null {
  return epoch(item.completedAt) ?? epoch(item.startedAt) ?? epoch(item.updatedAt);
}

function segmentStatus(status: string): MonitoringSegmentStatus {
  switch (status) {
    case "completed":
    case "failed":
    case "interrupted":
    case "cancelled":
      return status;
    case "superseded":
    case "rolled_back":
      return "cancelled";
    default:
      return "running";
  }
}

type Category =
  | "active"
  | "approval"
  | "command"
  | "tool"
  | "queued"
  | "usageLimit"
  | "delegate"
  | "userResponse"
  | "settleTail";

interface Interval {
  readonly start: number;
  readonly end: number;
  readonly category: Category;
}

/** Attributes every millisecond of `[from, to)` to one bucket, by what covered it. */
function partitionTime(from: number, to: number, intervals: ReadonlyArray<Interval>) {
  const buckets: { -readonly [K in keyof MonitoringTimeBuckets]: number } = {
    agentMs: 0,
    commandMs: 0,
    toolMs: 0,
    approvalMs: 0,
    queuedMs: 0,
    usageLimitMs: 0,
    delegateWaitMs: 0,
    userResponseMs: 0,
    idleMs: 0,
    settleTailMs: 0,
  };
  let activeMs = 0;
  const events: Array<{
    readonly at: number;
    readonly category: Category;
    readonly delta: 1 | -1;
  }> = [];
  for (const interval of intervals) {
    const start = Math.max(from, interval.start);
    const end = Math.min(to, interval.end);
    if (end <= start) continue;
    events.push({ at: start, category: interval.category, delta: 1 });
    events.push({ at: end, category: interval.category, delta: -1 });
  }
  events.sort((left, right) => left.at - right.at);
  const open: Record<Category, number> = {
    active: 0,
    approval: 0,
    command: 0,
    tool: 0,
    queued: 0,
    usageLimit: 0,
    delegate: 0,
    userResponse: 0,
    settleTail: 0,
  };
  let cursor = from;
  const attribute = (until: number) => {
    const span = until - cursor;
    if (span <= 0) return;
    if (open.active > 0) {
      activeMs += span;
      if (open.approval > 0) buckets.approvalMs += span;
      else if (open.command > 0) buckets.commandMs += span;
      else if (open.tool > 0) buckets.toolMs += span;
      else buckets.agentMs += span;
    } else if (open.queued > 0) buckets.queuedMs += span;
    else if (open.usageLimit > 0) buckets.usageLimitMs += span;
    else if (open.delegate > 0) buckets.delegateWaitMs += span;
    else if (open.settleTail > 0) buckets.settleTailMs += span;
    else if (open.userResponse > 0) buckets.userResponseMs += span;
    else buckets.idleMs += span;
  };
  for (const event of events) {
    attribute(event.at);
    cursor = Math.max(cursor, event.at);
    open[event.category] += event.delta;
  }
  attribute(to);
  return { buckets: buckets as MonitoringTimeBuckets, activeMs };
}

function promptSource(
  run: AnalysisRun,
  message: AnalysisMessage | undefined,
): MonitoringPromptSource {
  if (message?.scheduled === true) return "scheduled";
  if (run.automaticContinuation || run.restartContinuation) return "automatic";
  if (message?.delegatedTaskIds != null) return "helpers";
  if (message === undefined) return "automatic";
  if (message.fromThread || message.createdBy === "agent") return "agent";
  if (message.createdBy === "user") return "user";
  return "automatic";
}

function helperName(subagent: AnalysisSubagent): string | null {
  return subagent.title ?? (subagent.command === null ? null : normalizeCommand(subagent.command));
}

/** The wake text leads with task ids the agent needs; a person reads the helpers' titles. */
function helperTitles(
  message: AnalysisMessage | undefined,
  subagents: ReadonlyArray<AnalysisSubagent>,
): string | null {
  const titles = new Set(
    (message?.delegatedTaskIds ?? []).flatMap((taskId) => {
      const task = subagents.find((subagent) => subagent.id === taskId);
      const title = task === undefined ? null : helperName(task);
      return title === null ? [] : [title];
    }),
  );
  return titles.size === 0 ? null : [...titles].join(", ");
}

function threadKind(
  thread: AnalysisThread,
  firstSource: MonitoringPromptSource | undefined,
): MonitoringThreadKind {
  if (thread.delegated) return "delegated";
  if (firstSource === "scheduled") return "scheduled";
  if (thread.createdBy === "user") return "interactive";
  return "agent";
}

function severityByTime(
  wastedMs: number,
  mediumMs: number,
  highMs: number,
): MonitoringFindingSeverity {
  if (wastedMs >= highMs) return "high";
  if (wastedMs >= mediumMs) return "medium";
  return "low";
}

function severityByCount(count: number, medium: number, high: number): MonitoringFindingSeverity {
  if (count >= high) return "high";
  if (count >= medium) return "medium";
  return "low";
}

interface CommandRun {
  readonly runId: string | null;
  readonly command: string;
  readonly normalized: string;
  readonly phase: MonitoringCommandPhase;
  readonly start: number;
  readonly end: number;
  readonly exitCode: number | null;
  readonly failed: boolean;
}

function commandRun(
  runId: string | null,
  command: string,
  start: number,
  end: number,
  exitCode: number | null,
  failed: boolean,
): CommandRun {
  return {
    runId,
    command,
    normalized: normalizeCommand(command),
    phase: commandPhase(command),
    start,
    end: Math.max(start, end),
    exitCode,
    failed,
  };
}

type LaneDraft = Omit<MonitoringLane, "omittedSegments">;

/** Keeps the `limit` heaviest items, in their original order. */
function keepHeaviest<T>(items: ReadonlyArray<T>, limit: number, weight: (item: T) => number) {
  if (items.length <= limit) return { kept: items, omitted: 0 };
  const kept = items
    .map((item, index) => ({ item, index, weight: weight(item) }))
    .toSorted((left, right) => right.weight - left.weight || left.index - right.index)
    .slice(0, limit)
    .toSorted((left, right) => left.index - right.index)
    .map(({ item }) => item);
  return { kept, omitted: items.length - kept.length };
}

const segmentMs = (segment: MonitoringLane["segments"][number]) =>
  (epoch(segment.completedAt) ?? 0) - (epoch(segment.startedAt) ?? 0);

function capLane(lane: LaneDraft): MonitoringLane {
  const { kept, omitted } = keepHeaviest(lane.segments, MAX_LANE_SEGMENTS, segmentMs);
  return {
    ...lane,
    segments: kept.toSorted((left, right) => left.startedAt.localeCompare(right.startedAt)),
    omittedSegments: omitted,
  };
}

const laneMs = (lane: LaneDraft) =>
  lane.segments.reduce((sum, segment) => sum + segmentMs(segment), 0);

function helperLaneKind(subagent: AnalysisSubagent): MonitoringLaneKind {
  if (subagent.workflow !== null) return "workflow";
  if (subagent.origin !== "app_owned") return "subagent";
  return subagent.command !== null ? "command" : "delegate";
}

/** Analyzes one settled chat from its projection rows. Pure: the same input gives the same result. */
export function analyzeThread(input: ThreadAnalysisInput): MonitoringThreadDetail {
  const { thread } = input;
  const createdAt = epoch(thread.createdAt) ?? 0;
  const settleStamp = epoch(thread.settledAt) ?? createdAt;
  const settledAt = Math.max(createdAt, settleStamp);
  const clamp = (value: number) => Math.min(settledAt, Math.max(createdAt, value));

  const runs = [...input.runs].toSorted((left, right) => left.ordinal - right.ordinal);
  const messageById = new Map(input.messages.map((message) => [message.messageId, message]));
  const itemsByRun = new Map<string, Array<AnalysisItem>>();
  for (const item of input.items) {
    if (item.runId === null) continue;
    const list = itemsByRun.get(item.runId);
    if (list === undefined) itemsByRun.set(item.runId, [item]);
    else list.push(item);
  }

  const intervals: Array<Interval> = [];
  const runSpans = new Map<string, { readonly start: number; readonly end: number }>();
  for (const run of runs) {
    const requested = epoch(run.requestedAt);
    const started = epoch(run.startedAt);
    let end = epoch(run.completedAt);
    if (end === null && started !== null) {
      // A run left open without an end: its last recorded activity bounds it.
      end = started;
      for (const item of itemsByRun.get(run.runId) ?? []) {
        end = Math.max(end, itemEnd(item) ?? end);
      }
    }
    if (requested !== null) {
      const queueEnd = started ?? end ?? requested;
      if (queueEnd > requested)
        intervals.push({ start: requested, end: queueEnd, category: "queued" });
    }
    if (started !== null && end !== null && end >= started) {
      intervals.push({ start: started, end, category: "active" });
      runSpans.set(run.runId, { start: clamp(started), end: clamp(end) });
    }
  }

  const runStarts = [...runSpans.values()].map((span) => span.start).toSorted((a, b) => a - b);
  const nextRunStartAfter = (at: number) => runStarts.find((start) => start > at) ?? settledAt;

  // Waiting for the user: from the end of earlier work to a prompt the user wrote.
  let workEnd = createdAt;
  for (const run of runs) {
    const requested = epoch(run.requestedAt);
    const source = promptSource(run, messageById.get(run.userMessageId));
    if (requested !== null && source === "user" && requested > workEnd) {
      intervals.push({ start: workEnd, end: requested, category: "userResponse" });
    }
    const span = runSpans.get(run.runId);
    if (span !== undefined) workEnd = Math.max(workEnd, span.end);
  }
  if (runSpans.size > 0) {
    intervals.push({ start: workEnd, end: settledAt, category: "settleTail" });
  }

  const commands: Array<CommandRun> = [];
  const errors: Record<string, number> = {};
  const markers: Array<MonitoringMarker> = [];
  const files = new Set<string>();
  const filesByRun = new Map<string, Set<string>>();
  let compactions = 0;
  let handoffs = 0;
  let interrupts = 0;
  const interruptedRuns = new Set<string>();
  for (const item of input.items) {
    switch (item.type) {
      case "command_execution": {
        const start = epoch(item.startedAt);
        const end = itemEnd(item);
        if (item.command === null || start === null || end === null || item.monitor) break;
        const failed =
          item.status === "failed" ||
          item.outputIndicatesFailure ||
          (item.exitCode !== null && item.exitCode !== 0);
        commands.push(commandRun(item.runId, item.command, start, end, item.exitCode, failed));
        intervals.push({ start, end: Math.max(start, end), category: "command" });
        break;
      }
      case "error": {
        const failureClass = item.failureClass ?? "unknown";
        errors[failureClass] = (errors[failureClass] ?? 0) + 1;
        const at = itemAt(item);
        if (at === null) break;
        if (failureClass === "usage_limit") {
          intervals.push({ start: at, end: nextRunStartAfter(at), category: "usageLimit" });
          markers.push({ at: iso(at), kind: "usage_limit", detail: null });
        } else {
          markers.push({ at: iso(at), kind: "failure", detail: failureClass });
        }
        break;
      }
      case "run_interrupt_request": {
        interrupts += 1;
        if (item.runId !== null) interruptedRuns.add(item.runId);
        const at = itemAt(item);
        if (at !== null) markers.push({ at: iso(at), kind: "interrupt", detail: null });
        break;
      }
      case "compaction": {
        compactions += 1;
        const at = itemAt(item);
        if (at !== null) markers.push({ at: iso(at), kind: "compaction", detail: null });
        break;
      }
      case "handoff": {
        handoffs += 1;
        const at = itemAt(item);
        if (at !== null) markers.push({ at: iso(at), kind: "handoff", detail: item.toModel });
        break;
      }
      case "file_change": {
        if (item.fileName === null) break;
        files.add(item.fileName);
        if (item.runId !== null) {
          const runFiles = filesByRun.get(item.runId) ?? new Set<string>();
          runFiles.add(item.fileName);
          filesByRun.set(item.runId, runFiles);
        }
        break;
      }
      default: {
        if (!TOOL_ITEM_TYPES.has(item.type)) break;
        const start = epoch(item.startedAt);
        const end = itemEnd(item);
        if (start !== null && end !== null && end > start) {
          intervals.push({ start, end, category: "tool" });
        }
      }
    }
  }

  for (const request of input.requests) {
    if (NON_PERSON_REQUEST_KINDS.has(request.kind)) continue;
    const start = epoch(request.createdAt);
    if (start === null) continue;
    const end = epoch(request.resolvedAt) ?? start;
    if (end > start) intervals.push({ start, end, category: "approval" });
  }

  const lanes: Array<LaneDraft> = [];
  const helperModels = new Set<string>();
  const helpers = { subagents: 0, delegates: 0, commands: 0, workflows: 0, failed: 0 };
  const subagents = [...input.subagents].toSorted(
    (left, right) => (epoch(left.startedAt) ?? 0) - (epoch(right.startedAt) ?? 0),
  );
  for (const subagent of subagents) {
    const kind = helperLaneKind(subagent);
    if (kind === "workflow") helpers.workflows += 1;
    else if (kind === "subagent") helpers.subagents += 1;
    else if (kind === "command") helpers.commands += 1;
    else helpers.delegates += 1;
    if (subagent.status === "failed") helpers.failed += 1;
    if (subagent.model !== null) helperModels.add(subagent.model);
    const start = epoch(subagent.startedAt);
    const end = epoch(subagent.completedAt) ?? epoch(subagent.updatedAt);
    if (start !== null && end !== null && end > start) {
      intervals.push({ start, end, category: "delegate" });
    }
    if (kind === "command" && subagent.command !== null && start !== null && end !== null) {
      commands.push(
        commandRun(null, subagent.command, start, end, null, subagent.status === "failed"),
      );
    }
    lanes.push({
      id: subagent.id,
      kind,
      label: shorten(helperName(subagent) ?? subagent.prompt, LANE_LABEL_LENGTH),
      model: subagent.model,
      childThreadId: subagent.childThreadId,
      tokens: subagent.workflow?.totalTokens ?? null,
      segments:
        start === null || end === null
          ? []
          : [
              {
                startedAt: iso(clamp(start)),
                completedAt: iso(clamp(Math.max(start, end))),
                status: segmentStatus(subagent.status),
                runId: null,
              },
            ],
    });
    for (const [index, agent] of (subagent.workflow?.agents ?? []).entries()) {
      if (agent.model !== null) helperModels.add(agent.model);
      lanes.push({
        id: `${subagent.id}:${index}`,
        kind: "subagent",
        label: shorten(agent.label, LANE_LABEL_LENGTH),
        model: agent.model,
        childThreadId: null,
        tokens: agent.totalTokens,
        segments:
          agent.startedAt === null
            ? []
            : [
                {
                  startedAt: iso(clamp(agent.startedAt)),
                  completedAt: iso(
                    clamp(Math.max(agent.startedAt, agent.completedAt ?? agent.startedAt)),
                  ),
                  status:
                    agent.state === "failed"
                      ? "failed"
                      : agent.state === "completed"
                        ? "completed"
                        : "running",
                  runId: null,
                },
              ],
      });
    }
  }

  const { buckets: time, activeMs } = partitionTime(createdAt, settledAt, intervals);

  const runTotals = new Map<string, { output: number; cost: number; priced: boolean }>();
  const tokens = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
  let costUsd = 0;
  let unpricedTurns = 0;
  let peakContextRatio: number | null = null;
  for (const turn of input.turns) {
    if (
      turn.contextUsedTokens !== null &&
      turn.contextMaxTokens !== null &&
      turn.contextMaxTokens > 0
    ) {
      const ratio = Math.min(1, turn.contextUsedTokens / turn.contextMaxTokens);
      peakContextRatio = peakContextRatio === null ? ratio : Math.max(peakContextRatio, ratio);
    }
    const usage = turn.usage;
    if (usage?.localCommand === true) continue;
    if (usage !== null) {
      tokens.inputTokens += usage.inputTokens ?? 0;
      tokens.cachedInputTokens += usage.cachedInputTokens ?? 0;
      tokens.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
      tokens.outputTokens += usage.outputTokens ?? 0;
      tokens.reasoningTokens += usage.reasoningTokens ?? 0;
    }
    if (turn.costUsd === null) unpricedTurns += 1;
    else costUsd += turn.costUsd;
    if (turn.runId !== null) {
      const totals = runTotals.get(turn.runId) ?? { output: 0, cost: 0, priced: false };
      totals.output += usage?.outputTokens ?? 0;
      if (turn.costUsd !== null) {
        totals.cost += turn.costUsd;
        totals.priced = true;
      }
      runTotals.set(turn.runId, totals);
    }
  }

  const attemptCounts = { retries: 0, steeringRestarts: 0, providerRecoveries: 0 };
  for (const attempt of input.attempts) {
    let kind: "retry" | "steering_restart";
    if (attempt.reason === "retry") {
      attemptCounts.retries += 1;
      kind = "retry";
    } else if (attempt.reason === "provider_recovery") {
      attemptCounts.providerRecoveries += 1;
      kind = "retry";
    } else if (attempt.reason === "steering_restart") {
      attemptCounts.steeringRestarts += 1;
      kind = "steering_restart";
    } else continue;
    const at = epoch(attempt.startedAt);
    if (at !== null) markers.push({ at: iso(clamp(at)), kind, detail: null });
  }

  const runCounts = {
    total: runs.length,
    completed: 0,
    failed: 0,
    interrupted: 0,
    cancelled: 0,
    userPrompts: 0,
    automatic: 0,
    ...attemptCounts,
  };
  const models: Array<string> = [];
  const chatSegments: Array<MonitoringLane["segments"][number]> = [];
  const steps: Array<MonitoringRunStep> = [];
  let firstSource: MonitoringPromptSource | undefined;
  let failedRunMs = 0;
  let interruptedRunMs = 0;
  for (const run of runs) {
    if (run.status === "completed") runCounts.completed += 1;
    else if (run.status === "failed") runCounts.failed += 1;
    else if (run.status === "interrupted") runCounts.interrupted += 1;
    else if (run.status === "cancelled" || run.status === "rolled_back") runCounts.cancelled += 1;
    const message = messageById.get(run.userMessageId);
    const source = promptSource(run, message);
    firstSource ??= source;
    if (source === "user") runCounts.userPrompts += 1;
    else runCounts.automatic += 1;
    if (run.model !== null) {
      const at = models.indexOf(run.model);
      if (at !== -1) models.splice(at, 1);
      models.unshift(run.model);
    }
    const requested = epoch(run.requestedAt) ?? createdAt;
    const span = runSpans.get(run.runId);
    const durationMs = span === undefined ? 0 : span.end - span.start;
    if (run.status === "failed") failedRunMs += durationMs;
    if (interruptedRuns.has(run.runId)) interruptedRunMs += durationMs;
    markers.push({
      at: iso(clamp(requested)),
      kind: source === "user" ? "user_prompt" : "automatic_prompt",
      detail: null,
    });
    if (span !== undefined) {
      chatSegments.push({
        startedAt: iso(span.start),
        completedAt: iso(span.end),
        status: segmentStatus(run.status),
        runId: run.runId,
      });
    }
    const runCommands = commands.filter((command) => command.runId === run.runId);
    const totals = runTotals.get(run.runId);
    steps.push({
      runId: run.runId,
      source,
      prompt: shorten(
        helperTitles(message, input.subagents) ?? message?.text ?? "",
        PROMPT_EXCERPT_LENGTH,
      ),
      model: run.model,
      status: run.status,
      requestedAt: iso(clamp(requested)),
      startedAt: span === undefined ? null : iso(span.start),
      completedAt: span === undefined ? null : iso(span.end),
      queuedMs: span === undefined ? 0 : Math.max(0, span.start - clamp(requested)),
      durationMs,
      outputTokens: totals?.output ?? 0,
      costUsd: totals?.priced === true ? totals.cost : null,
      commands: runCommands.length,
      failedCommands: runCommands.filter((command) => command.failed).length,
      filesChanged: filesByRun.get(run.runId)?.size ?? 0,
    });
  }
  if (models.length === 0 && thread.model !== null) models.push(thread.model);
  const chatLane: LaneDraft = {
    id: "chat",
    kind: "chat",
    label: thread.title,
    model: models[0] ?? null,
    childThreadId: null,
    tokens: null,
    segments: chatSegments,
  };

  const phaseTotals = new Map<
    MonitoringCommandPhase,
    { count: number; failed: number; durationMs: number }
  >();
  const groups = new Map<
    string,
    {
      phase: MonitoringCommandPhase;
      count: number;
      failed: number;
      durationMs: number;
      runs: Array<{ start: number; durationMs: number }>;
    }
  >();
  let commandFailures = 0;
  let commandMsTotal = 0;
  let failedCommandMs = 0;
  let routineFailures = 0;
  for (const command of commands) {
    const durationMs = command.end - command.start;
    commandMsTotal += durationMs;
    const phase = phaseTotals.get(command.phase) ?? { count: 0, failed: 0, durationMs: 0 };
    phase.count += 1;
    phase.durationMs += durationMs;
    if (command.failed) {
      phase.failed += 1;
      commandFailures += 1;
      if (ROUTINE_PHASES.has(command.phase)) routineFailures += 1;
      else failedCommandMs += durationMs;
    }
    phaseTotals.set(command.phase, phase);
    const group = groups.get(command.normalized) ?? {
      phase: command.phase,
      count: 0,
      failed: 0,
      durationMs: 0,
      runs: [],
    };
    group.count += 1;
    group.durationMs += durationMs;
    group.runs.push({ start: command.start, durationMs });
    if (command.failed) group.failed += 1;
    groups.set(command.normalized, group);
  }
  const phases: Array<MonitoringPhaseStats> = [...phaseTotals.entries()]
    .map(([phase, totals]) => ({ phase, ...totals }))
    .toSorted((left, right) => right.durationMs - left.durationMs);
  const slowest = [...commands].toSorted(
    (left, right) => right.end - right.start - (left.end - left.start),
  );
  const slowestCommands: Array<MonitoringCommandRecord> = slowest
    .slice(0, MAX_COMMAND_RECORDS)
    .map((command) => ({
      command: shorten(command.normalized, COMMAND_EXCERPT_LENGTH),
      phase: command.phase,
      startedAt: iso(clamp(command.start)),
      durationMs: command.end - command.start,
      exitCode: command.exitCode,
      failed: command.failed,
    }));
  const repeatedCommands: Array<MonitoringCommandGroup> = [...groups.entries()]
    .filter(([, group]) => group.count > 1)
    .map(([command, group]) => ({
      command: shorten(command, COMMAND_EXCERPT_LENGTH),
      phase: group.phase,
      count: group.count,
      failed: group.failed,
      durationMs: group.durationMs,
    }))
    .toSorted((left, right) => right.durationMs - left.durationMs)
    .slice(0, MAX_COMMAND_RECORDS);

  const findings: Array<MonitoringFinding> = [];
  const usageLimits = errors["usage_limit"] ?? 0;
  if (time.usageLimitMs > 0 || usageLimits > 0) {
    findings.push({
      code: "usage_limit",
      severity: severityByTime(time.usageLimitMs, 5 * MINUTE_MS, 30 * MINUTE_MS),
      wastedMs: time.usageLimitMs,
      count: usageLimits,
      detail: null,
    });
  }
  const otherErrors = Object.entries(errors)
    .filter(([failureClass]) => failureClass !== "usage_limit")
    .toSorted((left, right) => right[1] - left[1]);
  const otherErrorCount = otherErrors.reduce((sum, [, count]) => sum + count, 0);
  if (otherErrorCount > 0 || runCounts.failed > 0) {
    findings.push({
      code: "run_failures",
      severity: severityByCount(Math.max(otherErrorCount, runCounts.failed), 1, 3),
      wastedMs: failedRunMs,
      count: Math.max(otherErrorCount, runCounts.failed),
      detail: otherErrors[0]?.[0] ?? null,
    });
  }
  const retryCount = attemptCounts.retries + attemptCounts.providerRecoveries;
  if (retryCount > 0) {
    findings.push({
      code: "retries",
      severity: severityByCount(retryCount, 3, 6),
      wastedMs: 0,
      count: retryCount,
      detail: null,
    });
  }
  if (attemptCounts.steeringRestarts > 0) {
    findings.push({
      code: "steering_restarts",
      severity: severityByCount(attemptCounts.steeringRestarts, 3, 6),
      wastedMs: 0,
      count: attemptCounts.steeringRestarts,
      detail: null,
    });
  }
  if (interrupts > 0) {
    findings.push({
      code: "user_interrupts",
      severity: severityByCount(interrupts, 3, 6),
      wastedMs: interruptedRunMs,
      count: interrupts,
      detail: null,
    });
  }
  if (time.queuedMs >= LONG_QUEUE_MS) {
    findings.push({
      code: "long_queue",
      severity: severityByTime(time.queuedMs, 5 * MINUTE_MS, 15 * MINUTE_MS),
      wastedMs: time.queuedMs,
      count: runs.filter((run) => {
        const span = runSpans.get(run.runId);
        const requested = epoch(run.requestedAt);
        return span !== undefined && requested !== null && span.start - requested >= MINUTE_MS;
      }).length,
      detail: null,
    });
  }
  const slowCommands = commands.filter((command) => command.end - command.start >= SLOW_COMMAND_MS);
  if (slowCommands.length > 0) {
    const wastedMs = slowCommands.reduce((sum, command) => sum + command.end - command.start, 0);
    findings.push({
      code: "slow_command",
      severity: severityByTime(
        Math.max(...slowCommands.map((command) => command.end - command.start)),
        SLOW_COMMAND_MS,
        30 * MINUTE_MS,
      ),
      wastedMs,
      count: slowCommands.length,
      detail: slowestCommands[0]?.command ?? null,
    });
  }
  const repeated = [...groups.entries()]
    .filter(
      ([, group]) => group.count >= REPEATED_COMMAND_MIN_COUNT && !ROUTINE_PHASES.has(group.phase),
    )
    .map(([command, group]) => ({
      command: shorten(command, COMMAND_EXCERPT_LENGTH),
      count: group.count,
      wastedMs: group.runs
        .toSorted((left, right) => left.start - right.start)
        .slice(1)
        .reduce((sum, run) => sum + run.durationMs, 0),
    }))
    .toSorted((left, right) => right.wastedMs - left.wastedMs);
  const worstRepeat = repeated[0];
  if (worstRepeat !== undefined) {
    findings.push({
      code: "repeated_command",
      severity: severityByTime(worstRepeat.wastedMs, 10 * MINUTE_MS, 30 * MINUTE_MS),
      wastedMs: worstRepeat.wastedMs,
      count: worstRepeat.count,
      detail: worstRepeat.command,
    });
  }
  const meaningfulFailures = commandFailures - routineFailures;
  if (meaningfulFailures >= FAILING_COMMANDS_MIN_COUNT) {
    findings.push({
      code: "failing_commands",
      severity:
        meaningfulFailures >= 10 || failedCommandMs >= 15 * MINUTE_MS
          ? "high"
          : meaningfulFailures >= 5
            ? "medium"
            : "low",
      wastedMs: failedCommandMs,
      count: meaningfulFailures,
      detail: null,
    });
  }
  if (time.approvalMs >= APPROVAL_WAIT_MS) {
    findings.push({
      code: "approval_wait",
      severity: severityByTime(time.approvalMs, 5 * MINUTE_MS, 15 * MINUTE_MS),
      wastedMs: time.approvalMs,
      count: input.requests.filter((request) => !NON_PERSON_REQUEST_KINDS.has(request.kind)).length,
      detail: null,
    });
  }
  if (time.delegateWaitMs >= DELEGATE_WAIT_MS) {
    findings.push({
      code: "delegate_wait",
      severity: severityByTime(time.delegateWaitMs, 60 * MINUTE_MS, 180 * MINUTE_MS),
      wastedMs: time.delegateWaitMs,
      count: helpers.delegates + helpers.commands + helpers.subagents + helpers.workflows,
      detail: null,
    });
  }
  if (tokens.inputTokens >= LOW_CACHE_REUSE_MIN_INPUT) {
    const ratio = tokens.cachedInputTokens / tokens.inputTokens;
    if (ratio < LOW_CACHE_REUSE_RATIO) {
      findings.push({
        code: "low_cache_reuse",
        severity: ratio < LOW_CACHE_REUSE_RATIO / 2 ? "high" : "medium",
        wastedMs: 0,
        count: 0,
        detail: String(Math.round(ratio * 100)),
      });
    }
  }
  // A turn reports its context after any compaction in it, so a compacted chat can show a low peak.
  if (compactions > 0) {
    findings.push({
      code: "context_compacted",
      severity: compactions >= 2 ? "medium" : "low",
      wastedMs: 0,
      count: compactions,
      detail: null,
    });
  } else if (peakContextRatio !== null && peakContextRatio >= CONTEXT_PRESSURE_RATIO) {
    findings.push({
      code: "context_pressure",
      severity: "low",
      wastedMs: 0,
      count: 0,
      detail: String(Math.round(peakContextRatio * 100)),
    });
  }
  if (runCounts.userPrompts >= MANY_PROMPTS) {
    findings.push({
      code: "many_prompts",
      severity: severityByCount(runCounts.userPrompts, MANY_PROMPTS * 2, MANY_PROMPTS * 4),
      wastedMs: time.userResponseMs,
      count: runCounts.userPrompts,
      detail: null,
    });
  }
  if (input.reopens > 0) {
    findings.push({
      code: "reopened",
      severity: "low",
      wastedMs: 0,
      count: input.reopens,
      detail: null,
    });
  }
  const severityRank: Record<MonitoringFindingSeverity, number> = { high: 0, medium: 1, low: 2 };
  findings.sort(
    (left, right) =>
      severityRank[left.severity] - severityRank[right.severity] || right.wastedMs - left.wastedMs,
  );

  const summary: MonitoringThreadSummary = {
    threadId: thread.threadId,
    projectId: thread.projectId,
    title: thread.title,
    kind: threadKind(thread, firstSource),
    providerInstanceId: thread.providerInstanceId,
    models,
    helperModels: [...helperModels],
    createdAt: iso(createdAt),
    // The stamp itself, even one before creation: the window, the days and the list order read it.
    settledAt: iso(settleStamp),
    lifetimeMs: settledAt - createdAt,
    activeMs,
    time,
    runs: runCounts,
    errors,
    tokens,
    costUsd,
    unpricedTurns,
    peakContextRatio,
    compactions,
    handoffs,
    helpers,
    commands: { count: commands.length, failed: commandFailures, durationMs: commandMsTotal },
    phases,
    filesChanged: files.size,
    reopens: input.reopens,
    findings,
  };

  markers.sort((left, right) => left.at.localeCompare(right.at));
  const keptLanes = keepHeaviest(lanes, MAX_HELPER_LANES, laneMs);
  const keptMarkers = keepHeaviest(markers, MAX_MARKERS, (marker) =>
    marker.kind === "user_prompt" || marker.kind === "automatic_prompt" ? 0 : 1,
  );
  const keptSteps = keepHeaviest(steps, MAX_STEPS, (step) => step.durationMs);
  return {
    summary,
    lanes: [chatLane, ...keptLanes.kept].map(capLane),
    markers: keptMarkers.kept,
    steps: keptSteps.kept,
    omitted: {
      lanes: keptLanes.omitted,
      markers: keptMarkers.omitted,
      steps: keptSteps.omitted,
    },
    slowestCommands,
    repeatedCommands,
  };
}
