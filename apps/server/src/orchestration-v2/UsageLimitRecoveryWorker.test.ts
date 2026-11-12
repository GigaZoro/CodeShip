import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
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
import {
  limitFailoverCommand,
  limitRecoveryCommand,
  limitRecoveryTarget,
  signedOutFailoverCommand,
} from "./UsageLimitRecoveryWorker.ts";

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

const heldAttemptId = RunAttemptId.make("attempt:held");
// Claude holds this turn open until the reset instead of stopping it.
const heldThread: ProjectionStore.ProjectionLimitRecoveryCandidate = {
  ...thread,
  status: "running",
  heldAttemptId,
  latestRunCompletedAt: null,
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
    recordedLimits: new Map([
      [
        ProviderInstanceId.make("claude_limited"),
        [{ resetAt: null, refusedAt: "2026-10-29T11:00:00Z" }],
      ],
    ]),
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
      automaticContinuationOfRunId: runId,
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
    // A stop already waiting to resume at its reset moves once an account has room.
    assert.equal(
      failover({ thread: { ...thread, limitRecovery: { runId, resetAt, autoResume: true } } })
        ?.modelSelection?.instanceId,
      ProviderInstanceId.make("claude_first"),
    );
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
      "auto-resume was cancelled for the stop",
      { limitRecovery: { runId, resetAt, autoResume: false } },
    ],
    ["the limit has reset", { usageLimitResetAt: "2026-10-29T11:00:00.000Z" }],
    [
      "the thread moved to another account",
      { latestRunProviderInstanceId: ProviderInstanceId.make("claude_first") },
    ],
    ["the limit resets within minutes", { usageLimitResetAt: "2026-10-29T12:04:00.000Z" }],
    ["the thread is snoozed", { snoozedUntil: DateTime.makeUnsafe(Date.parse(resetAt)) }],
    [
      "a held turn resets within minutes",
      { ...heldThread, usageLimitResetAt: "2026-10-29T12:04:00.000Z" },
    ],
    ["a held turn is snoozed", { ...heldThread, snoozedUntil: DateTime.makeUnsafe(now + 60_000) }],
    ["a running turn is not held", { status: "running", latestRunCompletedAt: null }],
  ] as const)("keeps the thread in place when %s", (_, overrides) => {
    assert.isNull(failover({ thread: { ...thread, ...overrides } }));
  });

  it("restarts a held turn on the first account that can still run", () => {
    const command = failover({ thread: heldThread });
    assert.deepEqual(command?.dispatchMode, { type: "restart_active", targetRunId: runId });
    assert.equal(command?.modelSelection?.instanceId, ProviderInstanceId.make("claude_first"));
    assert.isUndefined(command?.manualContinuationOfRunId);
    // Each hold of the same run is its own switch, so a later hold is not taken as a repeat.
    assert.equal(
      command?.commandId,
      CommandId.make("limit-failover:thread:failover:run:failover:attempt:held:claude_first"),
    );
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

  it.each([
    ["stopped", thread],
    ["held", heldThread],
  ] as const)("keeps a %s thread in place when every other account is out", (_, candidate) => {
    assert.isNull(
      failover({
        thread: candidate,
        recordedLimits: new Map(
          ["claude_limited", "claude_second", "claude_first"].map((instanceId) => [
            ProviderInstanceId.make(instanceId),
            [{ resetAt: null, refusedAt: "2026-10-29T11:00:00Z" }],
          ]),
        ),
      }),
    );
  });
});

