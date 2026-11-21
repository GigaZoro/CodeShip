import { describe, expect, it } from "vite-plus/test";
import { MessageId, RunId } from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";

import type { MessagesTimelineRow, TimelineLatestRun } from "./MessagesTimeline.logic";
import {
  deriveTimelineMinimapItems,
  deriveTimelinePromptTimings,
  resolveTimelineMinimapPreview,
} from "./timelineMinimapItems";

describe("deriveTimelineMinimapItems", () => {
  it.each(["", "Ultrathink:\n"])(
    "omits bootstrap text from the minimap label and tooltip (%j)",
    (prefix) => {
      const at = "2026-10-01T00:00:00Z";
      const items = deriveTimelineMinimapItems([
        {
          kind: "message",
          id: "image-only",
          createdAt: at,
          showAssistantMeta: false,
          showAssistantTimestamp: false,
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
      ]);
      expect(items).toEqual([{ id: "image-only", rowIndex: 0, userText: "", assistantText: null }]);
      expect(resolveTimelineMinimapPreview(items[0]!)?.userText).toBeNull();
    },
  );
});

describe("resolveTimelineMinimapPreview", () => {
  it("previews a thread autolink as prose, not its URL", () => {
    const preview = resolveTimelineMinimapPreview({
      id: "turn-1",
      rowIndex: 0,
      userText: null,
      assistantText:
        "Started <t3-thread://v2/env-1/thread-1> and [Fix CI](t3-thread://v2/env-1/t2).",
    });
    expect(preview?.assistantText).toBe("Started a thread and Fix CI.");
  });
});

describe("deriveTimelinePromptTimings", () => {
  const message = (
    id: string,
    role: "user" | "assistant",
    createdAt: string,
    updatedAt: string = createdAt,
    runId: string | null = null,
  ): MessagesTimelineRow => ({
    kind: "message",
    id,
    createdAt,
    showAssistantMeta: false,
    showAssistantTimestamp: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
    message: {
      id: MessageId.make(id),
      role,
      text: id,
      runId: runId === null ? null : RunId.make(runId),
      streaming: false,
      createdAt,
      updatedAt,
    },
  });
  const run = (status: TimelineLatestRun["status"], completedAt: string | null) =>
    ({
      runId: RunId.make("run-2"),
      status,
      startedAt: "2026-10-01T00:10:00Z",
      completedAt,
    }) as TimelineLatestRun;
  const rows = [
    message("p1", "user", "2026-10-01T00:00:00Z"),
    message("a1", "assistant", "2026-10-01T00:00:10Z", "2026-10-01T00:00:45Z"),
    message("p2", "user", "2026-10-01T00:09:58Z", undefined, "run-2"),
  ];
  const items = [{ rowIndex: 0 }, { rowIndex: 2 }];

  it.each([
    [
      "older prompt spans to its last row",
      null,
      0,
      "2026-10-01T00:00:00Z",
      "2026-10-01T00:00:45Z",
      null,
    ],
    [
      "running latest run has no end",
      run("running", null),
      1,
      "2026-10-01T00:10:00Z",
      null,
      "running",
    ],
    [
      "completed latest run",
      run("completed", "2026-10-01T00:12:00Z"),
      1,
      "2026-10-01T00:10:00Z",
      "2026-10-01T00:12:00Z",
      null,
    ],
    [
      "interrupted latest run",
      run("interrupted", "2026-10-01T00:11:00Z"),
      1,
      "2026-10-01T00:10:00Z",
      "2026-10-01T00:11:00Z",
      "stopped",
    ],
    [
      "failed latest run",
      run("failed", "2026-10-01T00:11:00Z"),
      1,
      "2026-10-01T00:10:00Z",
      "2026-10-01T00:11:00Z",
      "failed",
    ],
    ["prompt without a reply shows nothing", null, 1, null, null, null],
  ] as const)("%s", (_name, latestRun, index, startedAt, completedAt, outcome) => {
    expect(deriveTimelinePromptTimings(rows, items, latestRun)[index]).toEqual({
      startedAt,
      completedAt,
      outcome,
    });
  });
});
