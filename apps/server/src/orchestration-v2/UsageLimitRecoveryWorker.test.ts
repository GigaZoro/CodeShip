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

import * as ProviderMcp from "../provider/ProviderMcp.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ResetCreditRedemption from "./ResetCreditRedemption.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import {
  limitFailoverCommand,
  limitRecoveryCommand,
  limitRecoveryTarget,
  resetCreditRedemptionAccount,
  resetCreditResumeCommand,
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

// "Hide limited threads until the limit resets" snoozed this stop until its reset.
const hiddenUntilReset: ProjectionStore.ProjectionLimitRecoveryCandidate = {
  ...thread,
  limitRecovery: { runId, resetAt, autoResume: true, snooze: true, snoozeBySettings: true },
  snoozedUntil: DateTime.makeUnsafe(Date.parse(resetAt)),
};
// The same snooze picked by the person holds the thread until it wakes.
const snoozedUntilResetByPerson = {
  limitRecovery: { runId, resetAt, autoResume: true, snooze: true },
  snoozedUntil: DateTime.makeUnsafe(Date.parse(resetAt)),
};

// With auto-resume off in settings, the arm that hid the stop left auto-resume unset.
const hiddenWithoutAutoResume: ProjectionStore.ProjectionLimitRecoveryCandidate = {
  ...hiddenUntilReset,
  limitRecovery: {
    runId,
    resetAt,
    autoResume: false,
    autoResumeUnset: true,
    snooze: true,
    snoozeBySettings: true,
  },
};
// Waking a hidden stop early keeps auto-resume as the arm left it.
const wokenWithoutAutoResume: ProjectionStore.ProjectionLimitRecoveryCandidate = {
  ...thread,
  limitRecovery: { runId, resetAt, autoResume: false, autoResumeUnset: true, snooze: false },
};
// A Stop that landed after the arm, before anything recorded it on the thread.
const stoppedAfterArm = { ...hiddenWithoutAutoResume, latestRunStopRequested: true };

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
    mcpSignInsNeeded: new Map(),
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
    // So does one hidden until its reset, with or without auto-resume; continuing it wakes it.
    for (const hidden of [hiddenUntilReset, hiddenWithoutAutoResume, wokenWithoutAutoResume]) {
      assert.equal(
        failover({ thread: hidden })?.modelSelection?.instanceId,
        ProviderInstanceId.make("claude_first"),
      );
    }
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
    ["the thread was stopped after the arm", stoppedAfterArm],
    ["the limit has reset", { usageLimitResetAt: "2026-10-29T11:00:00.000Z" }],
    [
      "the thread moved to another account",
      { latestRunProviderInstanceId: ProviderInstanceId.make("claude_first") },
    ],
    ["the limit resets within minutes", { usageLimitResetAt: "2026-10-29T12:04:00.000Z" }],
    ["the thread is snoozed", { snoozedUntil: DateTime.makeUnsafe(Date.parse(resetAt)) }],
    ["the person snoozed it until the reset", snoozedUntilResetByPerson],
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
      mcpSignInsNeeded: new Map(),
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
    /** The account uses its banked reset credit automatically, and Fable reads used up. */
    readonly redeemed?: Queue.Queue<ProviderInstanceId>;
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
              autoUseResetCredits: input.redeemed === undefined ? [] : [claudeAgent],
            }),
            streamChanges: Stream.never,
          }),
          Layer.mock(ProviderMcp.ProviderMcp)({ listLoaded: () => Effect.succeedNone }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              provider("claudeAgent", {
                models: [
                  model("claude-fable-5-2", "Claude Fable 5.2"),
                  model("claude-opus-5-5", "Claude Opus 5.5"),
                ],
                ...(input.redeemed === undefined
                  ? {}
                  : {
                      usageLimits: {
                        checkedAt: "2026-10-29T11:59:00.000Z",
                        windows: [
                          {
                            id: "seven_day_fable",
                            kind: "weekly" as const,
                            label: "Fable",
                            usedPercent: 100,
                            resetsAt: resetAt,
                          },
                        ],
                        resetCredits: { availableCount: 1 },
                      },
                    }),
              }),
            ]),
            streamChanges: Stream.never,
          }),
          Layer.mock(ResetCreditRedemption.ResetCreditRedemption)({
            redeem: (instanceId) =>
              (input.redeemed === undefined
                ? Effect.void
                : Queue.offer(input.redeemed, instanceId)
              ).pipe(Effect.as({ outcome: "reset" as const })),
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

  it.effect("a sweep spends no reset credit on a thread that can resume early", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
      const redeemed = yield* Queue.unbounded<ProviderInstanceId>();
      const layer = sweepLayer({
        candidate: stopped,
        limits: () => new Map([[claudeAgent, [fableHold]]]),
        dispatched,
        redeemed,
      });
      yield* Effect.gen(function* () {
        const first = yield* Effect.raceFirst(
          Queue.take(dispatched),
          Queue.take(redeemed).pipe(Effect.as(null)),
        );
        assert(first?.type === "message.dispatch");
        assert.equal(first.modelSelection?.model, "claude-opus-5-5");
        assert.equal(yield* Queue.size(redeemed), 0);
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
              autoUseResetCredits: [],
            } as never),
            streamChanges: Stream.never,
          }),
          Layer.mock(ProviderMcp.ProviderMcp)({ listLoaded: () => Effect.succeedNone }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([]),
            streamChanges: Stream.fromQueue(providerChanges),
          }),
          Layer.mock(ResetCreditRedemption.ResetCreditRedemption)({}),
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
          Layer.mock(ProviderMcp.ProviderMcp)({ listLoaded: () => Effect.succeedNone }),
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
          Layer.mock(ResetCreditRedemption.ResetCreditRedemption)({}),
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

