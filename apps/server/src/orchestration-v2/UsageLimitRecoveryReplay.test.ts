import { describe, expect, it } from "vite-plus/test";
import { replayUsageLimitRecovery } from "./UsageLimitRecoveryReplay.ts";

describe("usage-limit recovery replay", () => {
  const decision = { sourceKey: "stop", requestKey: "original", selectedKey: "B" };
  const completed = {
    ...decision,
    attemptKey: "attempt",
    status: "completed" as const,
    consumedTokens: 900,
  };
  const unknown = { classification: "unknown", attributableLostTokens: null };
  it("counts an attempt only with the exact recovery lineage", () => {
    for (const status of ["completed", "failed"] as const) {
      for (const receipt of [
        { ...completed, status, requestKey: "changed" },
        { ...completed, status, requestKey: null },
        { ...completed, status, sourceKey: "another-stop" },
        { ...completed, status, selectedKey: "A" },
        { ...completed, status, attemptKey: "" },
      ]) {
        expect(replayUsageLimitRecovery(decision, [receipt])).toEqual(unknown);
      }
    }
    for (const missing of [{ requestKey: null }, { sourceKey: "" }, { selectedKey: null }]) {
      expect(
        replayUsageLimitRecovery({ ...decision, ...missing }, [{ ...completed, ...missing }]),
      ).toEqual(unknown);
    }
  });
  it("counts only failed attempts as failed, never ended or unfinished ones", () => {
    for (const status of [
      "pending",
      "running",
      "cancelled",
      "superseded",
      "interrupted",
    ] as const) {
      expect(replayUsageLimitRecovery(decision, [{ ...completed, status }])).toEqual(unknown);
    }
  });
  it("replays retries idempotently, including a success after a failed attempt", () => {
    const failed = { ...completed, attemptKey: "first", status: "failed" as const };
    expect(replayUsageLimitRecovery(decision, [failed, failed]).classification).toBe(
      "failed_attempt",
    );
    for (const receipts of [
      [failed, completed, completed],
      [completed, failed],
    ]) {
      expect(replayUsageLimitRecovery(decision, receipts)).toEqual({
        classification: "recovered",
        attributableLostTokens: null,
      });
    }
  });
});
