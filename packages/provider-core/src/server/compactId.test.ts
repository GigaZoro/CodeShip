import { ProviderDriverKind, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { compactLegacyId, compactLegacyIdsInJson, encodeIdPart } from "./compactId.ts";
import { derive } from "./IdAllocator.ts";

const legacyJoin = (prefix: string, ...parts: ReadonlyArray<string | number>) =>
  [prefix, ...parts.map((part) => encodeURIComponent(String(part)))].join(":");

describe("compact ids", () => {
  it("embedding an id adds its length instead of multiplying it", () => {
    const threadId = ThreadId.make("mcp:launch:abc");
    const runId = derive.run({ threadId, ordinal: 1 });
    const attemptId = derive.runAttempt({ runId, attemptOrdinal: 1 });
    const turn = derive.providerTurn({
      driver: ProviderDriverKind.make("claudeAgent"),
      nativeTurnId: `turn:run-attempt:${attemptId}`,
    });
    expect(turn.length).toBeLessThan(2 * (runId.length + attemptId.length));
    expect(encodeIdPart(encodeIdPart("a b:c"))).toBe(encodeIdPart("a b:c"));
  });

  it("converts a legacy id to what the new derivation produces for the same inputs", () => {
    const threadId = "mcp:launch:abc";
    const legacyRun = legacyJoin("run", "thread", threadId, "ordinal", 2);
    const legacyAttempt = legacyJoin("run-attempt", "run", legacyRun, "attempt", 1);
    const legacyRoot = legacyJoin("node", "run", legacyAttempt, "root");
    const runId = derive.run({ threadId: ThreadId.make(threadId), ordinal: 2 });
    const attemptId = derive.runAttempt({ runId, attemptOrdinal: 1 });
    expect(compactLegacyId(legacyRun)).toBe(runId);
    expect(compactLegacyId(legacyAttempt)).toBe(attemptId);
    expect(compactLegacyId(legacyRoot)).toBe(derive.rootNode({ runId: RunId.make(attemptId) }));
  });

  it("leaves thread ids, other strings and escaped quotes inside text alone", () => {
    const thread = "thread:provider:codex:native-thread:a%3Ab";
    expect(compactLegacyId(thread)).toBe(thread);
    const json = JSON.stringify({ text: 'say "node:x%3Ay" now', id: "node:x%3Ay" });
    expect(JSON.parse(compactLegacyIdsInJson(json))).toEqual({
      text: 'say "node:x%3Ay" now',
      id: "node:x:y",
    });
  });
});