describe("limitRecoveryTarget", () => {
  const claudeAgent = ProviderInstanceId.make("claudeAgent");
  const model = (slug: string, name: string) => ({
    slug,
    name,
    isCustom: false,
    capabilities: null,
  });
  // Claude held only Fable on this account until its weekly reset.
  const stopped: ProjectionStore.ProjectionLimitRecoveryCandidate = {
    ...thread,
    modelSelection: { instanceId: claudeAgent, model: "claude-fable-5-2", autoAccount: true },
    latestRunModel: "claude-fable-5-2",
    limitRecovery: { runId, resetAt, autoResume: true },
  };
  const fableHold = { resetAt, refusedAt: "2026-10-29T11:00:00Z", modelScope: "fable" };
  const named: ProjectionStore.ProjectionLimitRecoveryCandidate = {
    ...stopped,
    modelSelection: { instanceId: claudeAgent, model: "claude-fable-5-2" },
  };
  const recoveryTarget = (overrides: Partial<Parameters<typeof limitRecoveryTarget>[0]> = {}) =>
    limitRecoveryTarget({
      thread: stopped,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        autoModeProvider: claude,
        autoModeModels: { [claude]: { model: "claude-opus-5-5" } },
      },
      providers: [
        provider("claudeAgent", {
          models: [
            model("claude-fable-5-2", "Claude Fable 5.2"),
            model("claude-opus-5-5", "Claude Opus 5.5"),
          ],
        }),
      ],
      recordedLimits: new Map([[claudeAgent, [fableHold]]]),
      nowMs: now,
      ...overrides,
    });

  it("resumes an Auto thread now on the Auto model the limit does not hold", () => {
    const target = recoveryTarget();
    assert.include(target?.selection, { instanceId: claudeAgent, model: "claude-opus-5-5" });
    assert.equal(target?.roomAtMs, now);
    assert.deepInclude(limitRecoveryCommand(stopped, true, now, false, target), {
      type: "message.dispatch",
      commandId: CommandId.make(
        "limit-resume:thread:failover:run:failover:1793361600000:legacy:claudeAgent:claude-opus-5-5",
      ),
      modelSelection: target!.selection,
      usageLimitContinuationOfRunId: runId,
    });
    assert.isNull(limitRecoveryCommand(stopped, true, now));
  });

  it("resumes when the Auto model's own limit ends, before the stop's reset", () => {
    const opusFreeAt = now + 60 * 60_000;
    const target = recoveryTarget({
      recordedLimits: new Map([
        [
          claudeAgent,
          [
            fableHold,
            {
              resetAt: DateTime.formatIso(DateTime.makeUnsafe(opusFreeAt)),
              refusedAt: "2026-10-29T11:00:00Z",
              modelScope: "opus",
            },
          ],
        ],
      ]),
    });
    assert.equal(target?.roomAtMs, opusFreeAt);
    assert.isNull(limitRecoveryCommand(stopped, true, now, false, target));
    assert.equal(
      limitRecoveryCommand(stopped, true, opusFreeAt, false, target)?.type,
      "message.dispatch",
    );
  });

  it.each([
    [
      "Auto still runs the held model",
      {
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          autoModeProvider: claude,
          autoModeModels: { [claude]: { model: "claude-fable-5-2" } },
        },
      },
    ],
    ["the thread names the held model", { thread: named }],
    [
      // Claude gave no reset, so the five-hour hold since 06:00 was a guess that has passed.
      "a hold with a guessed end",
      {
        thread: named,
        recordedLimits: new Map([
          [claudeAgent, [{ resetAt: null, refusedAt: "2026-10-29T06:00:00Z" }]],
        ]),
      },
    ],
  ] as const)("waits for a lift where it stopped when %s", (_, overrides) => {
    const target = recoveryTarget(overrides);
    assert.equal(target?.roomAtMs, Infinity);
    assert.isNull(
      limitRecoveryCommand("thread" in overrides ? named : stopped, true, now, false, target),
    );
  });

  it.each([
    ["its hold lifted", new Map()],
    [
      "only another model is held",
      new Map([[claudeAgent, [{ ...fableHold, modelScope: "opus" }]]]),
    ],
  ] as const)("resumes where it stopped before the reset when %s", (_, recordedLimits) => {
    const target = recoveryTarget({ thread: named, recordedLimits });
    assert.deepInclude(limitRecoveryCommand(named, true, now, false, target), {
      type: "message.dispatch",
      commandId: CommandId.make(
        "limit-resume:thread:failover:run:failover:1793361600000:legacy:claudeAgent:claude-fable-5-2",
      ),
      modelSelection: named.modelSelection,
      usageLimitContinuationOfRunId: runId,
    });
  });

  it("moves to another account only when the reset is more than minutes away", () => {
    const models = [model("claude-opus-5-5", "Claude Opus 5.5")];
    const accountWide = (resetIso: string) =>
      recoveryTarget({
        thread: {
          ...stopped,
          modelSelection: { instanceId: claudeAgent, model: "claude-opus-5-5", autoAccount: true },
          latestRunModel: "claude-opus-5-5",
          usageLimitResetAt: resetIso,
          limitRecovery: { runId, resetAt: resetIso, autoResume: true },
        },
        settings: {
          ...settings,
          autoModeProvider: claude,
          autoModeModels: { [claude]: { model: "claude-opus-5-5" } },
          failoverLimitedThreads: true,
        },
        providers: [provider("claudeAgent", { models }), provider("claude_first", { models })],
        recordedLimits: new Map([
          [claudeAgent, [{ resetAt: resetIso, refusedAt: "2026-10-29T11:00:00Z" }]],
        ]),
      });
    assert.isNull(accountWide("2026-10-29T12:04:00.000Z"));
    assert.equal(
      accountWide(resetAt)?.selection.instanceId,
      ProviderInstanceId.make("claude_first"),
    );
  });

  const sweepLayer = (input: {
    readonly candidate: ProjectionStore.ProjectionLimitRecoveryCandidate;
    readonly limits: () => ReadonlyMap<
      ProviderInstanceId,
      ReadonlyArray<ProjectionStore.RecordedUsageLimit>
    >;
    readonly dispatched: Queue.Queue<OrchestrationV2ServerCommand>;
    readonly sweeps?: Queue.Queue<number>;
  }) =>
    UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getSignedOutFailoverCandidates: () => Effect.succeed([]),
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) =>
                  input.sweeps === undefined ? Effect.void : Queue.offer(input.sweeps, nowMs - now),
                ),
                Effect.as([input.candidate]),
              ),
            getUsageLimitedProviderInstances: () => Effect.sync(input.limits),
            getLimitRecoveryWakeAt: () => Effect.succeed(Date.parse(resetAt)),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command) =>
              Queue.offer(input.dispatched, command).pipe(Effect.as({} as never)),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              autoModeProvider: claude,
              autoModeModels: { [claude]: { model: "claude-opus-5-5" } },
              autoResumeLimitedThreads: true,
              failoverLimitedThreads: false,
            }),
            streamChanges: Stream.never,
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              provider("claudeAgent", {
                models: [
                  model("claude-fable-5-2", "Claude Fable 5.2"),
                  model("claude-opus-5-5", "Claude Opus 5.5"),
                ],
              }),
            ]),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );

  it.effect("a sweep resumes it early with account switching off", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
      const layer = sweepLayer({
        candidate: stopped,
        limits: () => new Map([[claudeAgent, [fableHold]]]),
        dispatched,
      });
      yield* Effect.gen(function* () {
        const command = yield* Queue.take(dispatched);
        assert(command.type === "message.dispatch");
        assert.equal(command.usageLimitContinuationOfRunId, runId);
        assert.equal(command.modelSelection?.model, "claude-opus-5-5");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("a sweep resumes it where it stopped within a minute of its hold lifting", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
      const sweeps = yield* Queue.unbounded<number>();
      let limits: ReadonlyMap<
        ProviderInstanceId,
        ReadonlyArray<ProjectionStore.RecordedUsageLimit>
      > = new Map([[claudeAgent, [fableHold]]]);
      const layer = sweepLayer({ candidate: named, limits: () => limits, dispatched, sweeps });
      yield* Effect.gen(function* () {
        assert.equal(yield* Queue.take(sweeps), 0);
        // A run on the account got an answer: the hold is gone, but no event says so.
        limits = new Map();
        yield* TestClock.adjust("1 minute");
        const command = yield* Queue.take(dispatched);
        assert(command.type === "message.dispatch");
        assert.equal(command.usageLimitContinuationOfRunId, runId);
        assert.deepEqual(command.modelSelection, named.modelSelection);
      }).pipe(Effect.provide(layer));
    }),
  );

  it("never resumes a thread moved to another account since its stop", () => {
    const moved = { ...stopped, providerInstanceId: ProviderInstanceId.make("claude_first") };
    assert.isNull(limitRecoveryCommand(moved, true, now, false, recoveryTarget()));
    assert.isNull(limitRecoveryCommand(moved, true, Date.parse(resetAt)));
  });
});

