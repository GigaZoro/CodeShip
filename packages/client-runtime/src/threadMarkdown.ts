import {
  isCompactionCommandMessage,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { t } from "@t3tools/shared/i18n";
import {
  literalMarkdownBlock,
  type MarkdownBlock,
  markdownBlock,
  markdownBlockSeparator,
  markdownCodeSpan,
  markdownDocumentEnding,
  standaloneMarkdown,
} from "@t3tools/shared/markdownStandalone";

import { resolveWorkflowOpening } from "./state/subagentRuntime.ts";
import { turnItemIsRunStartDetail } from "./state/turnItemPresentation.ts";
import { resolveUserMessagePresentation } from "./userMessage.ts";
import { turnItemResultIndicatesFailure } from "./work-log/presentation.ts";
import { getQuestionAnswerText } from "./work-log/userInput.ts";

export interface ThreadMarkdownInput {
  readonly title: string;
  readonly thread?: Pick<OrchestrationV2AppThread, "id" | "lineage" | "creationSource">;
  readonly projectName: string | null;
  /** An ISO timestamp. */
  readonly createdAt: string | null;
  readonly items: ReadonlyArray<Pick<OrchestrationV2ProjectedTurnItem, "item">>;
}

type UserMessageItem = Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }>;
type UserInputRequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "user_input_request" }
>;

const TOOL_LINE_MAX_LENGTH = 100;
// Long transcripts are built in slices this long so the interface keeps responding.
const BUILD_SLICE_MS = 12;
const FILE_NAME_MAX_LENGTH = 80;
const FILE_NAME_FORBIDDEN_PATTERN = /[\\/:*?"<>|\u0000-\u001f]/gu;
// Windows reserves these names before the first dot, whatever the extension.
const WINDOWS_RESERVED_NAME_PATTERN = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?= *(?:\.|$))/iu;

/** At most `maxLength` code units of `text`, never ending on half of a surrogate pair. */
function clip(text: string, maxLength: number): string {
  const cut = text.slice(0, maxLength);
  return /[\uD800-\uDBFF]$/u.test(cut) ? cut.slice(0, -1) : cut;
}

/** The first line of the value in a code span, clipped. */
function inlineCode(value: string, maxLength = TOOL_LINE_MAX_LENGTH): string {
  const trimmed = value.trim();
  const lineEnd = trimmed.search(/\r|\n/u);
  const flat = (lineEnd === -1 ? trimmed : trimmed.slice(0, lineEnd)).replace(/\s+/gu, " ");
  return markdownCodeSpan(flat.length > maxLength ? `${clip(flat, maxLength - 1)}…` : flat);
}

/** Whether the work log marks the tool failed. */
function toolFailed(item: OrchestrationV2TurnItem): boolean {
  return item.status === "failed" || turnItemResultIndicatesFailure(item) === true;
}

function editedFiles(item: Extract<OrchestrationV2TurnItem, { readonly type: "file_change" }>) {
  if (item.changes === undefined || item.changes.length === 0) return inlineCode(item.fileName);
  return item.changes
    .map((change) =>
      change.oldPath === undefined || change.oldPath === change.path
        ? inlineCode(change.path)
        : `${inlineCode(change.oldPath)} → ${inlineCode(change.path)}`,
    )
    .join(", ");
}

function toolLine(item: OrchestrationV2TurnItem): string | null {
  const line = (() => {
    switch (item.type) {
      case "command_execution":
        return item.input.trim() === ""
          ? null
          : t("Ran {command}", { command: inlineCode(item.input) });
      case "file_change":
        return t("Edited {file}", { file: editedFiles(item) });
      case "file_search":
        return item.pattern === undefined || item.pattern.trim() === ""
          ? t("Searched files")
          : t("Searched files for {pattern}", { pattern: inlineCode(item.pattern) });
      case "web_search": {
        const queries = item.patterns?.filter((query) => query.trim() !== "") ?? [];
        return queries.length === 0
          ? t("Searched the web")
          : t("Searched the web for {query}", {
              query: queries.map((query) => inlineCode(query)).join(", "),
            });
      }
      case "dynamic_tool":
        return item.toolName === null
          ? null
          : t("Used tool {tool}", { tool: inlineCode(item.toolName) });
      case "subagent": {
        const task = (item.title ?? "").trim() === "" ? item.prompt : (item.title ?? "");
        return task.trim() === ""
          ? null
          : t("Delegated to a subagent: {task}", { task: inlineCode(task) });
      }
      default:
        return null;
    }
  })();
  if (line === null) return null;
  return toolFailed(item) ? t("{line} (failed)", { line }) : line;
}

/**
 * The prompt as the timeline shows it: the attachment-only prompt is hidden, context blocks of
 * older messages become references, and each reference reads as its chip's label.
 */
