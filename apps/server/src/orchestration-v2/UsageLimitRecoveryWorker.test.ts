import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  ChatAttachmentId,
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
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderMcp from "../provider/ProviderMcp.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { codexRateLimitsToLimits } from "../provider/codexUsageLimits.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AccountRouting from "./AccountRouting.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { NO_CREDIT_ACCESS } from "./PrepaidCreditSpend.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { CONTINUE_PROMPT } from "./RestartContinuation.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  evidenceKey,
  makeDispatchRecorder,
  recordDispatchFailure,
  recordStopDecision,
} from "./StopDecisionEvidence.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import {
  limitFailoverCommand,
  limitRecoveryCommand,
  limitRecoveryTarget,
  resetCreditResumeCommand,
  signedInResumeCommand,
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

const model = (slug: string, name: string) => ({
  slug,
  name,
  isCustom: false,
  capabilities: null,
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

// Auto moved from Fable to Opus since the thread last ran, and claude_first holds only Fable.
const autoMovedOffFable = {
  modelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-fable-5-2",
    autoAccount: true,
  },
  settings: {
    ...settings,
    autoModeProvider: claude,
    autoModeModels: { [claude]: { model: "claude-opus-4-1" } },
  },
  recordedLimits: new Map([
    [
      ProviderInstanceId.make("claude_limited"),
      [{ resetAt: null, refusedAt: "2026-10-29T11:00:00Z" }],
    ],
    [
      ProviderInstanceId.make("claude_first"),
      [{ resetAt, refusedAt: "2026-10-29T11:00:00Z", modelScope: "fable" }],
    ],
  ]),
  withFable: (accounts: ReadonlyArray<ServerProvider>) =>
    accounts.map((account) => ({
      ...account,
      models: [...account.models, model("claude-fable-5-2", "Claude Fable 5.2")],
    })),
};

describe("limitFailoverCommand", () => {
  it("captures the eligible accounts and exclusions at the stop without account labels", () => {
    const { evidence, command } = UsageLimitRecoveryWorker.limitFailoverDecision({
      settings,
      thread,
      providers: [
        ...Array.from({ length: 65 }, (_, i) => provider("off-" + i, { enabled: false })),
        ...providers,
      ],
      recordedLimits: new Map([
        [
          ProviderInstanceId.make("claude_limited"),
          [{ resetAt, refusedAt: "2026-10-29T11:00:00Z" }],
        ],
      ]),
      mcpSignInsNeeded: new Map(),
      nowMs: now,
    });
    assert.equal(command?.modelSelection?.instanceId, "claude_first");
    assert.isTrue(evidence.candidates.some((candidate) => candidate.reason === "eligible"));
    assert.isTrue(
      evidence.candidates.some((candidate) => candidate.reason === "account_unavailable"),
    );
    assert.isAbove(evidence.omitted, 0);
    assert.isTrue(
      evidence.candidates.some(
        (candidate) => candidate.id === evidence.selected && candidate.reason === "eligible",
      ),
    );
    assert.notInclude(JSON.stringify(evidence), "claude");
  });

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

  it("moves an Auto thread for its current Auto model, not the one it last ran", () => {
    const { modelSelection, withFable, ...auto } = autoMovedOffFable;
    assert.include(
      failover({ ...auto, thread: { ...thread, modelSelection }, providers: withFable(providers) })
        ?.modelSelection,
      { instanceId: ProviderInstanceId.make("claude_first"), model: "claude-opus-4-1" },
    );
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
  // Claude held only Fable on this account until its weekly reset.
  const stopped: ProjectionStore.ProjectionLimitRecoveryCandidate = {
    ...thread,
    modelSelection: { instanceId: claudeAgent, model: "claude-fable-5-2", autoAccount: true },
    latestRunModel: "claude-fable-5-2",
    limitRecovery: { runId, resetAt, autoResume: true },
  };
  const fableHold = { resetAt, refusedAt: "2026-10-29T11:00:00Z", modelScope: "fable" };
  const autoRouted = ProviderInstanceId.make("claude_b");
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
    readonly credit?: boolean;
    readonly candidate: ProjectionStore.ProjectionLimitRecoveryCandidate;
    readonly limits: () => ReadonlyMap<
      ProviderInstanceId,
      ReadonlyArray<ProjectionStore.RecordedUsageLimit>
    >;
    readonly dispatched: Queue.Queue<OrchestrationV2ServerCommand>;
    readonly sweeps?: Queue.Queue<number>;
    /** Offered when a sweep that did not act looks for its next wake time. */
    readonly idle?: Queue.Queue<void>;
    readonly signedOut?: ReadonlyArray<ProjectionStore.ProjectionSignedOutCandidate>;
    readonly settings?: Partial<typeof DEFAULT_SERVER_SETTINGS>;
    readonly providers?: ReadonlyArray<ServerProvider>;
    readonly creditAccess?: AccountRouting.AccountRouting["Service"]["creditAccess"];
    /**
     * After recording its route, thread management refuses the routed account as disabled, or
     * fails as the orchestrator does when a Stop reached the run first.
     */
    readonly reject?: "refused" | "failed";
  }) =>
    UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          SqlitePersistence.layerMemory,
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getSignedOutCandidates: () => Effect.succeed(input.signedOut ?? []),
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) =>
                  input.sweeps === undefined ? Effect.void : Queue.offer(input.sweeps, nowMs - now),
                ),
                Effect.as([input.candidate]),
              ),
            getUsageLimitedProviderInstances: () => Effect.sync(input.limits),
            getLimitRecoveryWakeAt: () =>
              (input.idle === undefined ? Effect.void : Queue.offer(input.idle, undefined)).pipe(
                Effect.as(Date.parse(resetAt)),
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            // Auto routing moves every continuation that names no account to `autoRouted`.
            dispatch: (command, recorder) => {
              const routed =
                command.type === "message.dispatch"
                  ? (command.modelSelection?.instanceId ?? autoRouted)
                  : autoRouted;
              return Effect.gen(function* () {
                if (recorder) {
                  yield* recorder.route(evidenceKey(routed), {
                    candidates: [{ id: evidenceKey(routed), reason: "eligible" }],
                    omitted: 0,
                  });
                }
                yield* Queue.offer(input.dispatched, command);
                if (input.reject === "refused") {
                  return yield* new ThreadManagement.ThreadManagementProviderInstanceDisabledError({
                    projectId: stopped.projectId,
                    instanceId: routed,
                  });
                }
                if (input.reject === "failed") {
                  return yield* new Orchestrator.OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: "The thread was stopped, or its automatic continuation was turned off.",
                  });
                }
                return {} as never;
              });
            },
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              autoModeProvider: claude,
              autoModeModels: { [claude]: { model: "claude-opus-5-5" } },
              redeemUsageResets: input.credit ?? false,
              autoResumeLimitedThreads: true,
              failoverLimitedThreads: false,
              ...input.settings,
            }),
            streamChanges: Stream.never,
          }),
          Layer.mock(ProviderMcp.ProviderMcp)({ listLoaded: () => Effect.succeedNone }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed(
              input.providers ?? [
                provider("claudeAgent", {
                  models: [
                    model("claude-fable-5-2", "Claude Fable 5.2"),
                    model("claude-opus-5-5", "Claude Opus 5.5"),
                  ],
                }),
              ],
            ),
            streamChanges: Stream.never,
          }),
          Layer.mock(AccountRouting.AccountRouting)({
            releaseAllowedHolds: Effect.succeed(false),
            creditAccess: input.creditAccess ?? (() => Effect.succeed(NO_CREDIT_ACCESS)),
          }),
        ),
      ),
    );

  it.effect.each(["reset_credit_room", "reset_elapsed", "early_resume_room"] as const)(
    "records the account and qualification at the %s decision",
    (reason) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(reason === "reset_elapsed" ? Date.parse(resetAt) : now);
        const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
        const layer = sweepLayer({
          candidate: stopped,
          dispatched,
          limits: () => new Map(),
          credit: reason === "reset_credit_room",
        });
        yield* Effect.gen(function* () {
          yield* Queue.take(dispatched);
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(
            yield* sql`SELECT snapshot ->> 'reason' AS reason, snapshot ->> 'selected' AS planned,
            selected_key = snapshot ->> '$.dispatch.selected' AS dispatched, selected_key, outcome
            FROM usage_stop_decisions WHERE request_key IS NOT NULL`,
            [
              {
                reason,
                // An elapsed reset cannot know its account until Auto routing picks one.
                planned: reason === "reset_elapsed" ? null : evidenceKey(claudeAgent),
                dispatched: 1,
                // The record holds where the dispatch ran, not where the worker planned it.
                selected_key: evidenceKey(
                  reason === "early_resume_room" ? claudeAgent : autoRouted,
                ),
                outcome: "planned",
              },
            ],
          );
        }).pipe(Effect.provide(Layer.merge(layer, SqlitePersistence.layerMemory)));
      }),
  );

  it.effect("a failed evidence write never fails the continuation it describes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const input = {
        source: runId,
        heldAttempt: undefined,
        command: null,
        nowMs: now,
        evidence: { reason: "reset_elapsed" as const, candidates: [], omitted: 0, selected: null },
      };
      const command = limitRecoveryCommand(stopped, true, Date.parse(resetAt));
      assert(command?.type === "message.dispatch");
      const routed = makeDispatchRecorder({ ...input, command }, sql);
      yield* routed.route(null, { candidates: [], omitted: 0 });
      assert.isDefined(routed.decisionKey());
      yield* sql`DROP TABLE usage_stop_decisions`;
      // The continuation already committed; its outcome update must not fail it.
      yield* routed.committed([]);
      assert.isUndefined(yield* recordStopDecision(input));
      yield* recordDispatchFailure("missing", "refused");
      const unrecorded = makeDispatchRecorder({ ...input, command }, sql);
      yield* unrecorded.route(null, { candidates: [], omitted: 0 });
      assert.isUndefined(unrecorded.decisionKey());
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect.each(["refused", "failed"] as const)(
    "records a routed elapsed reset that thread management rejects as %s",
    (reject) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(resetAt));
        const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
        const sweeps = yield* Queue.unbounded<number>();
        const layer = sweepLayer({
          candidate: stopped,
          dispatched,
          sweeps,
          limits: () => new Map(),
          reject,
        });
        yield* Effect.gen(function* () {
          yield* Queue.take(sweeps);
          yield* Queue.take(dispatched);
          // The next sweep starts only after this one has recorded its outcome.
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(sweeps);
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(
            yield* sql`SELECT selected_key, outcome FROM usage_stop_decisions
            WHERE snapshot ->> 'reason' = 'reset_elapsed'`,
            [{ selected_key: evidenceKey(autoRouted), outcome: reject }],
          );
          // No attempt ran, so the stop proves nothing about the account it was routed to.
          assert.deepEqual(
            yield* sql`SELECT classification FROM usage_stop_replay WHERE source_key = ${evidenceKey(runId)}`,
            [{ classification: "unknown" }],
          );
        }).pipe(Effect.provide(Layer.merge(layer, SqlitePersistence.layerMemory)));
      }),
  );

  it.effect("separates a held attempt and a later terminal stop on the same run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const input = {
        source: runId,
        command: null,
        nowMs: now,
        evidence: {
          reason: "switching_disabled" as const,
          candidates: [],
          omitted: 0,
          selected: null,
        },
      };
      yield* sql`INSERT INTO usage_stop_decisions
        (decision_key, source_key, snapshot, observed_ms)
        VALUES ('historical', ${evidenceKey(runId)}, '{"reason":"switching_disabled"}', ${now - 1})`;
      yield* recordStopDecision({ ...input, heldAttempt: heldAttemptId });
      yield* recordStopDecision({
        ...input,
        heldAttempt: undefined,
        nowMs: now + 1,
        evidence: { ...input.evidence, reason: "no_actionable_reset" },
      });
      assert.deepEqual(
        yield* sql`SELECT classification, decisions FROM usage_stop_replay
          WHERE source_key = ${evidenceKey(runId)} ORDER BY first_observed_ms`,
        [
          { classification: "unknown", decisions: 1 },
          { classification: "pinned", decisions: 1 },
          { classification: "unknown", decisions: 1 },
        ],
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  const fableAccount = (instanceId: string, driver = claude) =>
    provider(instanceId, { driver, models: [model("claude-fable-5-2", "Claude Fable 5.2")] });
  // Stops that dispatch nothing replay from the decision the sweep recorded about them.
  it.effect.each([
    {
      name: "every other account of its driver is limited",
      classification: "exhausted",
      candidate: named,
      providers: [fableAccount("claudeAgent"), fableAccount("claude_b")],
      limited: [claudeAgent, autoRouted],
      failover: true,
    },
    {
      name: "account switching is off",
      classification: "pinned",
      candidate: named,
      providers: [fableAccount("claudeAgent"), fableAccount("claude_b")],
      limited: [claudeAgent],
      failover: false,
    },
    {
      name: "only accounts of another driver remain",
      classification: "pinned",
      candidate: named,
      providers: [
        fableAccount("claudeAgent"),
        fableAccount("codex", ProviderDriverKind.make("codex")),
      ],
      limited: [claudeAgent],
      failover: true,
    },
    {
      name: "another account could not run its model",
      classification: "unknown",
      candidate: named,
      providers: [fableAccount("claudeAgent"), provider("claude_b", { models: [] })],
      limited: [claudeAgent],
      failover: true,
    },
    {
      name: "the sweep only observed it",
      classification: "unknown",
      candidate: { ...named, observationOnly: true as const },
      providers: [fableAccount("claudeAgent"), fableAccount("claude_b")],
      limited: [claudeAgent],
      failover: true,
    },
  ])("replays a stop where $name as $classification", (scenario) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
      const idle = yield* Queue.unbounded<void>();
      const layer = sweepLayer({
        candidate: scenario.candidate,
        dispatched,
        idle,
        providers: scenario.providers,
        limits: () => new Map(scenario.limited.map((id) => [id, [fableHold]])),
        settings: {
          failoverLimitedThreads: scenario.failover,
          providerInstances: { [autoRouted]: { driver: claude } },
        },
      });
      yield* Effect.gen(function* () {
        yield* Queue.take(idle);
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(
          yield* sql`SELECT classification, decisions, attributable_lost_tokens
            FROM usage_stop_replay WHERE source_key = ${evidenceKey(runId)}`,
          [
            {
              classification: scenario.classification,
              decisions: 1,
              attributable_lost_tokens: null,
            },
          ],
        );
        assert.equal(yield* Queue.size(dispatched), 0);
      }).pipe(Effect.provide(Layer.merge(layer, SqlitePersistence.layerMemory)));
    }),
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

  it.effect("a sweep continues a chat a rejected login stopped with account switching off", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
      const layer = sweepLayer({
        candidate: named,
        limits: () => new Map([[claudeAgent, [fableHold]]]),
        dispatched,
        signedOut: [signedOutThread],
      });
      yield* Effect.gen(function* () {
        const command = yield* Queue.take(dispatched);
        assert(command.type === "message.dispatch");
        assert.equal(command.commandId, `signed-in-resume:${signedOutThread.id}:${runId}`);
      }).pipe(Effect.provide(layer));
    }),
  );

  describe("a thread the user allowed prepaid credits", () => {
    const codexDriver = ProviderDriverKind.make("codex");
    const paid = ProviderInstanceId.make("codex_paid");
    const spare = ProviderInstanceId.make("codex_spare");
    const gpt = "gpt-5.5";
    // Codex stopped it mid-turn when the plan ran out; Try again has since lifted that hold.
    const onPaid: ProjectionStore.ProjectionLimitRecoveryCandidate = {
      ...named,
      providerInstanceId: paid,
      latestRunProviderInstanceId: paid,
      modelSelection: { instanceId: paid, model: gpt },
      latestRunModel: gpt,
    };
    const planUsedUp = (instanceId: ProviderInstanceId) =>
      provider(instanceId, {
        driver: codexDriver,
        models: [model(gpt, "GPT-5.5")],
        usageLimits: codexRateLimitsToLimits({
          checkedAt: "2026-10-29T11:59:00.000Z",
          read: {
            rateLimits: {
              planType: "plus",
              primary: { usedPercent: 10, windowDurationMins: 300 },
              secondary: {
                usedPercent: 100,
                windowDurationMins: 10_080,
                resetsAt: Date.parse(resetAt) / 1000,
              },
              credits: { balance: "25.00", hasCredits: true, unlimited: false },
            },
            ordinaryUsageAllowed: false,
          },
        }),
      });
    const allowedOnBoth = (failoverLimitedThreads: boolean) => ({
      failoverLimitedThreads,
      providerInstanceFailoverOrder: [paid, spare],
      providerInstances: Object.fromEntries(
        [paid, spare].map((id) => [
          id,
          {
            driver: codexDriver,
            config: { spendCredits: { capCredits: 3000, threadIds: [onPaid.id] } },
          },
        ]),
      ),
    });

    it.effect.each([
      {
        name: "resumes it on them where it stopped, before the plan resets",
        switching: false,
        providers: [planUsedUp(paid)],
        limits: new Map(),
        expected: {
          commandId: `limit-resume:${onPaid.id}:${runId}:${Date.parse(resetAt)}:legacy:${paid}:${gpt}`,
          instanceId: paid,
        },
      },
      {
        name: "moves it to another account it may spend them on while its own stays held",
        switching: true,
        providers: [planUsedUp(paid), planUsedUp(spare)],
        limits: new Map([[paid, [{ resetAt, refusedAt: "2026-10-29T11:00:00Z" }]]]),
        expected: {
          commandId: `limit-failover:${onPaid.id}:${runId}:${spare}`,
          instanceId: spare,
        },
      },
    ] as const)("a sweep $name", ({ switching, providers, limits, expected }) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
        const layer = sweepLayer({
          candidate: onPaid,
          limits: () => limits,
          dispatched,
          settings: allowedOnBoth(switching),
          providers,
          // As the ledger reads it: nothing spent yet, and the asking thread is the requester.
          creditAccess: (requesterThreadId) =>
            Effect.succeed({
              spent: new Map([
                [paid, 0],
                [spare, 0],
              ]),
              requesters: [requesterThreadId],
            }),
        });
        yield* Effect.gen(function* () {
          const command = yield* Queue.take(dispatched);
          assert(command.type === "message.dispatch");
          assert.deepEqual<{ readonly commandId: string; readonly instanceId: string | undefined }>(
            { commandId: command.commandId, instanceId: command.modelSelection?.instanceId },
            expected,
          );
        }).pipe(Effect.provide(layer));
      }),
    );
  });

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
          SqlitePersistence.layerMemory,
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getSignedOutCandidates: () => Effect.succeed([]),
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
              redeemUsageResets: false,
            } as never),
            streamChanges: Stream.never,
          }),
          Layer.mock(ProviderMcp.ProviderMcp)({ listLoaded: () => Effect.succeedNone }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([]),
            streamChanges: Stream.fromQueue(providerChanges),
          }),
          Layer.mock(AccountRouting.AccountRouting)({ releaseAllowedHolds: Effect.succeed(false) }),
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

