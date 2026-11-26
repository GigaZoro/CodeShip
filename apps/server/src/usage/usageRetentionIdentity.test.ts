import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import { describe, expect, it } from "@effect/vitest";
import { canRetainUsageRecord, makeUsageRetentionMatcher } from "./usageRetentionIdentity.ts";

function record(
  provider: UsageRecord["provider"],
  dedupeKey: UsageRecord["dedupeKey"],
  overrides: Partial<UsageRecord> = {},
): UsageRecord {
  return {
    provider,
    dedupeKey,
    timestampMs: Date.parse("2026-08-01T10:00:00Z"),
    sessionId: "session-1",
    model: "model-1",
    totals: {
      uncachedInputTokens: 1,
      cachedInputTokens: 2,
      cacheCreationTokens: 0,
      outputTokens: 3,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    speed: "standard",
    ...overrides,
  };
}

describe("usage retention identity", () => {
  it.each([
    ["message-1:", true],
    [":request-1", true],
    ["message-1:request-2", true],
    ["message-2:request-1", true],
    ["message-2:request-2", false],
    [null, true],
  ] as const)("compares Claude's two IDs against %s", (key, matches) => {
    const old = record("claude", "message-1:request-1");
    expect(makeUsageRetentionMatcher("claude", [record("claude", key)]).matches(old)).toBe(matches);
  });

  it("treats disjoint partial Claude IDs as ambiguous only within a possible shared session", () => {
    const old = record("claude", "message-1:");
    const current = record("claude", ":request-1");
    const otherSession = { ...current, sessionId: "other-session" };
    expect(makeUsageRetentionMatcher("claude", [current]).matches(old)).toBe(true);
    expect(makeUsageRetentionMatcher("claude", [otherSession]).matches(old)).toBe(false);
  });

  it("recognizes reordered Claude advisors without matching them to executor records", () => {
    const executor = record("claude", "message-1:request-1");
    const advisor = { ...executor, dedupeKey: "message-1:request-1:advisor:3" };
    const reordered = { ...advisor, dedupeKey: "message-1:request-1:advisor:1" };
    expect(makeUsageRetentionMatcher("claude", [executor, reordered]).matches(advisor)).toBe(true);
    expect(makeUsageRetentionMatcher("claude", [executor]).matches(advisor)).toBe(false);
  });

  it("matches a Pi entry after timestamp spelling and model change", () => {
    const old = record("pi", '["pi","entry","2026-08-01T10:00:00Z","requested"]');
    const current = record("pi", '["pi","entry","2026-08-01T10:00:00.000Z","response"]');
    const matcher = makeUsageRetentionMatcher("pi", [current]);
    expect(canRetainUsageRecord(old)).toBe(true);
    expect(matcher.matches(old)).toBe(true);
    expect(matcher.matches({ ...old, timestampMs: old.timestampMs + 1 })).toBe(false);
  });

  it("treats a Muse inference with a changed ID as ambiguous at the same session time", () => {
    const old = record("muse", '["muse","source-inference"]');
    const current = record("muse", '["muse","envelope"]');
    const matcher = makeUsageRetentionMatcher("muse", [current]);
    expect(canRetainUsageRecord(old)).toBe(true);
    expect(matcher.matches(old)).toBe(true);
    expect(matcher.matches({ ...old, timestampMs: old.timestampMs + 1 })).toBe(false);
  });

  it.each(["codex", "grok"] as const)("excludes %s keys from retention", (provider) => {
    expect(canRetainUsageRecord(record(provider, "session:prompt:model"))).toBe(false);
  });
});