it.effect("idle sweeps skip SQL until the next wake time or a relevant event", () =>
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
            getSignedOutFailoverCandidates: () => Effect.succeed([]),
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - startMs)),
                Effect.as([]),
              ),
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
              failoverLimitedThreads: true,
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
      // With account switching on, an account change can free a waiting thread.
      yield* Queue.offer(providerChanges, []);
      yield* TestClock.adjust("5 seconds");
      assert.equal(yield* Queue.take(queries), 100_000);
    }).pipe(Effect.provide(layer));
  }),
);

// Each limit frees claude_first two minutes in; the sweep's ten-minute backstop would come later.
const freedAt = "2026-10-29T12:02:00.000Z";
it.effect.each([
  { limit: "a refusal's reset", refusalResetAt: freedAt, window: {} },
  // The 62-minute session window bounds the hold from the 11:00 refusal.
  { limit: "a refusal's hold", refusalResetAt: null, window: {} },
  { limit: "a used-up window's reset", window: { usedPercent: 100, resetsAt: freedAt } },
  {
    limit: "a used-up window's hold",
    window: { usedPercent: 100, exhaustedSince: "2026-10-29T11:00:00Z" },
  },
] as const)("a waiting thread wakes when another account's limit ends: $limit", (testCase) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    const queries = yield* Queue.unbounded<number>();
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getSignedOutFailoverCandidates: () => Effect.succeed([]),
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - now)),
                Effect.as([{ ...thread, limitRecovery: { runId, resetAt, autoResume: true } }]),
              ),
            getUsageLimitedProviderInstances: () =>
              Effect.succeed(
                new Map<ProviderInstanceId, ReadonlyArray<ProjectionStore.RecordedUsageLimit>>([
                  [
                    ProviderInstanceId.make("unknown-reset"),
                    [{ resetAt: null, refusedAt: "2026-10-29T11:00:00Z" }],
                  ],
                  [
                    ProviderInstanceId.make("claudeAgent"),
                    [{ resetAt, refusedAt: "2026-10-29T11:00:00Z" }],
                  ],
                  ...("refusalResetAt" in testCase
                    ? [
                        [
                          ProviderInstanceId.make("claude_first"),
                          [
                            {
                              resetAt: testCase.refusalResetAt,
                              refusedAt: "2026-10-29T11:00:00Z",
                            },
                          ],
                        ] as const,
                      ]
                    : []),
                ]),
              ),
            getLimitRecoveryWakeAt: () => Effect.succeed(Date.parse(resetAt)),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...settings,
              autoResumeLimitedThreads: true,
              snoozeLimitedThreads: false,
              failoverLimitedThreads: true,
            }),
            streamChanges: Stream.never,
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              provider("claudeAgent"),
              {
                ...provider("claude_first"),
                usageLimits: {
                  checkedAt: "2026-10-29T11:00:00Z",
                  windows: [
                    {
                      id: "session",
                      kind: "session",
                      label: "Session",
                      usedPercent: 10,
                      windowDurationMins: 62,
                      ...testCase.window,
                    },
                  ],
                },
              },
              // Only the earliest end sets the wake.
              provider("claude_second", {
                usageLimits: {
                  checkedAt: "2026-10-29T11:00:00Z",
                  windows: [
                    {
                      id: "weekly",
                      kind: "weekly",
                      label: "Weekly",
                      usedPercent: 100,
                      resetsAt: "2026-10-29T12:30:00.000Z",
                    },
                  ],
                },
              }),
            ]),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(queries), 0);
      yield* TestClock.adjust("10 minutes");
      assert.equal(yield* Queue.take(queries), 120_000);
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

