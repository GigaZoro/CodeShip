import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  formatComposerContextReference,
  toComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { makeStreamingTimelineFixture } from "../../test-fixtures";

import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import { deriveTimelineMinimapItems, resolveTimelineMinimapPreview } from "./timelineMinimapItems";

describe("deriveTimelineMinimapItems", () => {
  it("marks loaded starred prompts and replies at their visible rows or fold", () => {
    const at = "2026-10-01T00:00:00Z";
    const promptId = MessageId.make("prompt");
    const foldedId = MessageId.make("folded");
    const replyId = MessageId.make("reply");
    const unstarredId = MessageId.make("unstarred");
    const earlierId = MessageId.make("earlier");
    const timelineEntries = [promptId, foldedId, unstarredId, replyId].map((id, index) => ({
      kind: "message" as const,
      id: `entry:${id}`,
      createdAt: at,
      message: {
        id,
        role: index === 0 ? ("user" as const) : ("assistant" as const),
        text: String(id),
        runId: null,
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
    }));
    const input = {
      timelineEntries,
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };
    const starredIds = [earlierId, replyId, promptId, foldedId];
    const rows = deriveMessagesTimelineRows(input);
    const items = deriveTimelineMinimapItems(rows, starredIds);

    expect(items.map((item) => [item.starredMessageId, rows[item.rowIndex]?.kind])).toEqual([
      [promptId, "message"],
      [foldedId, "turn-fold"],
      [replyId, "message"],
    ]);
    expect(items.map((item) => item.assistantText)).toEqual(["reply", "folded", "reply"]);

    const fold = rows.find((row) => row.kind === "turn-fold");
    if (!fold) throw new Error("Expected a turn fold");
    const expandedRows = deriveMessagesTimelineRows({
      ...input,
      expandedRunIds: new Set([fold.runId]),
    });
    const expanded = deriveTimelineMinimapItems(expandedRows, starredIds);
    expect(
      expanded.map((item) => [item.starredMessageId, expandedRows[item.rowIndex]?.id]),
    ).toEqual([
      [promptId, `entry:${promptId}`],
      [foldedId, `entry:${foldedId}`],
      [replyId, `entry:${replyId}`],
    ]);
  });

  it.each(["", "Ultrathink:\n"])(
    "omits bootstrap text from the minimap label and tooltip (%j)",
    (prefix) => {
      const at = "2026-10-01T00:00:00Z";
      const items = deriveTimelineMinimapItems(
        [
          {
            kind: "message",
            id: "image-only",
            createdAt: at,
            showAssistantMeta: false,
            showAssistantCopyButton: false,
            assistantCopyStreaming: false,
            message: {
              id: MessageId.make("image-only"),
              role: "user",
              text: prefix + ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
              runId: null,
              streaming: false,
              createdAt: at,
              updatedAt: at,
            },
          },
        ],
        [],
      );
      expect(items).toEqual([
        {
          id: "image-only",
          rowIndex: 0,
          role: "user",
          starredMessageId: null,
          userText: "",
          assistantText: null,
        },
      ]);
      expect(resolveTimelineMinimapPreview(items[0]!)?.userText).toBeNull();
    },
  );

  it("skips automatic server continuation rows and pairs the continued reply with the real prompt", () => {
    const at = "2026-10-01T00:00:00Z";
    const items = deriveTimelineMinimapItems(
      [
        {
          kind: "message",
          id: "entry:user-1",
          createdAt: at,
          showAssistantMeta: false,
          showAssistantCopyButton: false,
          assistantCopyStreaming: false,
          message: {
            id: MessageId.make("user-1"),
            role: "user",
            createdBy: "user",
            creationSource: "web",
            text: "Finish the migration",
            runId: null,
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        },
        {
          kind: "message",
          id: "entry:limit-failover:run-1",
          createdAt: at,
          showAssistantMeta: false,
          showAssistantCopyButton: false,
          assistantCopyStreaming: false,
          message: {
            id: MessageId.make("limit-failover:run-1"),
            role: "user",
            createdBy: "user",
            creationSource: "server",
            text: "Continue where you left off.",
            runId: null,
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        },
        {
          kind: "message",
          id: "entry:reply-1",
          createdAt: at,
          showAssistantMeta: true,
          showAssistantCopyButton: true,
          assistantCopyStreaming: false,
          message: {
            id: MessageId.make("reply-1"),
            role: "assistant",
            text: "Migration finished.",
            runId: null,
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        },
        {
          kind: "message",
          id: "entry:user-2",
          createdAt: at,
          showAssistantMeta: false,
          showAssistantCopyButton: false,
          assistantCopyStreaming: false,
          message: {
            id: MessageId.make("user-2"),
            role: "user",
            createdBy: "user",
            creationSource: "web",
            text: "Continue where you left off.",
            runId: null,
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        },
      ],
      [],
    );
    expect(items).toEqual([
      {
        id: "entry:user-1",
        rowIndex: 0,
        role: "user",
        starredMessageId: null,
        userText: "Finish the migration",
        assistantText: "Migration finished.",
      },
      {
        id: "entry:user-2",
        rowIndex: 3,
        role: "user",
        starredMessageId: null,
        userText: "Continue where you left off.",
        assistantText: null,
      },
    ]);
  });
});

describe("resolveTimelineMinimapPreview", () => {
  it("previews the selected streaming reply using its turn item ID", () => {
    const { visibleTurnItems } = makeStreamingTimelineFixture();
    const rows = deriveMessagesTimelineRows({
      timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems,
        optimisticMessages: [],
      }),
      isWorking: true,
      supportsConversationRollback: false,
      turnDiffSummaries: [],
    });
    const id = MessageId.make("live-assistant");
    const bookmark = deriveTimelineMinimapItems(rows, [id]).find(
      (item) => item.starredMessageId === id,
    );
    expect(bookmark).toMatchObject({ streamingItemId: "live-assistant-item" });
    expect(resolveTimelineMinimapPreview(bookmark!, "Here is the **answer**.")?.assistantText).toBe(
      "Here is the answer.",
    );
  });

  it("previews a thread autolink as prose, not its URL", () => {
    const preview = resolveTimelineMinimapPreview({
      id: "turn-1",
      rowIndex: 0,
      role: "user",
      starredMessageId: null,
      userText: null,
      assistantText:
        "Started <t3-thread://v2/env-1/thread-1> and [Fix CI](t3-thread://v2/env-1/t2).",
    });
    expect(preview?.assistantText).toBe("Started a thread and Fix CI.");
  });

  it("previews a quote, a context chip and a file link in the user's message as their text", () => {
    const quote = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      messageId: MessageId.make("assistant-1"),
      text: "The cache misses on a cold start.",
      start: 0,
      end: 33,
      prefix: "",
      suffix: "",
    });
    const file = formatComposerContextReference({
      kind: "file",
      contextId: toComposerContextId("readme"),
      label: "README.md",
    });
    const preview = resolveTimelineMinimapPreview({
      id: "turn-1",
      rowIndex: 0,
      role: "user",
      starredMessageId: null,
      userText: `${quote}\nWhere do ${file} and [math.ts](src/math.ts) cover this?`,
      assistantText: null,
    });
    expect(preview?.userText).toBe(
      "The cache misses on a cold start. Where do README.md and math.ts cover this?",
    );
  });

  it("does not split a surrogate pair at the preview slice boundary", () => {
    const linkStart = "[Build log](https://example.com/builds/1042/log?sig=";
    const linkEnd = ") ";
    const pad = "a".repeat(1_499 - linkStart.length - linkEnd.length);
    const preview = resolveTimelineMinimapPreview({
      id: "turn-1",
      rowIndex: 0,
      role: "user",
      starredMessageId: null,
      userText: `${linkStart}${pad}${linkEnd}🎉 the release build passed`,
      assistantText: null,
    });
    expect(preview?.userText).toBe("Build log");
  });
});
