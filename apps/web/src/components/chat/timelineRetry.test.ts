import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { deriveRetryTarget, markRetryRewind, takeRetryRewind } from "./timelineRetry";

const row = (
  id: string,
  role: "user" | "assistant",
  extra: { revertTurnCount?: number; streaming?: boolean } = {},
) =>
  ({
    kind: "message",
    id,
    message: { id: MessageId.make(id), role, streaming: extra.streaming },
    revertTurnCount: extra.revertTurnCount,
  }) as unknown as MessagesTimelineRow;

describe("deriveRetryTarget", () => {
  it("targets the newest reply and the message it answers", () => {
    expect(
      deriveRetryTarget([
        row("u1", "user", { revertTurnCount: 0 }),
        row("a1", "assistant"),
        row("u2", "user", { revertTurnCount: 1 }),
        row("a2", "assistant"),
      ]),
    ).toEqual({
      assistantMessageId: "a2",
      userMessageId: "u2",
      turnCount: 1,
    });
  });

  it.each([
    [
      "the last message is yours",
      [row("a1", "assistant"), row("u1", "user", { revertTurnCount: 0 })],
    ],
    [
      "the reply is still streaming",
      [row("u1", "user", { revertTurnCount: 0 }), row("a1", "assistant", { streaming: true })],
    ],
    ["the message cannot be rewound", [row("u1", "user"), row("a1", "assistant")]],
  ])("offers nothing when %s", (_, rows) => {
    expect(deriveRetryTarget(rows)).toBeNull();
  });
});

describe("retry rewind intent", () => {
  it("applies once to the message it was set for", () => {
    markRetryRewind(MessageId.make("u1"));
    expect(takeRetryRewind(MessageId.make("u2"))).toBe(false);
    markRetryRewind(MessageId.make("u1"));
    expect(takeRetryRewind(MessageId.make("u1"))).toBe(true);
    expect(takeRetryRewind(MessageId.make("u1"))).toBe(false);
  });
});