describe("reset credits", () => {
  const own = ProviderInstanceId.make("claudeAgent");
  const other = ProviderInstanceId.make("claude_second");
  const limits = (usedPercent: number, availableCount = 2) => ({
    usageLimits: {
      checkedAt: "2026-10-29T11:59:00.000Z",
      windows: [
        { id: "weekly", kind: "weekly" as const, label: "Weekly", usedPercent, resetsAt: resetAt },
      ],
      resetCredits: { availableCount },
    },
  });
  const outOfUsage = provider("claudeAgent", limits(100));
  const freed = provider("claudeAgent", limits(0, 1));
  const refused = new Map([[own, [{ resetAt, refusedAt: "2026-10-29T11:00:00Z" }]]]);
  const input = (overrides: Partial<Parameters<typeof resetCreditRedemptionAccount>[0]> = {}) => ({
    thread,
    settings: { ...settings, autoUseResetCredits: [own] },
    providers: [outOfUsage],
    recordedLimits: refused,
    mcpSignInsNeeded: new Map(),
    nowMs: now,
    ...overrides,
  });

  it("redeems on the stopped, held or hidden thread's own account while its limits read used up", () => {
    assert.equal(resetCreditRedemptionAccount(input()), own);
    assert.equal(resetCreditRedemptionAccount(input({ thread: heldThread })), own);
    assert.equal(resetCreditRedemptionAccount(input({ thread: hiddenUntilReset })), own);
    assert.equal(resetCreditRedemptionAccount(input({ thread: hiddenWithoutAutoResume })), own);
    assert.equal(resetCreditRedemptionAccount(input({ thread: wokenWithoutAutoResume })), own);
  });

  it.each([
    ["the account does not use resets automatically", { settings }],
    ["no credit is banked", { providers: [provider("claudeAgent", limits(100, 0))] }],
    [
      "the limit resets within half an hour",
      { thread: { ...thread, usageLimitResetAt: "2026-10-29T12:20:00.000Z" } },
    ],
    // ChatGPT's app cap stops an account whose windows have room, and a reset does not lift it.
    ["the account's own limits have room", { providers: [provider("claudeAgent", limits(40))] }],
    [
      "auto-resume was cancelled for the stop",
      { thread: { ...thread, limitRecovery: { runId, resetAt, autoResume: false } } },
    ],
    ["the thread was stopped after the arm", { thread: stoppedAfterArm }],
    [
      "the thread moved to another account",
      {
        thread: { ...thread, latestRunProviderInstanceId: ProviderInstanceId.make("claude_first") },
      },
    ],
    [
      "the account is off for the thread's project",
      {
        settings: {
          ...settings,
          autoUseResetCredits: [own],
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [own]: { enabled: false } } },
          },
        },
      },
    ],
    [
      "the thread is snoozed",
      { thread: { ...thread, snoozedUntil: DateTime.makeUnsafe(Date.parse(resetAt)) } },
    ],
    [
      "the person snoozed it until the reset",
      { thread: { ...thread, ...snoozedUntilResetByPerson } },
    ],
  ] as const)("waits when %s", (_, overrides) => {
    assert.isNull(resetCreditRedemptionAccount(input(overrides)));
  });

  it("continues the thread on its own account once a reset gave it room", () => {
    assert.deepEqual(
      resetCreditResumeCommand(input({ providers: [freed], recordedLimits: new Map() })),
      {
        type: "message.dispatch",
        commandId: CommandId.make("limit-reset-resume:thread:failover:run:failover"),
        messageId: MessageId.make("limit-reset-resume:thread:failover:run:failover"),
        threadId: thread.id,
        manualContinuationOfRunId: runId,
        automaticContinuationOfRunId: runId,
        text: "Continue where you left off.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "server",
      },
    );
    assert.deepEqual(
      resetCreditResumeCommand(
        input({ thread: heldThread, providers: [freed], recordedLimits: new Map() }),
      )?.dispatchMode,
      { type: "restart_active", targetRunId: runId },
    );
    // Hiding the stop with auto-resume off does not keep the thread from the room the credit bought.
    assert.equal(
      resetCreditResumeCommand(
        input({ thread: hiddenWithoutAutoResume, providers: [freed], recordedLimits: new Map() }),
      )?.manualContinuationOfRunId,
      runId,
    );
  });

  it.each([
    ["the account is still out", {}],
    ["its refusal still holds it", { providers: [freed] }],
    // The reset-time resume continues it instead.
    [
      "the account does not use resets automatically",
      { settings, providers: [freed], recordedLimits: new Map() },
    ],
  ] as const)("does not continue the thread early when %s", (_, overrides) => {
    assert.isNull(resetCreditResumeCommand(input(overrides)));
  });

  const sweepLayer = (options: {
    readonly failover: boolean;
    /** Resume at the reset and hide limited threads until then. */
    readonly hide?: boolean;
    /** The person stops both threads after the sweep's first read. */
    readonly stopDuringSweep?: boolean;
    /** The second thread waits on another used-up account, and the first credit gives this account room. */
    readonly secondOnOtherAccount?: boolean;
    readonly signals: {
      readonly started: Queue.Queue<void>;
      readonly idle: Queue.Queue<void>;
      readonly redeemed: Queue.Queue<ProviderInstanceId>;
      readonly dispatched: Queue.Queue<string>;
      /** When each arm happened, in ms after `now`. */
      readonly armed: Queue.Queue<number>;
    };
  }) => {
    let reads = 0;
    let ownRedeemed = false;
    const twoAccounts = options.secondOnOtherAccount === true;
    const waiting = () => {
      const stopped = options.stopDuringSweep === true && reads++ > 0;
      const first = stopped ? { ...thread, latestRunStopRequested: true } : thread;
      const next = { ...first, id: ThreadId.make("thread:second") };
      return [
        first,
        twoAccounts
          ? { ...next, providerInstanceId: other, latestRunProviderInstanceId: other }
          : next,
      ];
    };
    return UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getSignedOutFailoverCandidates: () => Effect.succeed([]),
            getLimitRecoveryCandidates: () =>
              Queue.offer(options.signals.started, undefined).pipe(Effect.as(waiting())),
            getUsageLimitedProviderInstances: () =>
              Effect.sync(() => (twoAccounts && ownRedeemed ? new Map() : refused)),
            // Read only by a sweep that did nothing.
            getLimitRecoveryWakeAt: () =>
              Queue.offer(options.signals.idle, undefined).pipe(Effect.as(null)),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command) =>
              Queue.offer(options.signals.dispatched, command.commandId).pipe(
                Effect.as({ sequence: 1, storedEvents: [] }),
              ),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.never,
            autoArmLimitRecovery: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((ms) => Queue.offer(options.signals.armed, ms - now)),
              ),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...settings,
              failoverLimitedThreads: options.failover,
              autoResumeLimitedThreads: options.hide === true,
              snoozeLimitedThreads: options.hide === true,
              autoUseResetCredits: [own, other],
            }),
            streamChanges: Stream.never,
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.sync(() =>
              twoAccounts
                ? [ownRedeemed ? freed : outOfUsage, provider(other, limits(100))]
                : [outOfUsage, provider(other, limits(100)), provider("claude_first")],
            ),
            streamChanges: Stream.never,
          }),
          Layer.mock(ProviderMcp.ProviderMcp)({ listLoaded: () => Effect.succeedNone }),
          Layer.mock(ResetCreditRedemption.ResetCreditRedemption)({
            redeem: (instanceId) =>
              Effect.sync(() => {
                if (instanceId === own) ownRedeemed = true;
              }).pipe(
                Effect.andThen(Queue.offer(options.signals.redeemed, instanceId)),
                Effect.as({ outcome: "reset" as const }),
              ),
          }),
        ),
      ),
    );
  };

  const makeSignals = Effect.gen(function* () {
    return {
      started: yield* Queue.unbounded<void>(),
      idle: yield* Queue.unbounded<void>(),
      redeemed: yield* Queue.unbounded<ProviderInstanceId>(),
      dispatched: yield* Queue.unbounded<string>(),
      armed: yield* Queue.unbounded<number>(),
    };
  });

  it.effect("redeems once per account, then waits before trying it again", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const signals = yield* makeSignals;
      yield* Effect.gen(function* () {
        assert.equal(yield* Queue.take(signals.redeemed), own);
        // The account's limits still read used up, so the next sweep leaves it alone.
        yield* TestClock.adjust("5 seconds");
        yield* Queue.take(signals.idle);
        // Two threads wait on the account; one credit is enough for both.
        assert.equal(yield* Queue.size(signals.redeemed), 0);
        assert.equal(yield* Queue.size(signals.dispatched), 0);
        yield* TestClock.adjust("15 minutes");
        assert.equal(yield* Queue.take(signals.redeemed), own);
      }).pipe(Effect.provide(sweepLayer({ failover: false, signals })));
    }),
  );

  it.effect("spends no credit on threads stopped while the sweep ran", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const signals = yield* makeSignals;
      yield* Effect.gen(function* () {
        // A sweep that spent nothing ends by reading its next wake time.
        const first = yield* Effect.raceFirst(
          Queue.take(signals.idle).pipe(Effect.as("idle")),
          Queue.take(signals.redeemed).pipe(Effect.as("redeemed")),
        );
        assert.equal(first, "idle");
      }).pipe(Effect.provide(sweepLayer({ failover: false, stopDuringSweep: true, signals })));
    }),
  );

  it.effect("spends one credit per sweep, so other threads move to the room it bought first", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const signals = yield* makeSignals;
      yield* Effect.gen(function* () {
        assert.equal(yield* Queue.take(signals.redeemed), own);
        yield* TestClock.adjust("5 seconds");
        assert.deepEqual(
          [yield* Queue.take(signals.dispatched), yield* Queue.take(signals.dispatched)],
          [
            "limit-reset-resume:thread:failover:run:failover",
            "limit-failover:thread:second:run:failover:claudeAgent",
          ],
        );
        // The second account keeps its credit: its thread moved to the room the first one bought.
        assert.equal(yield* Queue.size(signals.redeemed), 0);
      }).pipe(Effect.provide(sweepLayer({ failover: true, secondOnOtherAccount: true, signals })));
    }),
  );

  it.effect("redeems before hiding a fresh stop, and hides it when the account stays out", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const signals = yield* makeSignals;
      yield* Effect.gen(function* () {
        assert.equal(yield* Queue.take(signals.redeemed), own);
        yield* TestClock.adjust("5 seconds");
        // The first sweep armed nothing; with the account still out, the next one hides both
        // threads until the reset.
        assert.deepEqual(
          [yield* Queue.take(signals.armed), yield* Queue.take(signals.armed)],
          [5_000, 5_000],
        );
      }).pipe(Effect.provide(sweepLayer({ failover: false, hide: true, signals })));
    }),
  );

  it.effect("moves the thread to another account with room before spending a credit", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const signals = yield* makeSignals;
      yield* Effect.gen(function* () {
        assert.equal(
          yield* Queue.take(signals.dispatched),
          "limit-failover:thread:failover:run:failover:claude_first",
        );
        assert.equal(
          yield* Queue.take(signals.dispatched),
          "limit-failover:thread:second:run:failover:claude_first",
        );
        // The next sweep starts only after this one finished.
        yield* TestClock.adjust("5 seconds");
        yield* Queue.take(signals.started);
        yield* Queue.take(signals.started);
        assert.equal(yield* Queue.size(signals.redeemed), 0);
      }).pipe(Effect.provide(sweepLayer({ failover: true, signals })));
    }),
  );
});

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
    assert.equal(arm?.type, "thread.limit-recovery.arm");
  });

  it("arms a reset that is exactly 24 hours overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.limit-recovery.arm");
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
      mcpSignInsNeeded: new Map(),
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
