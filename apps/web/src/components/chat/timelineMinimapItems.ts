import type { MessageId } from "@t3tools/contracts";
import {
  assistantCitationsToPlainText,
  splitsSurrogatePair,
} from "@t3tools/shared/assistantCitations";
import { isAutomaticServerContinuationMessage } from "@t3tools/client-runtime/user-message";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import type { Nodes } from "hast";

import { markdownTree } from "~/markdown/wordsHast";

import type { ChatMessage } from "../../types";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { t } from "~/i18n";

export interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly role: "user" | "assistant";
  readonly starredMessageId: MessageId | null;
  readonly streamingItemId?: string | undefined;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

export function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
  starredIds: ReadonlyArray<MessageId>,
): TimelineMinimapItem[] {
  const starred = new Set(starredIds);
  const items: TimelineMinimapItem[] = [];
  const addMessage = (
    message: ChatMessage,
    id: string,
    rowIndex: number,
    streamingItemId?: string,
  ) => {
    if (message.role !== "user" && message.role !== "assistant") return;
    const starredMessageId = starred.has(message.id) ? message.id : null;
    if (message.role === "assistant" && starredMessageId === null) return;
    if (
      message.role === "user" &&
      starredMessageId === null &&
      isAutomaticServerContinuationMessage(message)
    ) {
      return;
    }
    const item = {
      id,
      rowIndex,
      role: message.role,
      starredMessageId,
      streamingItemId,
      userText:
        message.role === "assistant"
          ? null
          : isAttachmentOnlyBootstrapPrompt(message.text)
            ? ""
            : message.text,
      assistantText: message.role === "assistant" ? message.text : null,
    };
    items.push(item);
    return item;
  };
  let prompt: ReturnType<typeof addMessage>;
  for (const [index, row] of rows.entries()) {
    if (row.kind === "message") {
      const streamingItemId =
        row.message.role === "assistant" && row.message.streaming
          ? row.projectedItem?.item.id
          : undefined;
      const marker = addMessage(row.message, row.id, index, streamingItemId);
      if (row.message.role === "user") {
        if (marker !== undefined) {
          prompt = marker;
        }
      } else if (row.message.role === "assistant" && prompt) {
        prompt.assistantText = row.message.text;
        prompt.streamingItemId = streamingItemId;
      }
    } else if (starred.size > 0 && (row.kind === "turn-fold" || row.kind === "attempt-fold")) {
      for (const message of row.hiddenMessages ?? []) {
        if (starred.has(message.id)) addMessage(message, `star:${message.id}`, index);
      }
    }
  }
  return items;
}

// Elements whose children run together; every other element is separated by a space.
const INLINE_PARENTS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "td",
  "th",
  "em",
  "strong",
  "del",
  "a",
  "code",
  "span",
  "sup",
  "sub",
]);

function markdownNodeText(node: Nodes): string {
  if (node.type === "text") return node.value;
  if (node.type === "element" && node.tagName === "br") return " ";
  if (node.type === "element" && node.tagName === "img") return String(node.properties.alt ?? "");
  if (node.type !== "element" && node.type !== "root") return "";
  const separator = node.type === "element" && INLINE_PARENTS.has(node.tagName) ? "" : " ";
  const text = node.children.map(markdownNodeText).join(separator);
  // A thread autolink's only text is its URL.
  return node.type === "element" && node.tagName === "a" && parseThreadLinkHref(text) !== null
    ? t("a thread")
    : text;
}

/** Markdown as one line of the text it renders, without markup or link targets. */
export function markdownPlainText(markdown: string): string {
  return markdownNodeText(markdownTree(markdown)).replace(/\s+/g, " ").trim();
}

// The tooltip shows a few lines; bound parsing work for long messages and streaming responses.
function markdownMinimapPreview(markdown: string | null) {
  if (markdown === null) return null;
  const compact = markdownPlainText(
    markdown.slice(0, splitsSurrogatePair(markdown, 1_500) ? 1_499 : 1_500),
  );
  return compact.length > 0 ? compact : null;
}

export function resolveTimelineMinimapPreview(
  item: TimelineMinimapItem | null,
  liveAssistantText: string | null = null,
): TimelineMinimapItem | null {
  if (item === null) return null;
  const assistantText = liveAssistantText ?? item.assistantText;
  return {
    ...item,
    // Before markdown parsing, which would reduce a citation link to "Assistant quote".
    userText: markdownMinimapPreview(
      item.userText === null
        ? null
        : assistantCitationsToPlainText(
            replaceComposerContextReferences(item.userText, (reference) => reference.label),
          ),
    ),
    assistantText: markdownMinimapPreview(assistantText),
  };
}