// A rejected login stopped this thread's run before the agent did any work.
const signedOutThread: ProjectionStore.ProjectionSignedOutCandidate = {
  id: thread.id,
  projectId,
  providerInstanceId: thread.providerInstanceId,
  modelSelection: thread.modelSelection,
  archivedAt: null,
  settledOverride: null,
  snoozedUntil: null,
  latestRunId: runId,
  latestRunProviderInstanceId: thread.providerInstanceId,
  latestRunCompletedAt: DateTime.makeUnsafe(now - 120_000),
  latestRunUserMessageId: MessageId.make("message:failover"),
  workDone: false,
  message: {
    text: "Summarise the inbox",
    context: { version: 1, records: [] },
    attachments: [
      {
        type: "image",
        id: ChatAttachmentId.make("thread-failover-inbox"),
        name: "inbox.png",
        mimeType: "image/png",
        sizeBytes: 1024,
      },
    ],
  },
};

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
  {
    limit: "a refusal's reset, for a thread a rejected login stopped",
    refusalResetAt: freedAt,
    window: {},
    signedOut: true,
  },
] as const)("a waiting thread wakes when another account's limit ends: $limit", (testCase) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    const queries = yield* Queue.unbounded<number>();
    const signedOut = "signedOut" in testCase;
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          SqlitePersistence.layerMemory,
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getSignedOutCandidates: () => Effect.succeed(signedOut ? [signedOutThread] : []),
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - now)),
                Effect.as(
                  signedOut
                    ? []
                    : [{ ...thread, limitRecovery: { runId, resetAt, autoResume: true } }],
                ),
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
              provider("claudeAgent", signedOut ? { auth: { status: "unauthenticated" } } : {}),
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
          Layer.mock(AccountRouting.AccountRouting)({
            releaseAllowedHolds: Effect.succeed(false),
            creditAccess: () => Effect.succeed(NO_CREDIT_ACCESS),
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

describe("reset credits", () => {
  const own = ProviderInstanceId.make("claudeAgent");
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
  const input = (overrides: Partial<Parameters<typeof resetCreditResumeCommand>[0]> = {}) => ({
    thread,
    settings: { ...settings, redeemUsageResets: true },
    providers: [outOfUsage],
    recordedLimits: refused,
    mcpSignInsNeeded: new Map(),
    nowMs: now,
    ...overrides,
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
      "this machine does not redeem resets",
      { settings, providers: [freed], recordedLimits: new Map() },
    ],
  ] as const)("does not continue the thread early when %s", (_, overrides) => {
    assert.isNull(resetCreditResumeCommand(input(overrides)));
  });

  it("judges the model an Auto thread runs next, not the one it stopped on", () => {
    // Auto moved from Fable to Opus since the thread stopped on Fable.
    const autoWithUsedUp = (scope: string) =>
      input({
        thread: {
          ...thread,
          modelSelection: { instanceId: own, model: "claude-fable-5-2", autoAccount: true },
        },
        settings: {
          ...settings,
          redeemUsageResets: true,
          autoModeProvider: claude,
          autoModeModels: { [claude]: { model: "claude-opus-5-5" } },
        },
        providers: [
          provider("claudeAgent", {
            models: [
              model("claude-fable-5-2", "Claude Fable 5.2"),
              model("claude-opus-5-5", "Claude Opus 5.5"),
            ],
            usageLimits: {
              ...limits(0).usageLimits,
              windows: [
                {
                  id: `seven_day_${scope}`,
                  kind: "weekly",
                  label: "Weekly",
                  usedPercent: 100,
                  resetsAt: resetAt,
                },
              ],
            },
          }),
        ],
        recordedLimits: new Map(),
      });
    assert.isNull(resetCreditResumeCommand(autoWithUsedUp("opus")));
    assert.equal(resetCreditResumeCommand(autoWithUsedUp("fable"))?.type, "message.dispatch");
  });

  it("stops retrying a limit-reset-resume run that failed again without work on the same model", () => {
    const resetResumeId = MessageId.make("limit-reset-resume:thread:failover:run:previous");
    const withRoom = (overrides: Partial<ProjectionStore.ProjectionLimitRecoveryCandidate>) =>
      resetCreditResumeCommand(
        input({
          thread: { ...thread, ...overrides },
          providers: [freed],
          recordedLimits: new Map(),
        }),
      );
    // First limit-reset-resume after a normal user message dispatches even if that run did no work.
    assert.equal(
      withRoom({
        latestRunUserMessageId: MessageId.make("message:initial"),
        latestRunModel: "opus",
        latestRunWorkDone: false,
      })?.commandId,
      CommandId.make("limit-reset-resume:thread:failover:run:failover"),
    );
    // A limit-reset-resume that fails again with zero progress on the same model stops looping,
    // whether latestRunModel holds the alias, the canonical slug, or is omitted.
    for (const latestRunModel of ["opus", "claude-opus-4-1", null, undefined]) {
      assert.isNull(
        withRoom({
          latestRunUserMessageId: resetResumeId,
          latestRunWorkDone: false,
          ...(latestRunModel === undefined ? {} : { latestRunModel }),
        }),
      );
    }
    // A limit-reset-resume that did work before hitting a new usage limit is still eligible.
    assert.equal(
      withRoom({
        latestRunUserMessageId: resetResumeId,
        latestRunModel: "claude-opus-4-1",
        latestRunWorkDone: true,
      })?.commandId,
      CommandId.make("limit-reset-resume:thread:failover:run:failover"),
    );
    // If Auto moved to another model with room since the zero-progress resume, it can try that model.
    assert.equal(
      resetCreditResumeCommand(
        input({
          thread: {
            ...thread,
            modelSelection: { instanceId: own, model: "claude-fable-5-2", autoAccount: true },
            latestRunUserMessageId: resetResumeId,
            latestRunModel: "claude-fable-5-2",
            latestRunWorkDone: false,
          },
          settings: {
            ...settings,
            redeemUsageResets: true,
            autoModeProvider: claude,
            autoModeModels: { [claude]: { model: "claude-opus-5-5" } },
          },
          providers: [
            provider("claudeAgent", {
              ...limits(0, 1),
              models: [
                model("claude-fable-5-2", "Claude Fable 5.2"),
                model("claude-opus-5-5", "Claude Opus 5.5"),
              ],
            }),
          ],
          recordedLimits: new Map(),
        }),
      )?.commandId,
      CommandId.make("limit-reset-resume:thread:failover:run:failover"),
    );
  });
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
  const limitedAccount = ProviderInstanceId.make("claude_limited");
  const refusal = [{ resetAt: null, refusedAt: "2026-10-29T11:00:00Z" }];
  const move = (overrides: Partial<Parameters<typeof signedOutFailoverCommand>[0]> = {}) =>
    signedOutFailoverCommand({
      mcpSignInsNeeded: new Map(),
      thread: signedOutThread,
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
      ...signedOutThread.message,
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

  it("moves an Auto thread for its current Auto model, not the one it last ran", () => {
    const { modelSelection, withFable, ...auto } = autoMovedOffFable;
    assert.include(
      move({
        ...auto,
        thread: { ...signedOutThread, modelSelection },
        providers: withFable(signedOutProviders),
      })?.modelSelection,
      { instanceId: ProviderInstanceId.make("claude_first"), model: "claude-opus-4-1" },
    );
  });

  it.each([
    ["the account signed in again", { providers }],
    [
      "the thread moved to another account",
      {
        thread: {
          ...signedOutThread,
          latestRunProviderInstanceId: ProviderInstanceId.make("codex"),
        },
      },
    ],
    [
      "the thread is archived",
      { thread: { ...signedOutThread, archivedAt: DateTime.makeUnsafe(now) } },
    ],
    [
      "the thread is snoozed",
      { thread: { ...signedOutThread, snoozedUntil: DateTime.makeUnsafe(now + 60_000) } },
    ],
    [
      "the thread was settled",
      { thread: { ...signedOutThread, settledOverride: "settled" as const } },
    ],
    ["no other account can run it", { providers: [signedOutProviders[0]!] }],
    // A new account would repeat the work.
    ["the agent already did work", { thread: { ...signedOutThread, workDone: true } }],
  ] as const)("keeps the thread in place when %s", (_, overrides) => {
    assert.isNull(move(overrides));
  });

  it("never moves onto an allowBackground: false account even when all background-eligible accounts are limited", () => {
    const reservedSettings = {
      ...settings,
      providerInstances: {
        ...settings.providerInstances,
        [ProviderInstanceId.make("claude_second")]: {
          driver: claude,
          enabled: true,
          allowBackground: false,
        },
      },
    };
    const limited = new Map([
      [limitedAccount, refusal],
      [ProviderInstanceId.make("claude_first"), refusal],
    ]);
    assert.isNull(move({ settings: reservedSettings, recordedLimits: limited }));
  });
});

describe("signedInResumeCommand", () => {
  const resumeSettings = { ...settings, autoResumeLimitedThreads: true };
  const resume = (overrides: Partial<Parameters<typeof signedInResumeCommand>[0]> = {}) =>
    signedInResumeCommand({
      mcpSignInsNeeded: new Map(),
      thread: signedOutThread,
      settings: resumeSettings,
      providers,
      recordedLimits: new Map(),
      nowMs: now,
      ...overrides,
    });
  const resumeId = "signed-in-resume:thread:failover:run:failover";

  it("sends the message again on its own account once a later check finds it signed in", () => {
    assert.deepEqual(resume(), {
      type: "message.dispatch",
      commandId: CommandId.make(resumeId),
      messageId: MessageId.make(resumeId),
      threadId: thread.id,
      automaticContinuationOfRunId: runId,
      manualContinuationOfRunId: runId,
      ...signedOutThread.message,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    });
  });

  it("continues a run that did work instead of repeating its message", () => {
    assert.include(resume({ thread: { ...signedOutThread, workDone: true } }), {
      text: CONTINUE_PROMPT,
    });
  });

  it("resumes a resume again once it did work", () => {
    assert.isNotNull(
      resume({
        thread: {
          ...signedOutThread,
          latestRunUserMessageId: MessageId.make(resumeId),
          workDone: true,
        },
      }),
    );
  });

  it.each([
    ["resuming stopped threads is off", { settings }],
    [
      "the account still reads signed out",
      {
        providers: providers.map((candidate) =>
          candidate.instanceId === "claudeAgent"
            ? {
                ...candidate,
                status: "error" as const,
                auth: { status: "unauthenticated" as const },
              }
            : candidate,
        ),
      },
    ],
    // The account's status was read before the rejection reached it.
    [
      "no check ran since the stop",
      { thread: { ...signedOutThread, latestRunCompletedAt: DateTime.makeUnsafe(now) } },
    ],
    [
      "a resume was rejected before doing any work",
      { thread: { ...signedOutThread, latestRunUserMessageId: MessageId.make(resumeId) } },
    ],
    [
      "the thread moved to another account",
      {
        thread: {
          ...signedOutThread,
          latestRunProviderInstanceId: ProviderInstanceId.make("codex"),
        },
      },
    ],
    [
      "the thread is snoozed",
      { thread: { ...signedOutThread, snoozedUntil: DateTime.makeUnsafe(now + 60_000) } },
    ],
    [
      "the thread was settled",
      { thread: { ...signedOutThread, settledOverride: "settled" as const } },
    ],
  ] as const)("leaves the thread when %s", (_, overrides) => {
    assert.isNull(resume(overrides));
  });
});
