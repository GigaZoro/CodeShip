import type { MessageId } from "@t3tools/contracts";

// A request whose thread never showed lapses so a later plain open does not jump.
const PENDING_JUMP_MS = 30_000;
interface ThreadMessageJump {
  readonly messageId: MessageId;
  readonly starred: boolean;
}

let pending: (ThreadMessageJump & { readonly threadKey: string; readonly at: number }) | null =
  null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function requestThreadMessageJump(
  threadKey: string,
  messageId: MessageId,
  options?: { readonly starred: boolean },
): void {
  pending = { threadKey, messageId, starred: options?.starred ?? false, at: Date.now() };
  notify();
}

export function pendingThreadMessageJump(threadKey: string): ThreadMessageJump | null {
  return pending?.threadKey === threadKey && Date.now() - pending.at < PENDING_JUMP_MS
    ? pending
    : null;
}

export function canJumpToThreadMessage(
  jump: ThreadMessageJump,
  starredMessageIds: ReadonlyArray<MessageId>,
): boolean {
  return !jump.starred || starredMessageIds.includes(jump.messageId);
}

export function finishThreadMessageJump(threadKey: string): void {
  if (pending?.threadKey !== threadKey) return;
  pending = null;
  notify();
}

export function subscribeThreadMessageJump(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
