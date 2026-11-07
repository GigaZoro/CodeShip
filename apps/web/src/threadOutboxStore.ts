import {
  CommandId,
  EnvironmentId,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

const QueuedThreadMessage = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  /** Fixed at queue time, so a resend after a lost reply is the same command to the server. */
  commandId: CommandId,
  messageId: MessageId,
  text: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdAt: Schema.String,
  /** Why the machine refused it; such a message waits for the user, not for a reconnect. */
  failure: Schema.NullOr(Schema.String),
});
export type QueuedThreadMessage = typeof QueuedThreadMessage.Type;

const isQueuedThreadMessage = Schema.is(QueuedThreadMessage);

interface ThreadOutboxState {
  readonly messages: ReadonlyArray<QueuedThreadMessage>;
  readonly enqueue: (message: Omit<QueuedThreadMessage, "failure">) => void;
  readonly remove: (messageId: MessageId) => void;
  readonly markFailed: (messageId: MessageId, failure: string) => void;
}

/**
 * Messages written to a thread while its machine was unreachable. They live in this browser
 * until the machine reconnects, then send in the order they were written.
 */
export const useThreadOutboxStore = create<ThreadOutboxState>()(
  persist(
    (set) => ({
      messages: [],
      enqueue: (message) =>
        set((state) => ({ messages: [...state.messages, { ...message, failure: null }] })),
      remove: (messageId) =>
        set((state) => ({
          messages: state.messages.filter((message) => message.messageId !== messageId),
        })),
      markFailed: (messageId, failure) =>
        set((state) => ({
          messages: state.messages.map((message) =>
            message.messageId === messageId ? { ...message, failure } : message,
          ),
        })),
    }),
    {
      name: "t3code:thread-outbox:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      partialize: (state) => ({ messages: state.messages }),
      merge: (persisted, current) => {
        const messages = (persisted as { messages?: unknown } | null)?.messages;
        return {
          ...current,
          messages: Array.isArray(messages) ? messages.filter(isQueuedThreadMessage) : [],
        };
      },
    },
  ),
);

/**
 * The message each thread may send next: its oldest one not refused by the machine. A thread
 * with a send in flight sends nothing more until that one settles, so messages keep their order.
 */
export function nextQueuedMessagePerThread(
  messages: ReadonlyArray<QueuedThreadMessage>,
  inFlight: ReadonlySet<MessageId>,
): ReadonlyArray<QueuedThreadMessage> {
  const decided = new Set<string>();
  const next: QueuedThreadMessage[] = [];
  for (const message of messages) {
    if (message.failure !== null) continue;
    const key = `${message.environmentId}\u0000${message.threadId}`;
    if (decided.has(key)) continue;
    decided.add(key);
    if (!inFlight.has(message.messageId)) next.push(message);
  }
  return next;
}
