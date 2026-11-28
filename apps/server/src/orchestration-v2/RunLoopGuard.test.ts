import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_RUN_LOOP_GUARD_SETTINGS,
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";

import {
  extractToolItemErrorSignature,
  makeRunLoopGuardState,
  resolveRunLoopRole,
  stepRunLoopGuard,
} from "./RunLoopGuard.ts";

const driver = ProviderDriverKind.make("codex");
const threadId = ThreadId.make("thread:guard");
const runId = RunId.make("run:guard");
const attemptId = RunAttemptId.make("attempt:guard");
const rootNodeId = NodeId.make("node:guard");
const rootProviderThreadId = ProviderThreadId.make("provider-thread:guard");
const rootProviderTurnId = ProviderTurnId.make("provider-turn:guard:1");
const now = DateTime.makeUnsafe(0);

function makeCommandItem(input: {
  readonly id: string;
  readonly status?: OrchestrationV2TurnItem["status"];
  readonly command?: string;
  readonly output?: string;
  readonly exitCode?: number;
  readonly outputIndicatesFailure?: boolean;
}): ProviderAdapter.ProviderAdapterV2Event {
  return {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: TurnItemId.make(input.id),
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: rootProviderThreadId,
      providerTurnId: rootProviderTurnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: input.status ?? "completed",
      title: "Run command",
      startedAt: now,
      completedAt: input.status === "running" ? null : now,
      updatedAt: now,
      type: "command_execution",
      input: input.command ?? "npm test",
      ...(input.output === undefined ? {} : { output: input.output }),
      ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      ...(input.outputIndicatesFailure === undefined
        ? {}
        : { outputIndicatesFailure: input.outputIndicatesFailure }),
    },
  };
}

function makeDynamicToolItem(input: {
  readonly id: string;
  readonly toolName: string;
  readonly status?: OrchestrationV2TurnItem["status"];
  readonly output?: unknown;
}): ProviderAdapter.ProviderAdapterV2Event {
  return {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: TurnItemId.make(input.id),
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: rootProviderThreadId,
      providerTurnId: rootProviderTurnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: input.status ?? "completed",
      title: input.toolName,
      startedAt: now,
      completedAt: input.status === "running" ? null : now,
      updatedAt: now,
      type: "dynamic_tool",
      toolName: input.toolName,
      input: {},
      ...(input.output === undefined ? {} : { output: input.output }),
    },
  };
}

function makeTurnEvent(input: {
  readonly turnId: string;
  readonly status: "running" | "completed" | "failed" | "interrupted";
  readonly providerThreadId?: ProviderThreadId;
  readonly runAttemptId?: RunAttemptId | null;
}): ProviderAdapter.ProviderAdapterV2Event {
  return {
    type: "provider_turn.updated",
    driver,
    threadId,
    providerTurn: {
      id: ProviderTurnId.make(input.turnId),
      providerThreadId: input.providerThreadId ?? rootProviderThreadId,
      nodeId: rootNodeId,
      runAttemptId: input.runAttemptId === undefined ? attemptId : input.runAttemptId,
      nativeTurnRef: null,
      ordinal: 1,
      status: input.status,
      startedAt: now,
      completedAt: input.status === "running" ? null : now,
    },
  };
}

