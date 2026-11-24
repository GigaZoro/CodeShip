import { MessageId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  canJumpToThreadMessage,
  finishThreadMessageJump,
  pendingThreadMessageJump,
  requestThreadMessageJump,
} from "./threadMessageJump";

describe("threadMessageJump", () => {
  it("lets a jump lapse when its thread never showed", () => {
    using now = vi.spyOn(Date, "now").mockReturnValue(0);
    requestThreadMessageJump("thread-a", MessageId.make("message-1"));
    expect(pendingThreadMessageJump("thread-a")?.messageId).toBe("message-1");
    expect(pendingThreadMessageJump("thread-b")).toBeNull();
    now.mockReturnValue(30_000);
    expect(pendingThreadMessageJump("thread-a")).toBeNull();
  });

  it("checks current stars only for jumps from the starred list", () => {
    const threadKey = "thread-b";
    const messageId = MessageId.make("message-1");
    try {
      requestThreadMessageJump(threadKey, messageId, { starred: true });
      const starredJump = pendingThreadMessageJump(threadKey)!;
      expect(canJumpToThreadMessage(starredJump, [messageId])).toBe(true);
      expect(canJumpToThreadMessage(starredJump, [])).toBe(false);

      requestThreadMessageJump(threadKey, messageId);
      expect(canJumpToThreadMessage(pendingThreadMessageJump(threadKey)!, [])).toBe(true);
    } finally {
      finishThreadMessageJump(threadKey);
    }
  });
});
