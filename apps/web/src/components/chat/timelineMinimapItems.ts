import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { isAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";
import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { isOrchestrationV2TerminalRunStatus } from "@t3tools/contracts";

import type { MessagesTimelineRow, TimelineLatestRun } from "./MessagesTimeline.logic";
import { t } from "~/i18n";

export interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

export function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message" || row.message.role !== "user") {
      continue;
    }

    items.push({
      id: row.id,
      rowIndex: index,
      userText: isAttachmentOnlyBootstrapPrompt(row.message.text) ? "" : row.message.text,
      assistantText: resolveFinalAssistantTextForTurn(rows, index),
    });
  }
  return items;
}

/** How the work a prompt started ended; null when it ended normally or left no run data. */
export type TimelinePromptOutcome = "running" | "stopped" | "failed";

export interface TimelinePromptTiming {
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly outcome: TimelinePromptOutcome | null;
}

const NO_PROMPT_TIMING: TimelinePromptTiming = {
  startedAt: null,
  completedAt: null,
  outcome: null,
};

function rowRunId(row: MessagesTimelineRow) {
  if (row.kind === "message") return row.message.runId;
  if (row.kind === "turn-fold" || row.kind === "attempt-fold") return row.runId;
  return null;
}

function rowEnd(row: MessagesTimelineRow): string | null {
  return row.kind === "message" ? row.message.updatedAt : row.createdAt;
}

/**
 * Timing for each prompt, from rows the timeline already has: the latest run's own times when it
 * belongs to the last prompt, else the span from the prompt to the last row before the next one.
 */
export function deriveTimelinePromptTimings(
  rows: ReadonlyArray<MessagesTimelineRow>,
  items: ReadonlyArray<Pick<TimelineMinimapItem, "rowIndex">>,
  latestRun: TimelineLatestRun | null,
): TimelinePromptTiming[] {
  return items.map((item, position) => {
    const prompt = rows[item.rowIndex];
    if (prompt?.kind !== "message") return NO_PROMPT_TIMING;
    const startedAt = prompt.message.createdAt;
    const end = items[position + 1]?.rowIndex ?? rows.length;
    const following = rows.slice(item.rowIndex + 1, end);

    const isLatest = position === items.length - 1;
    if (
      isLatest &&
      latestRun !== null &&
      (prompt.message.runId === latestRun.runId ||
        following.some((row) => rowRunId(row) === latestRun.runId))
    ) {
      const outcome: TimelinePromptOutcome | null = !isOrchestrationV2TerminalRunStatus(
        latestRun.status,
      )
        ? "running"
        : latestRun.status === "failed"
          ? "failed"
          : latestRun.status === "completed"
            ? null
            : "stopped";
      return {
        startedAt: latestRun.startedAt ?? startedAt,
        completedAt: outcome === "running" ? null : latestRun.completedAt,
        outcome,
      };
    }

    let completedAt: string | null = null;
    let stopped = false;
    for (const row of following) {
      const rowEndAt = row.kind === "working" || row.kind === "thinking" ? null : rowEnd(row);
      if (
        rowEndAt !== null &&
        (completedAt === null || Date.parse(rowEndAt) > Date.parse(completedAt))
      ) {
        completedAt = rowEndAt;
      }
      if (
        row.kind === "event" &&
        (row.projectedItem.item.type === "run_interrupt_request" ||
          row.projectedItem.item.type === "run_interrupt_result")
      ) {
        stopped = true;
      }
    }
    if (completedAt === null || !(Date.parse(completedAt) >= Date.parse(startedAt))) {
      return NO_PROMPT_TIMING;
    }
    return { startedAt, completedAt, outcome: stopped ? "stopped" : null };
  });
}

function resolveFinalAssistantTextForTurn(
  rows: ReadonlyArray<MessagesTimelineRow>,
  userRowIndex: number,
) {
  let finalAssistantText: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") {
      continue;
    }
    if (row.message.role === "user") {
      break;
    }
    if (row.message.role === "assistant") {
      finalAssistantText = row.message.text ?? null;
    }
  }
  return finalAssistantText;
}

const markdownPreviewParser = unified().use(remarkParse).use(remarkGfm).freeze();

const INLINE_PARENT_TYPES = new Set<Nodes["type"]>([
  "paragraph",
  "heading",
  "tableCell",
  "emphasis",
  "strong",
  "delete",
  "link",
  "linkReference",
]);

function markdownNodeText(node: Nodes): string {
  if (node.type === "html") {
    return node.value
      .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
      .replace(/<\/?([a-z][\w-]*)(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, (_, tag: string) =>
        /^(?:address|article|aside|blockquote|br|dd|details|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|th|thead|tr|ul)$/i.test(
          tag,
        )
          ? " "
          : "",
      );
  }
  if (node.type === "break") return " ";
  if ("value" in node) return node.value;
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if (!("children" in node)) return "";
  const separator = INLINE_PARENT_TYPES.has(node.type) ? "" : " ";
  const text = node.children.map(markdownNodeText).join(separator);
  // A thread autolink's only text is its URL.
  return node.type === "link" && parseThreadLinkHref(text) !== null ? t("a thread") : text;
}

function compactMinimapPreview(text: string | null | undefined) {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
}

export function resolveTimelineMinimapPreview(
  item: TimelineMinimapItem | null,
): TimelineMinimapItem | null {
  return item === null
    ? null
    : {
        ...item,
        userText: compactMinimapPreview(item.userText),
        // The tooltip shows three lines; bound parsing work while long responses stream.
        assistantText: compactMinimapPreview(
          item.assistantText === null
            ? null
            : markdownNodeText(markdownPreviewParser.parse(item.assistantText.slice(0, 1_500))),
        ),
      };
}
