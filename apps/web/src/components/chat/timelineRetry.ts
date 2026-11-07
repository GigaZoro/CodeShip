import {
  deriveRetryTarget as deriveMessagesRetryTarget,
  type RetryTarget,
} from "@t3tools/client-runtime/state/thread-rewind";
import type { MessageId } from "@t3tools/contracts";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export type { RetryTarget };

/** The timeline's retry target; user rows carry the turn count their rewind restores. */
export function deriveRetryTarget(
  rows: ReadonlyArray<MessagesTimelineRow>,
  previous: RetryTarget | null = null,
): RetryTarget | null {
  const messages: Array<Extract<MessagesTimelineRow, { kind: "message" }>["message"]> = [];
  const turnCounts = new Map<MessageId, number>();
  for (const row of rows) {
    if (row.kind !== "message") continue;
    messages.push(row.message);
    if (typeof row.revertTurnCount === "number")
      turnCounts.set(row.message.id, row.revertTurnCount);
  }
  return deriveMessagesRetryTarget(messages, turnCounts, previous);
}

// Set by the Retry button just before it asks to rewind; the rewind consumes it and resends the
// restored message. The confirmation dialog re-sets it when the turn changed files.
let pendingRetryMessageId: MessageId | null = null;

export function markRetryRewind(messageId: MessageId): void {
  pendingRetryMessageId = messageId;
}

export function takeRetryRewind(messageId: MessageId): boolean {
  const matches = pendingRetryMessageId === messageId;
  pendingRetryMessageId = null;
  return matches;
}
