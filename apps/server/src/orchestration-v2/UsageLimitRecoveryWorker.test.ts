import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import { limitFailoverCommand, limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";

const now = Date.parse("2026-10-29T12:00:00.000Z");
const resetAt = "2026-10-30T12:00:00.000Z";
const projectId = ProjectId.make("project:failover");
const runId = RunId.make("run:failover");
const claude = ProviderDriverKind.make("claudeAgent");

const provider = (instanceId: string, overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: claude,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-29T11:59:00.000Z",
  models: [
    {
      slug: "claude-opus-4-1",
      name: "Claude Opus 4.1",
      aliases: ["opus"],
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const thread: ProjectionStore.ProjectionLimitRecoveryCandidate = {
  id: ThreadId.make("thread:failover"),
  projectId,
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  latestRunProviderInstanceId: ProviderInstanceId.make("claudeAgent"),
  modelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "opus",
    options: [{ id: "effort", value: "high" }],
  },
  status: "failed",
  lastErrorClass: "usage_limit",
  latestRunId: runId,
  usageLimitResetAt: resetAt,
  archivedAt: null,
  settledOverride: null,
  pendingRuntimeRequest: null,
  latestRunCompletedAt: DateTime.makeUnsafe(now - 1_000),
  updatedAt: DateTime.makeUnsafe(now - 1_000),
  limitRecovery: null,
  snoozedUntil: null,
};

const providers = [
  provider("claudeAgent"),
  provider("claude_limited"),
  provider("claude_exhausted", {
    usageLimits: {
      checkedAt: "2026-10-29T11:59:00.000Z",
      windows: [
        { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100, resetsAt: resetAt },
      ],
    },
  }),
  provider("claude_signed_out", { auth: { status: "unauthenticated" } }),
  provider("claude_project_off"),
  provider("claude_second"),
  provider("claude_first"),
  provider("codex", { driver: ProviderDriverKind.make("codex") }),
];

const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: Object.fromEntries(
    providers
      .filter((candidate) => candidate.instanceId.startsWith("claude_"))
      .map((candidate) => [candidate.instanceId, { driver: claude }]),
  ),
  providerInstanceFailoverOrder: [
    "codex",
    "claude_project_off",
    "claude_limited",
    "claude_exhausted",
    "claude_signed_out",
    "claude_first",
  ].map((instanceId) => ProviderInstanceId.make(instanceId)),
  projectSettingsOverrides: {
    [projectId]: {
      providerInstances: { [ProviderInstanceId.make("claude_project_off")]: { enabled: false } },
    },
  },
};

const failover = (overrides: Partial<Parameters<typeof limitFailoverCommand>[0]> = {}) =>
  limitFailoverCommand({
    thread,
    settings,
    providers,
    limitedInstanceIds: new Set([ProviderInstanceId.make("claude_limited")]),
    nowMs: now,
    ...overrides,
  });

describe("limitFailoverCommand", () => {
  it("continues on the first account of the same driver that can still run", () => {
    assert.deepEqual(failover(), {
      type: "message.dispatch",
      commandId: CommandId.make("limit-failover:thread:failover:run:failover:claude_first"),
      messageId: MessageId.make("limit-failover:thread:failover:run:failover:claude_first"),
      threadId: thread.id,
      manualContinuationOfRunId: runId,
      modelSelection: {
        instanceId: ProviderInstanceId.make("claude_first"),
        model: "claude-opus-4-1",
        options: [{ id: "effort", value: "high" }],
      },
      text: "Continue where you left off.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    });
    // Unlisted accounts follow the saved order.
    assert.deepEqual(
      failover({
        providers: providers.filter((candidate) => candidate.instanceId !== "claude_first"),
      })?.modelSelection?.instanceId,
      ProviderInstanceId.make("claude_second"),
    );
  });

  it.each([
    [
      "the stop already waits for its reset",
      { limitRecovery: { runId, resetAt, autoResume: true } },
    ],
    ["the limit has reset", { usageLimitResetAt: "2026-10-29T11:00:00.000Z" }],
    [
      "the thread moved to another account",
      { latestRunProviderInstanceId: ProviderInstanceId.make("claude_first") },
    ],
    ["the limit resets within minutes", { usageLimitResetAt: "2026-10-29T12:04:00.000Z" }],
    ["the thread is snoozed", { snoozedUntil: DateTime.makeUnsafe(Date.parse(resetAt)) }],
  ] as const)("keeps the thread in place when %s", (_, overrides) => {
    assert.isNull(failover({ thread: { ...thread, ...overrides } }));
  });

  it.each(["apiKey", "bedrock"])("never continues on a %s account", (type) => {
    assert.isNull(
      failover({
        providers: providers.map((candidate) =>
          candidate.instanceId.startsWith("claude_")
            ? { ...candidate, auth: { status: "authenticated", type } }
            : candidate,
        ),
      }),
    );
  });

  it("keeps the thread in place when every other account is out", () => {
    assert.isNull(
      failover({
        limitedInstanceIds: new Set(
          ["claude_limited", "claude_second", "claude_first"].map((instanceId) =>
            ProviderInstanceId.make(instanceId),
          ),
        ),
      }),
    );
  });
});

// An auto-account thread whose stop already waits for its reset, so a sweep leaves it alone.
const waitingAutoAccountThread: ProjectionStore.ProjectionLimitRecoveryCandidate = {
  ...thread,
  modelSelection: { ...thread.modelSelection, autoAccount: true },
  limitRecovery: { runId, resetAt, autoResume: true },
};

it.effect.each([
  { switching: "on", failoverLimitedThreads: true, candidates: [] },
  {
    switching: "off with an auto-account thread waiting",
    failoverLimitedThreads: false,
    candidates: [waitingAutoAccountThread],
  },
])(
  "idle sweeps skip SQL until the next wake time or a relevant event (switching $switching)",
  ({ failoverLimitedThreads, candidates }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
      const startMs = Date.parse("2026-07-01T09:00:00.000Z");
      const queries = yield* Queue.unbounded<number>();
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const providerChanges = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
      const layer = UsageLimitRecoveryWorker.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Scheduler.layer,
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getLimitRecoveryCandidates: () =>
                Clock.currentTimeMillis.pipe(
                  Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - startMs)),
                  Effect.as(candidates),
                ),
              getUsageLimitedProviderInstanceIds: () => Effect.succeed(new Set()),
              // One armed thread resets at 60s.
              getLimitRecoveryWakeAt: (now) =>
                Effect.succeed(
                  DateTime.toEpochMillis(now) < startMs + 60_000 ? startMs + 60_000 : null,
                ),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromQueue(events),
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed({
                autoResumeLimitedThreads: true,
                snoozeLimitedThreads: false,
                failoverLimitedThreads,
              } as never),
              streamChanges: Stream.never,
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([]),
              streamChanges: Stream.fromQueue(providerChanges),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        assert.equal(yield* Queue.take(queries), 0);
        // Eleven idle ticks before the recorded wake time, then the wake tick itself.
        yield* TestClock.adjust("60 seconds");
        assert.equal(yield* Queue.take(queries), 60_000);
        yield* Queue.offer(events, {
          type: "turn-item.updated",
          payload: { type: "assistant_message" },
        } as never);
        yield* TestClock.adjust("30 seconds");
        yield* Queue.offer(events, { type: "run.updated", payload: { status: "failed" } } as never);
        yield* TestClock.adjust("5 seconds");
        // A streaming item at 90s does not wake it; the failed run does on the 95s tick.
        assert.equal(yield* Queue.take(queries), 95_000);
        // An account change can free a thread that may switch accounts.
        yield* Queue.offer(providerChanges, []);
        yield* TestClock.adjust("5 seconds");
        assert.equal(yield* Queue.take(queries), 100_000);
      }).pipe(Effect.provide(layer));
    }),
);

const HOUR_MS = 60 * 60 * 1000;
const nowMs = Date.parse("2026-10-19T12:00:00.000Z");

const failedThread = (failedAgoMs: number, resetAgoMs: number) => {
  const failedAt = DateTime.makeUnsafe(nowMs - failedAgoMs);
  const candidate: ProjectionStore.ProjectionLimitRecoveryCandidate = {
    ...thread,
    id: ThreadId.make("thread:limited"),
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - resetAgoMs)),
    latestRunId: RunId.make("run:limited"),
    latestRunCompletedAt: failedAt,
    updatedAt: failedAt,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    limitRecovery: null,
    snoozedUntil: null,
  };
  return candidate;
};

describe("limitRecoveryCommand arming", () => {
  it("does not freshly arm a failure whose reset passed days ago", () => {
    const thread = failedThread(5 * 24 * HOUR_MS, 4 * 24 * HOUR_MS);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
    assert.isNull(limitRecoveryCommand(thread, true, nowMs, true));
  });

  it("still arms a failure whose reset only just passed", () => {
    const thread = failedThread(6 * HOUR_MS, HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("arms a reset that is exactly 24 hours overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("does not arm a reset that is 24 hours and 1ms overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS + 1);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
  });
});
