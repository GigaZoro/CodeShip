import type { MessageId } from "@t3tools/contracts";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface RetryTarget {
  readonly assistantMessageId: MessageId;
  readonly userMessageId: MessageId;
  readonly turnCount: number;
}

/**
 * The newest reply, and the message it answers, when nothing was said after that reply and the
 * message can be rewound. Retry shows only there.
 */
export function deriveRetryTarget(rows: ReadonlyArray<MessagesTimelineRow>): RetryTarget | null {
  const lastMessage = rows.findLast((row) => row.kind === "message");
  if (lastMessage?.kind !== "message" || lastMessage.message.role !== "assistant") return null;
  if (lastMessage.message.streaming) return null;
  const lastUser = rows.findLast((row) => row.kind === "message" && row.message.role === "user");
  if (lastUser?.kind !== "message" || typeof lastUser.revertTurnCount !== "number") return null;
  return {
    assistantMessageId: lastMessage.message.id,
    userMessageId: lastUser.message.id,
    turnCount: lastUser.revertTurnCount,
  };
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
