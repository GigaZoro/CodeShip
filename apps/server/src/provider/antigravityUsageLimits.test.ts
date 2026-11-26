import { describe, expect, it } from "@effect/vitest";
import type { AcpSessionRuntimeEvent } from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { parseAntigravityUsageReport, readAntigravityAcpQuota } from "./antigravityUsageLimits.ts";

const checkedAt = "2026-10-01T08:22:00.000Z";
const report = [
  "### Session Usage",
  "- **Session total:** 1,200 tokens (prompt: 1,000, completion: 200)",
  "",
  "### Quota Limits",
  "- **Gemini Models**",
  "  - **Weekly Limit Remaining:** 91% remaining (resets Oct 02, 2026, 08:22 UTC)",
  "  - **5h:** 100% remaining (resets Oct 01, 2026, 13:22 UTC)",
  "- **Gemini 4 Argon**",
  "  - **Weekly Limit Remaining:** 60% remaining",
  "- **Claude and GPT models**",
  "  - **Weekly Limit Remaining:** 0% remaining",
  "  - **5-hour limit:** Disabled",
  "- **Preview**",
  "  - **Requests:** 1,000 units remaining",
  "  - **Daily:** 50% remaining",
].join("\n");

describe("Antigravity subscription limits", () => {
  it("uses the managed ACP report's groups, percentages and reset clocks", () => {
    const reading = parseAntigravityUsageReport(report, checkedAt);
    expect(reading.source).toBe("antigravity-acp");
    expect(
      reading.windows.map(({ id, usedPercent, scope, resetsAt, observedAt }) => [
        id,
        usedPercent,
        scope,
        resetsAt,
        observedAt,
      ]),
    ).toEqual([
      ["gemini-5h", 0, "gemini-default", undefined, checkedAt],
      ["3p-weekly", 100, "third-party", undefined, checkedAt],
      ["gemini-argon-weekly", 40, "gemini-argon", undefined, checkedAt],
      ["gemini-weekly", 9, "gemini-default", "2026-10-02T08:22:00.000Z", checkedAt],
      ["group-preview-daily", 50, "unknown", undefined, checkedAt],
    ]);
    for (const unusable of [
      "- data not available yet",
      "- No quota limits reported.",
      "- Unable to retrieve quota status",
    ]) {
      expect(parseAntigravityUsageReport(`### Quota Limits\n${unusable}`, checkedAt)).toMatchObject(
        {
          source: "antigravity-acp",
          windows: [],
          unavailable: { reason: "probeFailed" },
        },
      );
    }
  });

  it.effect("only sends the built-in command after the qualified runtime advertises it", () =>
    Effect.gen(function* () {
      for (const [version, names, probesQuota, lateAnnouncement] of [
        ["1.4.5", ["usage"], true],
        ["1.4.5", ["plan"], false],
        ["1.5.2", ["usage"], true],
        ["1.5.2", ["plan"], false],
        ["1.5.2", ["usage"], true, true],
        ["1.3.0", ["usage"], false],
      ] as const) {
        const queue = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
        const sessionStarted = yield* Deferred.make<void>();
        const announcement = {
          _tag: "AvailableCommandsUpdated",
          rawPayload: {},
          availableCommands: names.map((name) => ({ name, description: name })),
        } as const;
        let prompts = 0;
        const probe = yield* readAntigravityAcpQuota({
          start: () =>
            Effect.gen(function* () {
              if (!lateAnnouncement) yield* Queue.offer(queue, announcement);
              yield* Deferred.succeed(sessionStarted, undefined);
              return {
                sessionId: "test",
                modelConfigId: undefined,
                sessionSetupResult: { sessionId: "test" },
                initializeResult: {
                  protocolVersion: 1,
                  agentInfo: { name: "antigravity-acp", version },
                },
              };
            }),
          getEvents: () => Stream.fromQueue(queue),
          drainEvents: Effect.gen(function* () {
            const acknowledge = yield* Deferred.make<void>();
            yield* Queue.offer(queue, { _tag: "EventStreamBarrier", acknowledge });
            yield* Deferred.await(acknowledge);
          }),
          prompt: (request) =>
            Effect.gen(function* () {
              prompts++;
              expect(request.prompt).toEqual([{ type: "text", text: "/usage" }]);
              yield* Queue.offer(queue, { _tag: "ContentDelta", text: report, rawPayload: {} });
              return { stopReason: "end_turn" as const };
            }),
        }).pipe(Effect.forkChild);
        if (lateAnnouncement) {
          yield* Deferred.await(sessionStarted);
          yield* TestClock.adjust("2 seconds");
          yield* Queue.offer(queue, announcement);
        }
        const result = yield* Fiber.join(probe);
        if (probesQuota) {
          expect(result.windows).toHaveLength(5);
          expect(prompts).toBe(1);
        } else {
          expect(result.unavailable?.reason).toBe("unsupported");
          expect(prompts).toBe(0);
        }
      }
    }),
  );
});
