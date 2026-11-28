import { describe, expect, it } from "@effect/vitest";
import type { AcpSessionRuntimeEvent } from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as EffectAcpErrors from "effect-acp/errors";

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

  it("parses Antigravity 1.5.2 Five Hour Limit Remaining as a 5h session window", () => {
    const report152 = [
      "### Session Usage",
      "- **Session total:** 0 tokens",
      "",
      "### Quota Limits",
      "- **Gemini Models**",
      "  - **Weekly Limit Remaining:** 92% remaining (resets Oct 07, 2026, 08:22 UTC)",
      "  - **Five Hour Limit Remaining:** 80% remaining (resets Oct 01, 2026, 11:22 UTC)",
      "- **Claude & GPT Models**",
      "  - **Weekly Limit Remaining:** 100% remaining (resets Oct 08, 2026, 08:22 UTC)",
      "  - **Five Hour Limit Remaining:** 40% remaining (resets Oct 01, 2026, 12:22 UTC)",
    ].join("\n");
    const reading = parseAntigravityUsageReport(report152, checkedAt);
    expect(
      reading.windows.map(({ id, kind, scope, usedPercent, windowDurationMins, resetsAt }) => ({
        id,
        kind,
        scope,
        usedPercent,
        windowDurationMins,
        resetsAt,
      })),
    ).toEqual([
      {
        id: "3p-5h",
        kind: "session",
        scope: "third-party",
        usedPercent: 60,
        windowDurationMins: 300,
        resetsAt: "2026-10-01T12:22:00.000Z",
      },
      {
        id: "gemini-5h",
        kind: "session",
        scope: "gemini-default",
        usedPercent: 20,
        windowDurationMins: 300,
        resetsAt: "2026-10-01T11:22:00.000Z",
      },
      {
        id: "3p-weekly",
        kind: "weekly",
        scope: "third-party",
        usedPercent: 0,
        windowDurationMins: 10_080,
        resetsAt: undefined,
      },
      {
        id: "gemini-weekly",
        kind: "weekly",
        scope: "gemini-default",
        usedPercent: 8,
        windowDurationMins: 10_080,
        resetsAt: "2026-10-07T08:22:00.000Z",
      },
    ]);
  });

  it.effect("only sends the built-in command after the qualified runtime advertises it", () =>
    Effect.gen(function* () {
      const makeRuntime = (
        version: string,
        onStart: (queue: Queue.Queue<AcpSessionRuntimeEvent>) => Effect.Effect<void>,
      ) =>
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
          let prompts = 0;
          const runtime = {
            start: () =>
              onStart(queue).pipe(
                Effect.as({
                  sessionId: "test",
                  modelConfigId: undefined,
                  sessionSetupResult: { sessionId: "test" },
                  initializeResult: {
                    protocolVersion: 1,
                    agentInfo: { name: "antigravity-acp", version },
                  },
                }),
              ),
            getEvents: () => Stream.fromQueue(queue),
            drainEvents: Effect.gen(function* () {
              const acknowledge = yield* Deferred.make<void>();
              yield* Queue.offer(queue, { _tag: "EventStreamBarrier", acknowledge });
              yield* Deferred.await(acknowledge);
            }),
            prompt: (request: {
              readonly prompt: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
            }) =>
              Effect.gen(function* () {
                prompts++;
                expect(request.prompt).toEqual([{ type: "text", text: "/usage" }]);
                yield* Queue.offer(queue, { _tag: "ContentDelta", text: report, rawPayload: {} });
                return { stopReason: "end_turn" as const };
              }),
          };
          return { queue, runtime, getPrompts: () => prompts };
        });

      for (const [version, names, probesQuota, lateAnnouncement] of [
        ["1.4.5", ["usage"], true],
        ["1.4.5", ["plan"], false],
        ["1.4.5", ["usage"], true, true],
        ["1.5.2", ["usage"], true],
        ["1.5.2", ["plan"], false],
        ["1.5.2", ["usage"], true, true],
        ["1.3.0", ["usage"], false],
      ] as const) {
        const sessionStarted = yield* Deferred.make<void>();
        const announcement = {
          _tag: "AvailableCommandsUpdated",
          rawPayload: {},
          availableCommands: names.map((name) => ({ name, description: name })),
        } as const;
        const { queue, runtime, getPrompts } = yield* makeRuntime(version, (eventQueue) =>
          Effect.gen(function* () {
            if (!lateAnnouncement) yield* Queue.offer(eventQueue, announcement);
            yield* Deferred.succeed(sessionStarted, undefined);
          }),
        );
        const probe = yield* readAntigravityAcpQuota(runtime).pipe(Effect.forkChild);
        if (lateAnnouncement) {
          yield* Deferred.await(sessionStarted);
          yield* TestClock.adjust("2 seconds");
          yield* Queue.offer(queue, announcement);
        }
        const result = yield* Fiber.join(probe);
        if (probesQuota) {
          expect(result.windows).toHaveLength(5);
          expect(getPrompts()).toBe(1);
        } else {
          expect(result.unavailable?.reason).toBe("unsupported");
          expect(getPrompts()).toBe(0);
        }
      }

      // Connection termination before commands arrive fails the probe immediately without dispatching /usage.
      const terminatedStart = yield* Deferred.make<void>();
      const terminated = yield* makeRuntime("1.5.2", () =>
        Deferred.succeed(terminatedStart, undefined).pipe(Effect.asVoid),
      );
      const terminatedFiber = yield* Effect.forkChild(readAntigravityAcpQuota(terminated.runtime));
      yield* Deferred.await(terminatedStart);
      yield* Queue.offer(terminated.queue, {
        _tag: "ConnectionTerminated",
        error: new EffectAcpErrors.AcpTransportError({ detail: "closed", cause: undefined }),
      });
      const terminatedResult = yield* Fiber.join(terminatedFiber);
      expect(terminatedResult.unavailable?.reason).toBe("probeFailed");
      expect(terminated.getPrompts()).toBe(0);
    }),
  );
});