function userMessageText(item: UserMessageItem): string {
  const display = resolveUserMessagePresentation({ ...item, role: "user", id: item.messageId });
  // A message with structured context keeps literal tags its author typed.
  const text = item.context ? display.text : upgradeLegacyContextMessage(display.text).text;
  let result = "";
  let end = 0;
  for (const reference of collectComposerContextReferences(text)) {
    result += `${text.slice(end, reference.start)}${inlineCode(reference.label, 255)}`;
    end = reference.end;
  }
  return result + text.slice(end);
}

function questionTexts(item: UserInputRequestItem) {
  const answer = item.questionAnswer;
  const questionIds = new Set([
    ...item.questions.map((question) => question.id),
    ...Object.keys(answer?.questionTextById ?? {}),
    ...Object.keys(answer?.answers ?? {}),
    ...Object.keys(answer?.attachmentsByQuestionId ?? {}),
  ]);
  return Array.from(questionIds, (id) => ({
    question:
      answer?.questionTextById?.[id] ??
      item.questions.find((candidate) => candidate.id === id)?.question ??
      "",
    answer: getQuestionAnswerText(answer?.answers[id]),
    attachments: (answer?.attachmentsByQuestionId[id] ?? []).map((attachment) => attachment.name),
  }));
}

function collectReservedPrefixes(text: string, reserved: Set<string>) {
  for (const [match] of text.matchAll(/ref(?:[1-9][0-9]*)?/giu)) {
    // Label numbers are safe integers, even when the source contains a longer digit run.
    for (let end = 3; end <= Math.min(match.length, 19); end += 1) {
      reserved.add(match.slice(0, end).toLowerCase());
    }
  }
}

function createBlockWriter(prefix: string) {
  let scope = 1;
  const textBlock = (text: string): MarkdownBlock | null => {
    const block = standaloneMarkdown(text, { scope, prefix });
    scope += block?.labelCount ?? 0;
    return block;
  };
  const messageBlocks = (text: string, attachmentNames: ReadonlyArray<string>): MarkdownBlock[] =>
    [
      textBlock(text),
      attachmentNames.length === 0
        ? null
        : markdownBlock(
            t("Attachments: {names}", {
              names: attachmentNames.map((name) => inlineCode(name, 255)).join(", "),
            }),
          ),
    ].filter((part) => part !== null);

  const questionBlocks = (texts: ReturnType<typeof questionTexts>): MarkdownBlock[] =>
    texts.flatMap(({ question, answer, attachments }) => {
      const questionBlock = textBlock(question);
      const answerBlock = textBlock(answer);
      return [
        ...(questionBlock === null ? [] : [questionBlock]),
        ...(answerBlock === null ? [] : [literalMarkdownBlock(t("Answer:")), answerBlock]),
        ...messageBlocks("", attachments),
      ];
    });

  return { textBlock, messageBlocks, questionBlocks };
}

