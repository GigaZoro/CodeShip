import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { markRetryRewind, takeRetryRewind } from "./timelineRetry";

describe("retry rewind intent", () => {
  it("applies once to the message it was set for", () => {
    markRetryRewind(MessageId.make("u1"));
    expect(takeRetryRewind(MessageId.make("u2"))).toBe(false);
    markRetryRewind(MessageId.make("u1"));
    expect(takeRetryRewind(MessageId.make("u1"))).toBe(true);
    expect(takeRetryRewind(MessageId.make("u1"))).toBe(false);
  });
});
