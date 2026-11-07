import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { nextQueuedMessagePerThread, type QueuedThreadMessage } from "./threadOutboxStore";

function queued(id: string, threadId: string, failure: string | null = null): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make("zoro-pc"),
    threadId: ThreadId.make(threadId),
    commandId: CommandId.make(`command-${id}`),
    messageId: MessageId.make(id),
    text: id,
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-11-07T09:00:00.000Z",
    failure,
  };
}

describe("nextQueuedMessagePerThread", () => {
  it("sends each thread's oldest message and holds the rest until it settles", () => {
    const messages = [queued("a1", "a"), queued("b1", "b"), queued("a2", "a")];
    expect(nextQueuedMessagePerThread(messages, new Set()).map((m) => m.messageId)).toEqual([
      "a1",
      "b1",
    ]);
    expect(
      nextQueuedMessagePerThread(messages, new Set([MessageId.make("a1")])).map((m) => m.messageId),
    ).toEqual(["b1"]);
  });

  it("lets a refused message wait for the user without blocking the next one", () => {
    const messages = [queued("a1", "a", "Thread is archived"), queued("a2", "a")];
    expect(nextQueuedMessagePerThread(messages, new Set()).map((m) => m.messageId)).toEqual(["a2"]);
  });
});