function flatten(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

function abortedError(): Error {
  const error = new Error("The thread export was cancelled.");
  error.name = "AbortError";
  return error;
}

/**
 * Exports messages, plans and answered questions with their authored Markdown, plus one
 * line per command, edit, search, tool call or subagent. Reasoning, approvals, checkpoints and
 * notices describe how the agent worked, so they are left out. Rejects when `signal` aborts.
 */
export async function buildThreadMarkdown(
  input: ThreadMarkdownInput,
  options: { readonly signal?: AbortSignal } = {},
): Promise<string> {
  if (options.signal?.aborted === true) throw abortedError();
  let sliceStart = performance.now();
  const yieldIfDue = async () => {
    if (performance.now() - sliceStart >= BUILD_SLICE_MS) {
      // @effect-diagnostics-next-line globalTimers:off - A macrotask lets the interface paint between slices.
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
    if (options.signal?.aborted === true) throw abortedError();
  };

  const title = flatten(input.title);
  const metadata = [
    input.projectName === null
      ? null
      : t("Project: {project}", { project: flatten(input.projectName) }),
    input.createdAt === null ? null : t("Created: {date}", { date: input.createdAt.slice(0, 10) }),
  ].filter((part) => part !== null);

  const blocks: MarkdownBlock[] = [
    literalMarkdownBlock(title === "" ? t("Untitled thread") : title, 1),
  ];
  if (metadata.length > 0) blocks.push(literalMarkdownBlock(metadata.join(" · ")));

  // Answers given in a question card also arrive as a message; the card already shows them.
  const foldedAnswerMessageIds = new Set(
    input.items.flatMap(({ item }) =>
      item.type === "user_input_request" && item.questionAnswer
        ? [`async-answer:${item.questionAnswer.requestId}`]
        : [],
    ),
  );

  const firstUser = input.items.find(({ item }) => item.type === "user_message")?.item;
  const workflowOpening =
    input.thread !== undefined && firstUser?.type === "user_message"
      ? resolveWorkflowOpening({
          thread: input.thread,
          messages: [{ ...firstUser, id: firstUser.messageId, role: "user" }],
          parentSubagents: null,
        })
      : null;

  const userTexts = new Map<UserMessageItem, string>();
  const questionTextByItem = new Map<UserInputRequestItem, ReturnType<typeof questionTexts>>();
  const reservedPrefixes = new Set<string>();
  for (const { item } of input.items) {
    await yieldIfDue();
    if (turnItemIsRunStartDetail(item) && !item.deferredWork) continue;
    switch (item.type) {
      case "user_message": {
        if (item.workflowScript === true || item.messageId === workflowOpening?.messageId) break;
        if (item.runId !== null && isCompactionCommandMessage({ ...item, role: "user" })) break;
        if (item.inputIntent === "queued_turn" && item.status === "pending") break;
        if (foldedAnswerMessageIds.has(item.messageId)) break;
        const text = userMessageText(item);
        userTexts.set(item, text);
        collectReservedPrefixes(text, reservedPrefixes);
        break;
      }
      case "assistant_message":
        collectReservedPrefixes(item.text, reservedPrefixes);
        break;
      case "proposed_plan":
        collectReservedPrefixes(item.markdown, reservedPrefixes);
        break;
      case "user_input_request": {
        const texts = questionTexts(item);
        questionTextByItem.set(item, texts);
        for (const { question, answer } of texts) {
          collectReservedPrefixes(question, reservedPrefixes);
          collectReservedPrefixes(answer, reservedPrefixes);
        }
        break;
      }
    }
  }
  let prefix = "ref";
  for (let suffix = 1; reservedPrefixes.has(prefix); suffix += 1) prefix = `ref${suffix}`;
  const writer = createBlockWriter(prefix);

  let toolLines: string[] = [];
  let section: "user" | "assistant" | null = null;
  const startSection = (next: "user" | "assistant", text: string) => {
    if (section !== next) blocks.push(literalMarkdownBlock(text, 2));
    section = next;
  };
  const flushToolLines = () => {
    if (toolLines.length === 0) return;
    startSection("assistant", t("Assistant"));
    blocks.push(markdownBlock(toolLines.map((line) => `- ${line}`).join("\n")));
    toolLines = [];
  };

  for (const { item } of input.items) {
    await yieldIfDue();
    if (turnItemIsRunStartDetail(item) && !item.deferredWork) continue;
    switch (item.type) {
      case "user_message": {
        const text = userTexts.get(item);
        if (text === undefined) break;
        const parts = writer.messageBlocks(
          text,
          item.attachments.map((attachment) => attachment.name),
        );
        if (parts.length === 0) break;
        flushToolLines();
        startSection("user", t("User"));
        blocks.push(...parts);
        break;
      }
      case "assistant_message": {
        const parts = writer.messageBlocks(
          item.text,
          (item.attachments ?? []).map((attachment) => attachment.name),
        );
        if (parts.length === 0) break;
        flushToolLines();
        startSection("assistant", t("Assistant"));
        blocks.push(...parts);
        break;
      }
      case "proposed_plan": {
        const plan = writer.textBlock(item.markdown);
        if (plan === null) break;
        flushToolLines();
        blocks.push(literalMarkdownBlock(t("Plan"), 2), plan);
        section = null;
        break;
      }
      case "user_input_request": {
        const questions = writer.questionBlocks(questionTextByItem.get(item)!);
        if (questions.length === 0) break;
        flushToolLines();
        blocks.push(literalMarkdownBlock(t("Questions"), 2), ...questions);
        section = null;
        break;
      }
      default: {
        const line = toolLine(item);
        if (line !== null) toolLines.push(line);
      }
    }
  }
  flushToolLines();

  let markdown = blocks[0]!.text;
  for (let index = 1; index < blocks.length; index += 1) {
    await yieldIfDue();
    markdown += `${markdownBlockSeparator(blocks[index - 1]!, blocks[index]!)}${blocks[index]!.text}`;
  }
  return markdown + markdownDocumentEnding(blocks.at(-1)!);
}

export function threadMarkdownFileName(title: string): string {
  const base = clip(
    title.replace(FILE_NAME_FORBIDDEN_PATTERN, " ").replace(/\s+/gu, " ").trim(),
    FILE_NAME_MAX_LENGTH,
  )
    .replace(/^\.+|[. ]+$/gu, "")
    .replace(WINDOWS_RESERVED_NAME_PATTERN, "$1_");
  return `${base === "" ? "thread" : base}.md`;
}
