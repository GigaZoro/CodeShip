import { MessageId, NodeId, ProviderDriverKind, ThreadId, TurnItemId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { makeAssistantStreamingFilter, splitBufferedAssistantText } from "./assistantStreaming.ts";

const streamingAssistantText = (
  text: string,
  streaming = true,
): ProviderAdapter.ProviderAdapterV2Event => {
  const now = DateTime.makeUnsafe("2026-11-27T12:00:00.000Z");
  return {
    type: "turn_item.updated",
    driver: ProviderDriverKind.make("codex"),
    turnItem: {
      id: TurnItemId.make("turn-item:streaming-filter"),
      threadId: ThreadId.make("thread:streaming-filter"),
      runId: null,
      nodeId: NodeId.make("node:streaming-filter"),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "assistant_message",
      messageId: MessageId.make("message:streaming-filter"),
      text,
      streaming,
    },
  } as ProviderAdapter.ProviderAdapterV2Event;
};

const textOf = (event: ProviderAdapter.ProviderAdapterV2Event | null | undefined) =>
  event?.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
    ? event.turnItem.text
    : undefined;

describe("V2 assistant streaming", () => {
  it("keeps code fences intact", () => {
    expect(splitBufferedAssistantText("Intro\n\n```ts\nx()\n\n")).toEqual({
      ready: "Intro\n\n",
      rest: "```ts\nx()\n\n",
    });
    expect(splitBufferedAssistantText("```ts\nx()\n```\nrest")).toEqual({
      ready: "```ts\nx()\n```\n",
      rest: "rest",
    });
  });
});

it("holds a streamed section heading until its content has a boundary", () => {
  expect(splitBufferedAssistantText("Intro\n\n## Results\n\n")).toEqual({
    ready: "Intro\n\n",
    rest: "## Results\n\n",
  });
  expect(splitBufferedAssistantText("**Results**\n\nBody\n\nNext")).toEqual({
    ready: "**Results**\n\nBody\n\n",
    rest: "Next",
  });
});

describe.each(["paragraph", "turn"] as const)("the %s streaming filter", (mode) => {
  it("hands over the text it held back in full when flushed", () => {
    const filter = makeAssistantStreamingFilter(mode);
    const event = streamingAssistantText("First paragraph.\n\nAn unfinished tail");
    expect(textOf(filter(event, 0))).toBe(
      mode === "paragraph" ? "First paragraph.\n\n" : undefined,
    );
    expect(filter.flushHeld(1).map(textOf)).toEqual(["First paragraph.\n\nAn unfinished tail"]);
    expect(filter.flushHeld(2)).toEqual([]);
  });

  it("holds nothing once the message ends", () => {
    const filter = makeAssistantStreamingFilter(mode);
    filter(streamingAssistantText("First paragraph.\n\nAn unfinished tail"), 0);
    filter(streamingAssistantText("First paragraph.\n\nA finished tail.", false), 1);
    expect(filter.flushHeld(2)).toEqual([]);
  });
});