describe("signedOutFailoverCommand", () => {
  const signedOutProviders = providers.map((candidate) =>
    candidate.instanceId === "claudeAgent"
      ? { ...candidate, status: "error" as const, auth: { status: "unauthenticated" as const } }
      : candidate,
  );
  const candidate: ProjectionStore.ProjectionSignedOutCandidate = {
    id: thread.id,
    projectId,
    providerInstanceId: thread.providerInstanceId,
    modelSelection: thread.modelSelection,
    archivedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    latestRunId: runId,
    latestRunProviderInstanceId: thread.providerInstanceId,
    messageText: "Summarise the inbox",
  };
  const limitedAccount = ProviderInstanceId.make("claude_limited");
  const refusal = [{ resetAt: null, refusedAt: "2026-10-29T11:00:00Z" }];
  const move = (overrides: Partial<Parameters<typeof signedOutFailoverCommand>[0]> = {}) =>
    signedOutFailoverCommand({
      thread: candidate,
      settings,
      providers: signedOutProviders,
      recordedLimits: new Map([[limitedAccount, refusal]]),
      nowMs: now,
      ...overrides,
    });

  it("sends the original message again on the first other account that can run it", () => {
    assert.deepEqual(move(), {
      type: "message.dispatch",
      commandId: CommandId.make("signed-out-failover:thread:failover:run:failover:claude_first"),
      messageId: MessageId.make("signed-out-failover:thread:failover:run:failover:claude_first"),
      threadId: thread.id,
      manualContinuationOfRunId: runId,
      automaticContinuationOfRunId: runId,
      modelSelection: {
        instanceId: ProviderInstanceId.make("claude_first"),
        model: "claude-opus-4-1",
        options: [{ id: "effort", value: "high" }],
      },
      text: "Summarise the inbox",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    });
  });

  it("skips an account that is limited too", () => {
    const limited = new Map([
      [limitedAccount, refusal],
      [ProviderInstanceId.make("claude_first"), refusal],
    ]);
    assert.equal(
      move({ recordedLimits: limited })?.modelSelection?.instanceId,
      ProviderInstanceId.make("claude_second"),
    );
  });

  it.each([
    ["the account signed in again", { providers }],
    [
      "the thread moved to another account",
      { thread: { ...candidate, latestRunProviderInstanceId: ProviderInstanceId.make("codex") } },
    ],
    ["the thread is archived", { thread: { ...candidate, archivedAt: DateTime.makeUnsafe(now) } }],
    [
      "the thread is snoozed",
      { thread: { ...candidate, snoozedUntil: DateTime.makeUnsafe(now + 60_000) } },
    ],
    ["the thread was settled", { thread: { ...candidate, settledOverride: "settled" as const } }],
    ["no other account can run it", { providers: [signedOutProviders[0]!] }],
  ] as const)("keeps the thread in place when %s", (_, overrides) => {
    assert.isNull(move(overrides));
  });
});
