import type { MessageId } from "@t3tools/contracts";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { isAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";
import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

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
        prompt = marker;
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
  liveAssistantText: string | null = null,
): TimelineMinimapItem | null {
  if (item === null) return null;
  const assistantText = liveAssistantText ?? item.assistantText;
  return {
    ...item,
    userText: compactMinimapPreview(item.userText),
    // The tooltip shows three lines; bound parsing work while long responses stream.
    assistantText: compactMinimapPreview(
      assistantText === null
        ? null
        : markdownNodeText(markdownPreviewParser.parse(assistantText.slice(0, 1_500))),
    ),
  };
}
