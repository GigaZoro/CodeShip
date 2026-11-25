import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { GuestRedeemRequest, GuestShareCreateInput, ThreadGuestShare } from "./guestShare.ts";

const isRedeem = Schema.is(GuestRedeemRequest);
const decodeShare = Schema.decodeSync(ThreadGuestShare);
const decodeCreateInput = Schema.decodeSync(GuestShareCreateInput);

describe("guest share access", () => {
  it("keeps links and requests from before access levels waiting for the owner", () => {
    const share = decodeShare({
      id: "share-1",
      host: "host.example",
      createdAt: "2026-11-25T10:00:00.000Z",
      expiresAt: "2026-11-26T10:00:00.000Z",
      guestName: null,
      messages: [],
    });
    const input = decodeCreateInput({ threadId: "thread-1" });

    expect(share.access).toBe("approve");
    expect(input).toEqual({ threadId: "thread-1", access: "approve", lifetime: "1d" });
  });
});

describe("GuestRedeemRequest", () => {
  it("accepts a one-line name and rejects names that break the attribution line", () => {
    expect(isRedeem({ credential: "invite", name: "Maya Chen" })).toBe(true);
    for (const name of [
      "Maya\nowner",
      "Maya owner",
      "Maya owner",
      "Maya\u0007",
      "Theo\u202E (owner)",
      "Theo\u2066x",
    ]) {
      expect(isRedeem({ credential: "invite", name })).toBe(false);
    }
  });
});