describe("RunLoopGuard", () => {
  it("classifies interactive, scheduled, maintenance, and delegated runs accurately", () => {
    const baseMessage = {
      createdBy: "user" as const,
    };
    const rootLineage = {
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    };

    assert.equal(
      resolveRunLoopRole({ appThread: rootLineage, run: {}, message: baseMessage }),
      "interactive",
    );
    assert.equal(
      resolveRunLoopRole({
        appThread: rootLineage,
        run: {},
        message: { ...baseMessage, scheduledTaskId: ScheduledTaskId.make("sched:1") },
      }),
      "scheduled",
    );
    assert.equal(
      resolveRunLoopRole({
        appThread: rootLineage,
        run: {},
        message: { createdBy: "system" },
      }),
      "maintenance",
    );
    assert.equal(
      resolveRunLoopRole({
        appThread: {
          lineage: {
            parentThreadId: threadId,
            relationshipToParent: "subagent",
            rootThreadId: threadId,
          },
        },
        run: {},
        message: baseMessage,
      }),
      "delegated",
    );
    assert.equal(
      resolveRunLoopRole({
        appThread: {
          ...rootLineage,
          delegatedFrom: {
            environmentId: EnvironmentId.make("env:remote"),
            threadId,
            title: "Remote",
          },
        },
        run: {},
        message: baseMessage,
      }),
      "delegated",
    );
    assert.equal(
      resolveRunLoopRole({
        appThread: rootLineage,
        run: { delegatedTaskId: NodeId.make("task:1") },
        message: baseMessage,
      }),
      "delegated",
    );
    // User-owned interactive thread woken by a background-task/delegate continuation stays interactive.
    assert.equal(
      resolveRunLoopRole({
        appThread: { ...rootLineage, createdBy: "user" },
        run: {},
        message: { createdBy: "agent" },
      }),
      "interactive",
    );
  });

  it("normalizes timestamps, UUIDs, temp paths, PIDs, and durations into identical signatures", () => {
    const first = makeCommandItem({
      id: "item:1",
      status: "failed",
      exitCode: 1,
      output:
        "\u001b[31m[2026-11-28T01:02:03.456Z] pid 41234 failed on /tmp/tmp-a1b2c3/run.log " +
        "(req 550e8400-e29b-41d4-a716-446655440000) in 142ms: ENOENT\u001b[0m",
    });
    const second = makeCommandItem({
      id: "item:2",
      status: "failed",
      exitCode: 1,
      output:
        "[2026-11-28T09:55:11.999Z] pid:99812 failed on /private/tmp/tmp-z9y8x7/run.log " +
        "(req 123e4567-e89b-12d3-a456-426614174000) in 918ms: ENOENT",
    });
    const thirdDistinctExit = makeCommandItem({
      id: "item:3",
      status: "failed",
      exitCode: 2,
      output:
        "[2026-11-28T09:55:11.999Z] pid:99812 failed on /tmp/tmp-z9y8x7/run.log " +
        "(req 123e4567-e89b-12d3-a456-426614174000) in 918ms: ENOENT",
    });

    if (first.type !== "turn_item.updated" || second.type !== "turn_item.updated") {
      assert.fail("expected turn_item.updated");
    }
    if (thirdDistinctExit.type !== "turn_item.updated") {
      assert.fail("expected turn_item.updated");
    }
    const sig1 = extractToolItemErrorSignature(first.turnItem);
    const sig2 = extractToolItemErrorSignature(second.turnItem);
    const sig3 = extractToolItemErrorSignature(thirdDistinctExit.turnItem);

    assert.isDefined(sig1);
    assert.equal(sig1, sig2);
    assert.notEqual(sig1, sig3);
  });

  it("trips thrash circuit breaker on the 3rd consecutive identical error signature", () => {
    const state = makeRunLoopGuardState({ role: "scheduled" });

    assert.isNull(
      stepRunLoopGuard(state, {
        event: makeCommandItem({
          id: "err:1",
          status: "failed",
          exitCode: 1,
          output: "2026-11-28T10:00:01Z /tmp/build-111/out.js: permission denied",
        }),
        attemptId,
        rootThreadId: threadId,
        rootProviderThreadId,
      }),
    );
    // Repeated failed snapshot for the same item id must not double count.
    assert.isNull(
      stepRunLoopGuard(state, {
        event: makeCommandItem({
          id: "err:1",
          status: "failed",
          exitCode: 1,
          output: "2026-11-28T10:00:01Z /tmp/build-111/out.js: permission denied",
        }),
        attemptId,
        rootThreadId: threadId,
        rootProviderThreadId,
      }),
    );
    assert.isNull(
      stepRunLoopGuard(state, {
        event: makeCommandItem({
          id: "err:2",
          status: "completed",
          exitCode: 1,
          output: "2026-11-28T10:00:02Z /var/folders/xx/build-222/out.js: permission denied",
        }),
        attemptId,
        rootThreadId: threadId,
        rootProviderThreadId,
      }),
    );
    const tripped = stepRunLoopGuard(state, {
      event: makeCommandItem({
        id: "err:3",
        status: "failed",
        exitCode: 1,
        output: "2026-11-28T10:00:03Z C:\\Windows\\Temp\\build-333\\out.js: permission denied",
      }),
      attemptId,
      rootThreadId: threadId,
      rootProviderThreadId,
    });

    assert.isNotNull(tripped);
    assert.equal(tripped.code, "thrash_circuit_breaker");
    assert.equal(tripped.observedCount, 3);
    assert.equal(tripped.limit, 3);
    assert.include(tripped.reason, "thrash circuit breaker");
    assert.include(tripped.reason, tripped.errorSignature ?? "");
  });

  it("resets consecutive error counter on distinct error, successful tool, or completed root turn", () => {
    const state = makeRunLoopGuardState({ role: "scheduled" });

    // Two identical MCP failures -> distinct error resets to 1 -> two more distinct -> no trip.
    for (const [id, message] of [
      ["d:1", "ECONNREFUSED 127.0.0.1:5432"],
      ["d:2", "ECONNREFUSED 127.0.0.1:5432"],
      ["d:3", "TypeError: cannot read properties of undefined"],
      ["d:4", "TypeError: cannot read properties of undefined"],
    ] as const) {
      assert.isNull(
        stepRunLoopGuard(state, {
          event: makeDynamicToolItem({
            id,
            toolName: "t3.query",
            output: { isError: true, content: [{ type: "text", text: message }] },
          }),
          attemptId,
          rootThreadId: threadId,
          rootProviderThreadId,
        }),
      );
    }
    assert.equal(state.consecutiveErrorCount, 2);

    // Intervening successful tool call resets counter to 0.
    assert.isNull(
      stepRunLoopGuard(state, {
        event: makeCommandItem({ id: "ok:1", status: "completed", exitCode: 0, output: "ok" }),
        attemptId,
        rootThreadId: threadId,
        rootProviderThreadId,
      }),
    );
    assert.equal(state.consecutiveErrorCount, 0);

    // Two more identical errors + completed root turn -> counter resets cleanly again.
    assert.isNull(
      stepRunLoopGuard(state, {
        event: makeCommandItem({
          id: "d:5",
          status: "failed",
          exitCode: 1,
          output: "timeout contacting server",
        }),
        attemptId,
        rootThreadId: threadId,
        rootProviderThreadId,
      }),
    );
    assert.isNull(
      stepRunLoopGuard(state, {
        event: makeCommandItem({
          id: "d:6",
          status: "failed",
          exitCode: 1,
          output: "timeout contacting server",
        }),
        attemptId,
        rootThreadId: threadId,
        rootProviderThreadId,
      }),
    );
    assert.isNull(
      stepRunLoopGuard(state, {
        event: makeTurnEvent({ turnId: "turn:done", status: "completed" }),
        attemptId,
        rootThreadId: threadId,
        rootProviderThreadId,
      }),
    );
    assert.equal(state.consecutiveErrorCount, 0);
    assert.isNull(
      stepRunLoopGuard(state, {
        event: makeCommandItem({
          id: "d:7",
          status: "failed",
          exitCode: 1,
          output: "timeout contacting server",
        }),
        attemptId,
        rootThreadId: threadId,
        rootProviderThreadId,
      }),
    );
    assert.equal(state.consecutiveErrorCount, 1);
    assert.isNull(state.abortedDecision);
  });

  it("enforces per-role turn and tool-call caps without triggering prematurely on interactive runs", () => {
    const customSettings = {
      ...DEFAULT_RUN_LOOP_GUARD_SETTINGS,
      limits: {
        ...DEFAULT_RUN_LOOP_GUARD_SETTINGS.limits,
        scheduled: { maxTurns: 2, maxToolCalls: 3 },
      },
    };
    const scheduled = makeRunLoopGuardState({ role: "scheduled", settings: customSettings });
    const interactive = makeRunLoopGuardState({ role: "interactive", settings: customSettings });

    // Running -> completed for the same tool call counts once; 4th distinct tool call aborts scheduled.
    for (let index = 1; index <= 3; index++) {
      assert.isNull(
        stepRunLoopGuard(scheduled, {
          event: makeCommandItem({ id: `cmd:${index}`, status: "running" }),
          attemptId,
          rootThreadId: threadId,
          rootProviderThreadId,
        }),
      );
      assert.isNull(
        stepRunLoopGuard(scheduled, {
          event: makeCommandItem({ id: `cmd:${index}`, status: "completed", exitCode: 0 }),
          attemptId,
          rootThreadId: threadId,
          rootProviderThreadId,
        }),
      );
      assert.isNull(
        stepRunLoopGuard(interactive, {
          event: makeCommandItem({ id: `cmd:${index}`, status: "completed", exitCode: 0 }),
          attemptId,
          rootThreadId: threadId,
          rootProviderThreadId,
        }),
      );
    }

    const fourthScheduled = stepRunLoopGuard(scheduled, {
      event: makeCommandItem({ id: "cmd:4", status: "running" }),
      attemptId,
      rootThreadId: threadId,
      rootProviderThreadId,
    });
    assert.isNotNull(fourthScheduled);
    assert.equal(fourthScheduled.code, "tool_call_cap_exceeded");
    assert.equal(fourthScheduled.observedCount, 4);
    assert.equal(fourthScheduled.limit, 3);
    assert.include(fourthScheduled.reason, "scheduled tool-call cap: 4/3");

    // Interactive run stays well within its ceiling (1000 tool calls).
    assert.isNull(
      stepRunLoopGuard(interactive, {
        event: makeCommandItem({ id: "cmd:4", status: "completed", exitCode: 0 }),
        attemptId,
        rootThreadId: threadId,
        rootProviderThreadId,
      }),
    );

    // Root turn cap ignores native child turns and aborts on maxTurns + 1 root turn.
    const turnCapped = makeRunLoopGuardState({ role: "scheduled", settings: customSettings });
    assert.isNull(
      stepRunLoopGuard(turnCapped, {
        event: makeTurnEvent({ turnId: "t1", status: "completed" }),
        attemptId,
        rootThreadId: threadId,
        rootProviderThreadId,
      }),
    );
    assert.isNull(
      stepRunLoopGuard(turnCapped, {
        event: makeTurnEvent({
          turnId: "child-t1",
          status: "running",
          providerThreadId: ProviderThreadId.make("provider-thread:child"),
          runAttemptId: null,
        }),
        attemptId,
        rootThreadId: threadId,
        rootProviderThreadId,
      }),
    );
    assert.isNull(
      stepRunLoopGuard(turnCapped, {
        event: makeTurnEvent({ turnId: "t2", status: "running" }),
        attemptId,
        rootThreadId: threadId,
        rootProviderThreadId,
      }),
    );
    const turnTripped = stepRunLoopGuard(turnCapped, {
      event: makeTurnEvent({ turnId: "t3", status: "running" }),
      attemptId,
      rootThreadId: threadId,
      rootProviderThreadId,
    });
    assert.isNotNull(turnTripped);
    assert.equal(turnTripped.code, "turn_cap_exceeded");
    assert.equal(turnTripped.observedCount, 3);
    assert.equal(turnTripped.limit, 2);
  });

  it("respects enabled and thrashBreakerEnabled toggles", () => {
    const disabledAll = makeRunLoopGuardState({
      role: "maintenance",
      settings: {
        ...DEFAULT_RUN_LOOP_GUARD_SETTINGS,
        enabled: false,
        limits: {
          ...DEFAULT_RUN_LOOP_GUARD_SETTINGS.limits,
          maintenance: { maxTurns: 1, maxToolCalls: 1 },
        },
      },
    });
    for (let index = 1; index <= 4; index++) {
      assert.isNull(
        stepRunLoopGuard(disabledAll, {
          event: makeCommandItem({
            id: `off:${index}`,
            status: "failed",
            exitCode: 1,
            output: "same error",
          }),
          attemptId,
          rootThreadId: threadId,
          rootProviderThreadId,
        }),
      );
    }

    const thrashOffOnly = makeRunLoopGuardState({
      role: "scheduled",
      settings: {
        ...DEFAULT_RUN_LOOP_GUARD_SETTINGS,
        enabled: true,
        thrashBreakerEnabled: false,
        limits: {
          ...DEFAULT_RUN_LOOP_GUARD_SETTINGS.limits,
          scheduled: { maxTurns: 5, maxToolCalls: 3 },
        },
      },
    });
    for (let index = 1; index <= 3; index++) {
      assert.isNull(
        stepRunLoopGuard(thrashOffOnly, {
          event: makeCommandItem({
            id: `to:${index}`,
            status: "failed",
            exitCode: 1,
            output: "same error",
          }),
          attemptId,
          rootThreadId: threadId,
          rootProviderThreadId,
        }),
      );
    }
    const fourthHitsCap = stepRunLoopGuard(thrashOffOnly, {
      event: makeCommandItem({ id: "to:4", status: "failed", exitCode: 1, output: "same error" }),
      attemptId,
      rootThreadId: threadId,
      rootProviderThreadId,
    });
    assert.equal(fourthHitsCap?.code, "tool_call_cap_exceeded");
  });

  it("ignores child-thread turn items projected from subagents", () => {
    const state = makeRunLoopGuardState({
      role: "interactive",
      settings: {
        ...DEFAULT_RUN_LOOP_GUARD_SETTINGS,
        limits: {
          ...DEFAULT_RUN_LOOP_GUARD_SETTINGS.limits,
          interactive: { maxTurns: 100, maxToolCalls: 2 },
        },
      },
    });
    const childThreadId = ThreadId.make("thread:guard-child");
    for (let i = 1; i <= 4; i++) {
      const ev = makeCommandItem({
        id: `child-cmd-${i}`,
        status: "failed",
        exitCode: 1,
        output: "Permission denied",
      });
      const childEvent: ProviderAdapter.ProviderAdapterV2Event =
        ev.type === "turn_item.updated" && ev.turnItem.type === "command_execution"
          ? {
              ...ev,
              turnItem: {
                ...ev.turnItem,
                threadId: childThreadId,
                runId: null,
                providerThreadId: null,
                providerTurnId: null,
              },
            }
          : ev;
      assert.isNull(
        stepRunLoopGuard(state, {
          event: childEvent,
          attemptId,
          rootThreadId: threadId,
          rootProviderThreadId,
        }),
      );
    }
    assert.strictEqual(state.seenToolCallIds.size, 0);
    assert.strictEqual(state.consecutiveErrorCount, 0);
  });

  it("distinguishes failed file_search items by error preview rather than generic title", () => {
    const state = makeRunLoopGuardState({ role: "interactive" });
    const errors = [
      "rg: /a: No such file or directory (os error 2)",
      "rg: /b: Operation not permitted (os error 1)",
      "rg: /c: Permission denied (os error 13)",
    ];
    for (const [idx, preview] of errors.entries()) {
      const event: ProviderAdapter.ProviderAdapterV2Event = {
        type: "turn_item.updated",
        driver,
        turnItem: {
          id: TurnItemId.make(`search-${idx}`),
          threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId: rootProviderThreadId,
          providerTurnId: rootProviderTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: idx + 1,
          status: "failed",
          title: "Search files",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "file_search",
          pattern: "**/*",
          results: [{ fileName: ".", preview }],
        },
      };
      assert.isNull(
        stepRunLoopGuard(state, {
          event,
          attemptId,
          rootThreadId: threadId,
          rootProviderThreadId,
        }),
      );
    }
    assert.strictEqual(state.consecutiveErrorCount, 1);
  });
});
