import { expect, it } from "@effect/vitest";
import type {
  MonitoringOverviewInput,
  MonitoringThreadSummary,
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import {
  EventId,
  MonitoringError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  UsageReadError,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as MonitoringService from "./MonitoringService.ts";
import { ANALYZER_VERSION } from "./ThreadAnalyzer.ts";

const SINCE = "2026-01-01T00:00:00.000Z";
const UNTIL = "2026-02-01T00:00:00.000Z";
const CREATED_AT = "2026-01-10T00:00:00.000Z";
const SETTLED_AT = "2026-01-10T02:00:00.000Z";
const isMonitoringError = Schema.is(MonitoringError);

/** January 2026 as a viewer asks for it whose days start `startHour` hours into each UTC day. */
const january = (startHour = 0): MonitoringOverviewInput => {
  const startOf = (index: number) =>
    DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(SINCE), { days: index, hours: startHour }));
  return {
    days: Arr.makeBy(31, (index) => ({ day: startOf(index).slice(0, 10), since: startOf(index) })),
    until: startOf(31),
  };
};

const appThread = (id: string, settledAt: string | null = SETTLED_AT): OrchestrationV2AppThread => {
  const threadId = ThreadId.make(id);
  const instanceId = ProviderInstanceId.make("claude_test");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: `Chat ${id}`,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "claude-test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: DateTime.makeUnsafe(CREATED_AT),
    updatedAt: DateTime.makeUnsafe(SETTLED_AT),
    archivedAt: null,
    settledOverride: settledAt === null ? "active" : "settled",
    settledAt: settledAt === null ? null : DateTime.makeUnsafe(settledAt),
    lastVisitedAt: null,
    deletedAt: null,
  };
};

const analyzedSummary = (
  id: string,
  settledAt: string,
  overrides: Partial<MonitoringThreadSummary> = {},
): MonitoringThreadSummary => ({
  threadId: ThreadId.make(id),
  projectId: ProjectId.make("project-1"),
  title: `Chat ${id}`,
  kind: "interactive",
  providerInstanceId: ProviderInstanceId.make("claude_test"),
  models: ["claude-test"],
  helperModels: [],
  createdAt: CREATED_AT,
  settledAt,
  lifetimeMs: 60_000,
  activeMs: 30_000,
  time: {
    agentMs: 30_000,
    commandMs: 0,
    toolMs: 0,
    approvalMs: 0,
    queuedMs: 0,
    usageLimitMs: 0,
    delegateWaitMs: 0,
    userResponseMs: 30_000,
    idleMs: 0,
    settleTailMs: 0,
  },
  runs: {
    total: 1,
    completed: 1,
    failed: 0,
    interrupted: 0,
    cancelled: 0,
    userPrompts: 1,
    automatic: 0,
    retries: 0,
    steeringRestarts: 0,
    providerRecoveries: 0,
  },
  errors: {},
  tokens: {
    inputTokens: 100,
    cachedInputTokens: 50,
    cacheCreationTokens: 0,
    outputTokens: 10,
    reasoningTokens: 0,
  },
  costUsd: 0.5,
  unpricedTurns: 0,
  peakContextRatio: null,
  compactions: 0,
  handoffs: 0,
  helpers: { subagents: 0, delegates: 0, commands: 0, workflows: 0, failed: 0 },
  commands: { count: 0, failed: 0, durationMs: 0 },
  phases: [],
  filesChanged: 0,
  reopens: 0,
  findings: [],
  ...overrides,
});

const domainEvent = (
  type: "thread.settled" | "thread.unsettled" | "thread.pinned" | "thread.metadata-updated",
  thread: OrchestrationV2AppThread,
  key: string = type,
): OrchestrationV2DomainEvent => ({
  type,
  id: EventId.make(`event:${thread.id}:${key}`),
  threadId: thread.id,
  occurredAt: DateTime.makeUnsafe(SETTLED_AT),
  payload: thread,
});

const makeHarness = Effect.fn("makeHarness")(function* (
  priceTokens: UsageService.UsageService["Service"]["priceTokens"] = () => Effect.succeed([]),
) {
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const layer = MonitoringService.layer.pipe(
    Layer.provide(Layer.mock(UsageService.UsageService)({ priceTokens })),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.fromQueue(events) }),
    ),
    Layer.provideMerge(OrchestrationEventStore.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  const context = yield* Layer.build(layer);
  const sql = Context.get(context, SqlClient.SqlClient);
  const monitoring = Context.get(context, MonitoringService.MonitoringService);
  const eventStore = Context.get(context, OrchestrationEventStore.OrchestrationEventStore);

  const seedThread = Effect.fn("seedThread")(function* (
    threadId: string,
    payload: Record<string, unknown> = {},
  ) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
         created_at, updated_at, payload_json)
      VALUES (${threadId}, 'project-1', ${`Chat ${threadId}`}, 'claude_test', 'full-access', 'default',
        ${CREATED_AT}, ${SETTLED_AT}, ${JSON.stringify({
          settledOverride: "settled",
          settledAt: SETTLED_AT,
          ...payload,
        })})
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
      VALUES (${`${threadId}-run`}, ${threadId}, 1, 'claude_test', 'completed',
        '2026-01-10T00:10:00.000Z', '2026-01-10T01:00:00.000Z', ${JSON.stringify({
          userMessageId: "message-1",
          startedAt: "2026-01-10T00:10:30.000Z",
          completedAt: "2026-01-10T01:00:00.000Z",
        })})
    `;
  });

  /**
   * A settled chat with a stored analysis, without running the analyzer. `settledAt` is the settle
   * stamp of the chat and its row, which a readable summary repeats.
   */
  const seedAnalyzed = Effect.fn("seedAnalyzed")(function* (
    summary: MonitoringThreadSummary,
    {
      analyzerVersion = ANALYZER_VERSION,
      settledAt = summary.settledAt,
    }: { readonly analyzerVersion?: number; readonly settledAt?: string } = {},
  ) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
         created_at, updated_at, payload_json)
      VALUES (${summary.threadId}, ${summary.projectId}, ${summary.title}, 'claude_test',
        'full-access', 'default', ${CREATED_AT}, ${settledAt}, ${JSON.stringify({
          settledOverride: "settled",
          settledAt,
        })})
    `;
    yield* sql`
      INSERT INTO monitoring_thread_analyses
        (thread_id, settled_at, analyzer_version, analyzed_at, summary_json, error)
      VALUES (${summary.threadId}, ${settledAt}, ${analyzerVersion}, ${settledAt},
        ${JSON.stringify(summary)}, NULL)
    `;
  });

  return { eventStore, events, monitoring, seedAnalyzed, seedThread, sql };
});

const listChats = (
  monitoring: MonitoringService.MonitoringService["Service"],
  input: Partial<Parameters<MonitoringService.MonitoringService["Service"]["chats"]>[0]> = {},
) =>
  monitoring
    .chats({
      since: SINCE,
      until: UNTIL,
      sort: "settledAt",
      direction: "desc",
      limit: 500,
      offset: 0,
      ...input,
    })
    .pipe(
      Effect.map((result) => ({
        ids: result.chats.map((chat) => chat.summary.threadId),
        total: result.total,
      })),
    );

const overviewIds = (monitoring: MonitoringService.MonitoringService["Service"]) =>
  Effect.gen(function* () {
    const overview = yield* monitoring.overview(january());
    const { ids } = yield* listChats(monitoring);
    const grouped = overview.groups.reduce((total, group) => total + group.lifetimesMs.length, 0);
    expect(grouped).toBe(ids.length);
    const pending = overview.unanalyzed.reduce((total, entry) => total + entry.pending, 0);
    const failed = overview.unanalyzed.reduce((total, entry) => total + entry.failed, 0);
    return { ids, pending, failed };
  });

const unanalyzedOf = (monitoring: MonitoringService.MonitoringService["Service"]) =>
  monitoring.overview(january()).pipe(Effect.map((overview) => overview.unanalyzed));

const nextChange = (monitoring: MonitoringService.MonitoringService["Service"], seen: number) =>
  Stream.runHead(
    monitoring.subscribeChanges.pipe(Stream.filter((change) => change.revision > seen)),
  ).pipe(Effect.map((change) => Option.getOrThrow(change).revision));

it.effect("analyzes settled chats at start and drops one when it is unsettled", () =>
  Effect.gen(function* () {
    const { events, monitoring, seedThread, sql } = yield* makeHarness();
    yield* seedThread("settled-chat");
    yield* seedThread("sub-chat", { lineage: { relationshipToParent: "subagent" } });
    yield* seedThread("side-chat", { lineage: { sideChat: 1 } });
    expect(yield* overviewIds(monitoring)).toEqual({ ids: [], pending: 1, failed: 0 });

    yield* monitoring.start();
    const analyzed = yield* nextChange(monitoring, 0);
    expect(yield* overviewIds(monitoring)).toEqual({
      ids: ["settled-chat"],
      pending: 0,
      failed: 0,
    });

    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.settledOverride', 'active')
      WHERE thread_id = 'settled-chat'
    `;
    yield* Queue.offer(events, domainEvent("thread.unsettled", appThread("settled-chat", null)));
    yield* nextChange(monitoring, analyzed);
    expect(yield* overviewIds(monitoring)).toEqual({ ids: [], pending: 0, failed: 0 });
  }).pipe(Effect.scoped),
);

it.effect("follows a settle and an unsettle that come without their own event", () =>
  Effect.gen(function* () {
    const { events, monitoring, seedThread, sql } = yield* makeHarness();
    yield* seedThread("recovered-chat");
    yield* monitoring.start();
    const analyzed = yield* nextChange(monitoring, 0);

    // A skipped scheduled recovery settles the chat again through a metadata update.
    const resettledAt = "2026-01-11T00:00:00.000Z";
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.settledAt', ${resettledAt})
      WHERE thread_id = 'recovered-chat'
    `;
    yield* Queue.offer(
      events,
      domainEvent("thread.metadata-updated", appThread("recovered-chat", resettledAt)),
    );
    // It is announced at once as pending, and again once its analysis carries the new stamp.
    const stored = sql<{ readonly settled_at: string }>`
      SELECT settled_at FROM monitoring_thread_analyses
    `;
    const reanalyzed = yield* Stream.runHead(
      monitoring.subscribeChanges.pipe(
        Stream.filter((change) => change.revision > analyzed),
        Stream.filterEffect(() =>
          stored.pipe(Effect.map((rows) => rows.some((row) => row.settled_at === resettledAt))),
        ),
      ),
    ).pipe(Effect.map((change) => Option.getOrThrow(change).revision));
    expect(yield* stored).toEqual([{ settled_at: resettledAt }]);

    // Pinning a settled chat makes it active without an unsettle event.
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.settledOverride', 'active', '$.settledAt', NULL)
      WHERE thread_id = 'recovered-chat'
    `;
    yield* Queue.offer(events, domainEvent("thread.pinned", appThread("recovered-chat", null)));
    yield* nextChange(monitoring, reanalyzed);
    expect(yield* sql`SELECT thread_id FROM monitoring_thread_analyses`).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("analyzes a chat on demand and returns nothing for one that is not settled", () =>
  Effect.gen(function* () {
    const { monitoring, seedThread } = yield* makeHarness();
    yield* seedThread("settled-chat");
    yield* seedThread("open-chat", { settledOverride: "active" });
    // Stamped as settled before it was created: its summary and stored key keep that stamp alike.
    yield* seedThread("skewed-chat", { settledAt: "2026-01-09T23:00:00.000Z" });

    const detail = yield* monitoring.thread({ threadId: ThreadId.make("settled-chat") });
    const open = yield* monitoring.thread({ threadId: ThreadId.make("open-chat") });
    yield* monitoring.thread({ threadId: ThreadId.make("skewed-chat") });

    expect([detail?.summary.threadId, open]).toEqual(["settled-chat", null]);
    expect(yield* overviewIds(monitoring)).toEqual({
      ids: ["settled-chat", "skewed-chat"],
      pending: 0,
      failed: 0,
    });
  }).pipe(Effect.scoped),
);

it.effect("counts the reopens after the chat first settled, however it settled", () =>
  Effect.gen(function* () {
    const { eventStore, monitoring, seedThread } = yield* makeHarness();
    yield* seedThread("reopened-chat");
    const settled = appThread("reopened-chat");
    const active = appThread("reopened-chat", null);
    const working = { ...active, settledOverride: null };
    const history = [
      // A turn on a chat pinned before it ever settled is not a reopen.
      ["thread.pinned", active],
      ["thread.unsettled", working],
      // A skipped scheduled recovery settles through a metadata update.
      ["thread.metadata-updated", settled],
      // Reopening by hand, then the turn it starts, is one reopen.
      ["thread.unsettled", active],
      ["thread.unsettled", working],
      ["thread.settled", settled],
      // A pin brings a settled chat back with no unsettle event.
      ["thread.pinned", active],
      ["thread.settled", settled],
      ["thread.unsettled", working],
      ["thread.settled", settled],
      ["thread.unsettled", active],
      ["thread.unsettled", working],
    ] as const;
    yield* eventStore.appendAgentEvents({
      events: history.map(([type, thread], index) => domainEvent(type, thread, `${index}`)),
    });

    const detail = yield* monitoring.thread({ threadId: ThreadId.make("reopened-chat") });

    expect(detail?.summary.reopens).toBe(4);
  }).pipe(Effect.scoped),
);

it.effect("does not store an analysis whose chat settled again while it ran", () =>
  Effect.gen(function* () {
    const duringPricing = { effect: Effect.void };
    const { monitoring, seedThread, sql } = yield* makeHarness(() =>
      Effect.suspend(() => duringPricing.effect).pipe(Effect.as([])),
    );
    yield* seedThread("settled-chat");
    duringPricing.effect = sql`
      UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.settledAt', '2026-01-11T00:00:00.000Z')
      WHERE thread_id = 'settled-chat'
    `.pipe(Effect.orDie, Effect.asVoid);

    yield* monitoring.thread({ threadId: ThreadId.make("settled-chat") });

    expect(yield* sql`SELECT thread_id FROM monitoring_thread_analyses`).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("stores a chat whose analysis fails and analyzes it again later", () =>
  Effect.gen(function* () {
    const pricing: { result: Effect.Effect<ReadonlyArray<number | null>, UsageReadError> } = {
      result: Effect.fail(
        new UsageReadError({ reason: "scanFailed", detail: "The usage store is offline." }),
      ),
    };
    const { events, monitoring, seedThread, sql } = yield* makeHarness(() =>
      Effect.suspend(() => pricing.result),
    );
    yield* seedThread("failing-chat");
    yield* seedThread("crashing-chat", { settledAt: "2026-01-10T03:00:00.000Z" });
    yield* seedThread("bad-settle", { settledAt: "2026-01-10Tbad" });
    yield* sql`
      UPDATE orchestration_v2_projection_threads SET project_id = 'project-2'
      WHERE thread_id = 'crashing-chat'
    `;
    const failedRows = sql<{ readonly thread_id: string; readonly error: string | null }>`
      SELECT thread_id, error FROM monitoring_thread_analyses ORDER BY thread_id
    `;
    expect(yield* unanalyzedOf(monitoring)).toEqual([
      { projectId: "project-1", pending: 2, failed: 0 },
      { projectId: "project-2", pending: 1, failed: 0 },
    ]);

    yield* monitoring.start();
    const failed = yield* nextChange(monitoring, 0);
    expect(yield* overviewIds(monitoring)).toEqual({ ids: [], pending: 0, failed: 3 });
    expect(yield* unanalyzedOf(monitoring)).toEqual([
      { projectId: "project-1", pending: 0, failed: 2 },
      { projectId: "project-2", pending: 0, failed: 1 },
    ]);

    pricing.result = Effect.die("pricing bug");
    yield* TestClock.adjust("30 minutes");
    yield* Queue.offer(events, domainEvent("thread.settled", appThread("failing-chat")));
    const retried = yield* nextChange(monitoring, failed);
    expect(yield* failedRows).toEqual([
      {
        thread_id: "bad-settle",
        error: "The analysis failed: The chat's stored settle time is damaged.",
      },
      { thread_id: "crashing-chat", error: "The analysis failed: pricing bug" },
      { thread_id: "failing-chat", error: "The analysis failed: pricing bug" },
    ]);

    pricing.result = Effect.succeed([]);
    yield* TestClock.adjust("30 minutes");
    yield* Queue.offer(events, domainEvent("thread.settled", appThread("failing-chat")));
    yield* nextChange(monitoring, retried);
    expect(yield* overviewIds(monitoring)).toEqual({
      ids: ["crashing-chat", "failing-chat"],
      pending: 0,
      failed: 1,
    });
    expect(yield* unanalyzedOf(monitoring)).toEqual([
      { projectId: "project-1", pending: 0, failed: 1 },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("announces a backfill after eight passes and when it runs out of chats", () =>
  Effect.gen(function* () {
    // Passes of 25 chats; the first chat of the eighth and of the ninth waits for the test, which
    // opens a chat there. Opening announces before it returns, so the latest revision is exact.
    const gate = (call: number) =>
      Effect.all({ reached: Deferred.make<void>(), finish: Deferred.make<void>() }).pipe(
        Effect.map((deferreds) => ({ call, ...deferreds })),
      );
    const eighth = yield* gate(7 * 25 + 1);
    const ninth = yield* gate(8 * 25 + 2);
    let calls = 0;
    const { monitoring, seedThread } = yield* makeHarness(() =>
      Effect.suspend(() => {
        calls++;
        const gated = [eighth, ninth].find(({ call }) => call === calls);
        if (gated === undefined) return Effect.succeed([]);
        return Deferred.succeed(gated.reached, undefined).pipe(
          Effect.andThen(Deferred.await(gated.finish)),
          Effect.as([]),
        );
      }),
    );
    const backfill = 8 * 25 + 5;
    for (let index = 0; index < backfill; index++) {
      yield* seedThread(`backfill-${String(index).padStart(3, "0")}`);
    }
    const open = (threadId: string) =>
      seedThread(threadId).pipe(
        Effect.andThen(monitoring.thread({ threadId: ThreadId.make(threadId) })),
        Effect.andThen(nextChange(monitoring, 0)),
      );

    yield* monitoring.start();
    yield* Deferred.await(eighth.reached);
    const atEighth = yield* open("opened-early");
    yield* Deferred.succeed(eighth.finish, undefined);
    yield* Deferred.await(ninth.reached);
    const atNinth = yield* open("opened-late");
    yield* Deferred.succeed(ninth.finish, undefined);
    const drained = yield* nextChange(monitoring, atNinth);
    const { ids, pending, failed } = yield* overviewIds(monitoring);

    expect({ atEighth, atNinth, drained, analyzed: ids.length, pending, failed }).toEqual({
      atEighth: 1,
      atNinth: 3,
      drained: 4,
      analyzed: backfill + 2,
      pending: 0,
      failed: 0,
    });
  }).pipe(Effect.scoped),
);

it.effect("shows a renamed or moved chat by its current title and project at once", () =>
  Effect.gen(function* () {
    // The second chat analyzed waits for the scope to end, so it stays pending.
    const held = yield* Deferred.make<void>();
    let calls = 0;
    const { events, monitoring, seedThread, sql } = yield* makeHarness(() =>
      Effect.suspend(() => {
        calls++;
        return calls === 2 ? Deferred.await(held).pipe(Effect.as([])) : Effect.succeed([]);
      }),
    );
    yield* seedThread("moved-chat");
    yield* monitoring.start();
    const analyzed = yield* nextChange(monitoring, 0);

    yield* sql`
      UPDATE orchestration_v2_projection_threads SET title = 'New name', project_id = 'project-2'
      WHERE thread_id = 'moved-chat'
    `;
    yield* Queue.offer(events, domainEvent("thread.metadata-updated", appThread("moved-chat")));
    const renamed = yield* nextChange(monitoring, analyzed);
    const overview = yield* monitoring.overview(january());
    const listed = (projectId: string) =>
      monitoring
        .chats({
          since: SINCE,
          until: UNTIL,
          projectId: ProjectId.make(projectId),
          sort: "settledAt",
          direction: "desc",
          limit: 500,
          offset: 0,
        })
        .pipe(
          Effect.map((result) =>
            result.chats.map(({ summary }) => ({
              title: summary.title,
              project: summary.projectId,
            })),
          ),
        );

    const moved = yield* listed("project-2");
    const left = yield* listed("project-1");

    // A change it cannot look up is announced too, so no view keeps an old title or project.
    yield* sql`ALTER TABLE orchestration_v2_projection_threads RENAME TO unreadable_threads`;
    yield* Queue.offer(
      events,
      domainEvent("thread.metadata-updated", appThread("moved-chat"), "unreadable"),
    );
    const unreadable = yield* nextChange(monitoring, renamed);
    yield* sql`ALTER TABLE unreadable_threads RENAME TO orchestration_v2_projection_threads`;

    // A chat still being analyzed counts as pending under the project it moved to.
    yield* seedThread("pending-chat");
    yield* sql`
      UPDATE orchestration_v2_projection_threads SET project_id = 'project-2'
      WHERE thread_id = 'pending-chat'
    `;
    yield* Queue.offer(events, domainEvent("thread.metadata-updated", appThread("pending-chat")));
    const pendingMoved = yield* nextChange(monitoring, unreadable);

    expect({
      groups: overview.groups.map((group) => group.projectId),
      moved,
      left,
      announced: unreadable - renamed,
      pendingAnnounced: pendingMoved - unreadable,
      unanalyzed: yield* unanalyzedOf(monitoring),
    }).toEqual({
      groups: ["project-2"],
      moved: [{ title: "New name", project: "project-2" }],
      left: [],
      announced: 1,
      pendingAnnounced: 1,
      unanalyzed: [{ projectId: "project-2", pending: 1, failed: 0 }],
    });
  }).pipe(Effect.scoped),
);

it.effect("sums every analyzed chat of the window into groups on the days the viewer sent", () =>
  Effect.gen(function* () {
    const { monitoring, seedAnalyzed } = yield* makeHarness();
    // More chats than the overview reads per query, and more than it once returned at most.
    for (let index = 0; index < 2_001; index++) {
      // For a viewer whose days start at 07:00 UTC, 02:00 UTC is still the day before.
      const settledAt = index % 2 === 0 ? SETTLED_AT : "2026-01-10T23:30:00.000Z";
      yield* seedAnalyzed(analyzedSummary(`chat-${index}`, settledAt));
    }
    yield* seedAnalyzed(analyzedSummary("day-start", "2026-01-10T07:00:00.000Z"));
    yield* seedAnalyzed(analyzedSummary("before-window", "2026-01-01T06:59:00.000Z"));
    yield* seedAnalyzed(analyzedSummary("old-analysis", SETTLED_AT), {
      analyzerVersion: ANALYZER_VERSION - 1,
    });

    const overview = yield* monitoring.overview(january(7));

    expect({
      days: overview.groups
        .map((group) => ({
          day: group.day,
          chats: group.lifetimesMs.length,
          costUsd: group.costUsd,
          inputTokens: group.tokens.inputTokens,
        }))
        .sort((a, b) => a.day.localeCompare(b.day)),
      unanalyzed: overview.unanalyzed,
    }).toEqual({
      days: [
        { day: "2026-01-09", chats: 1_001, costUsd: 500.5, inputTokens: 100_100 },
        { day: "2026-01-10", chats: 1_001, costUsd: 500.5, inputTokens: 100_100 },
      ],
      unanalyzed: [{ projectId: "project-1", pending: 1, failed: 0 }],
    });
  }).pipe(Effect.scoped),
);

it.effect("splits groups by project, kind and main model and sums each finding once per chat", () =>
  Effect.gen(function* () {
    const { monitoring, seedAnalyzed } = yield* makeHarness();
    const slow = { code: "slow_command", count: 2, wastedMs: 1_000, detail: null } as const;
    yield* seedAnalyzed(
      analyzedSummary("a", SETTLED_AT, {
        findings: [{ ...slow, severity: "low" }],
        phases: [{ phase: "test", count: 2, failed: 1, durationMs: 4_000 }],
      }),
    );
    // Two findings of one code still count the chat once.
    yield* seedAnalyzed(
      analyzedSummary("b", SETTLED_AT, {
        findings: [
          { ...slow, severity: "high" },
          { ...slow, severity: "low", count: 1, wastedMs: 500 },
        ],
        phases: [{ phase: "test", count: 1, failed: 0, durationMs: 1_000 }],
      }),
    );
    // Each differs from "a" by its kind, its project or its main model alone.
    yield* seedAnalyzed(analyzedSummary("c", SETTLED_AT, { kind: "scheduled" }));
    yield* seedAnalyzed(
      analyzedSummary("d", SETTLED_AT, { projectId: ProjectId.make("project-2") }),
    );
    yield* seedAnalyzed(
      analyzedSummary("e", SETTLED_AT, { models: ["claude-other", "claude-test"] }),
    );

    const overview = yield* monitoring.overview(january());

    expect(
      overview.groups
        .map((group) => ({
          project: group.projectId,
          kind: group.kind,
          model: group.model,
          chats: group.lifetimesMs.length,
          findings: group.findings,
          phases: group.phases,
        }))
        .sort((a, b) =>
          `${a.project}:${a.kind}:${a.model}`.localeCompare(`${b.project}:${b.kind}:${b.model}`),
        ),
    ).toEqual([
      {
        project: "project-1",
        kind: "interactive",
        model: "claude-other",
        chats: 1,
        findings: [],
        phases: [],
      },
      {
        project: "project-1",
        kind: "interactive",
        model: "claude-test",
        chats: 2,
        findings: [
          { code: "slow_command", severity: "high", chats: 2, occurrences: 5, wastedMs: 2_500 },
        ],
        phases: [{ phase: "test", count: 3, failed: 1, durationMs: 5_000 }],
      },
      {
        project: "project-1",
        kind: "scheduled",
        model: "claude-test",
        chats: 1,
        findings: [],
        phases: [],
      },
      {
        project: "project-2",
        kind: "interactive",
        model: "claude-test",
        chats: 1,
        findings: [],
        phases: [],
      },
    ]);
  }).pipe(Effect.scoped),
);

it.effect(
  "refuses an overview whose days are not real days, each starting after the one before, and an impossible or reversed list window",
  () =>
    Effect.gen(function* () {
      const { monitoring } = yield* makeHarness();
      const day = (name: string) => ({ day: name, since: `${name}T00:00:00.000Z` });
      const inputs: ReadonlyArray<MonitoringOverviewInput> = [
        { days: [day("2026-01-02"), day("2026-01-01")], until: UNTIL },
        { days: [day("2026-01-01"), day("2026-01-02")], until: day("2026-01-02").since },
        { days: [day("2026-01-01"), { day: "2026-01-02", since: "not a time" }], until: UNTIL },
        // February 30 parses as March 2, so neither a start nor a name may be one.
        {
          days: [day("2026-01-01"), { day: "2026-01-02", since: "2026-02-30T00:00:00.000Z" }],
          until: "2026-03-05T00:00:00.000Z",
        },
        {
          days: [day("2026-01-01"), { day: "2026-02-30", since: day("2026-01-02").since }],
          until: UNTIL,
        },
      ];

      const errors = yield* Effect.forEach(inputs, (input) =>
        monitoring.overview(input).pipe(Effect.flip),
      );
      const listErrors = yield* Effect.forEach(
        [
          { since: "2026-02-30T00:00:00.000Z", until: "2026-03-05T00:00:00.000Z" },
          { since: "2026-11-21T00:00:00.000Z", until: "2026-11-20T00:00:00.000Z" },
          { since: "2026-11-20T00:00:00.000Z", until: "2026-11-20T00:00:00.000Z" },
        ],
        (window) => listChats(monitoring, window).pipe(Effect.flip),
      );

      expect([...errors, ...listErrors].map((error) => isMonitoringError(error))).toEqual([
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
      ]);
    }).pipe(Effect.scoped),
);

it.effect("lists the chats that match in the requested order and counts every match", () =>
  Effect.gen(function* () {
    const { monitoring, seedAnalyzed } = yield* makeHarness();
    const slow = {
      code: "slow_command",
      severity: "medium",
      count: 1,
      wastedMs: 1_000,
      detail: null,
    } as const;
    yield* seedAnalyzed(analyzedSummary("a", SETTLED_AT, { costUsd: 3, findings: [slow] }));
    yield* seedAnalyzed(
      analyzedSummary("b", "2026-01-11T00:00:00.000Z", { kind: "scheduled", costUsd: 5 }),
    );
    yield* seedAnalyzed(
      analyzedSummary("c", "2026-01-12T00:00:00.000Z", {
        models: [],
        costUsd: 1,
        findings: [slow],
      }),
    );
    yield* seedAnalyzed(
      analyzedSummary("d", "2026-01-13T00:00:00.000Z", {
        projectId: ProjectId.make("project-2"),
        costUsd: 4,
        runs: { ...analyzedSummary("d", SETTLED_AT).runs, failed: 2 },
      }),
    );

    expect([
      yield* listChats(monitoring),
      yield* listChats(monitoring, { sort: "costUsd", limit: 2 }),
      yield* listChats(monitoring, { sort: "costUsd", limit: 2, offset: 2 }),
      yield* listChats(monitoring, { sort: "costUsd", limit: 2, offset: 4 }),
      yield* listChats(monitoring, {
        kind: "interactive",
        model: "claude-test",
        sort: "costUsd",
        direction: "asc",
      }),
      yield* listChats(monitoring, { model: "", findingCode: "slow_command" }),
      yield* listChats(monitoring, { projectId: ProjectId.make("project-2") }),
      yield* listChats(monitoring, { sort: "failures", limit: 1 }),
      yield* listChats(monitoring, { since: "2026-01-12T00:00:00.000Z" }),
    ]).toEqual([
      { ids: ["d", "c", "b", "a"], total: 4 },
      { ids: ["b", "d"], total: 4 },
      { ids: ["a", "c"], total: 4 },
      { ids: [], total: 4 },
      { ids: ["a", "d"], total: 2 },
      { ids: ["c"], total: 1 },
      { ids: ["d"], total: 1 },
      { ids: ["d"], total: 4 },
      { ids: ["d", "c"], total: 2 },
    ]);
    const byFindings = yield* monitoring.chats({
      since: SINCE,
      until: UNTIL,
      sort: "findings",
      direction: "desc",
      limit: 3,
      offset: 0,
    });
    expect(byFindings.chats.map((chat) => [chat.summary.threadId, chat.sortValue])).toEqual([
      ["c", 1],
      ["a", 1],
      ["d", 0],
    ]);
  }).pipe(Effect.scoped),
);

it.effect("orders chats by their settle time, then by thread id", () =>
  Effect.gen(function* () {
    const { monitoring, seedAnalyzed } = yield* makeHarness();
    yield* seedAnalyzed(analyzedSummary("early", "2026-01-09T23:00:00.000Z"));
    yield* seedAnalyzed(analyzedSummary("y", "2026-01-09T23:30:00.000Z"));
    yield* seedAnalyzed(analyzedSummary("x", "2026-01-09T23:30:00.000Z"));

    const bySettle = yield* monitoring.chats({
      since: SINCE,
      until: UNTIL,
      sort: "settledAt",
      direction: "desc",
      limit: 500,
      offset: 0,
    });
    expect([
      bySettle.chats.map((chat) => [chat.summary.threadId, chat.sortValue]),
      yield* listChats(monitoring, { limit: 1 }),
      yield* listChats(monitoring, { sort: "costUsd" }),
    ]).toEqual([
      [
        ["x", Date.parse("2026-01-09T23:30:00.000Z")],
        ["y", Date.parse("2026-01-09T23:30:00.000Z")],
        ["early", Date.parse("2026-01-09T23:00:00.000Z")],
      ],
      { ids: ["x"], total: 3 },
      { ids: ["x", "y", "early"], total: 3 },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("counts a stored analysis it cannot read as failed instead of dropping it", () =>
  Effect.gen(function* () {
    const { monitoring, seedAnalyzed, sql } = yield* makeHarness();
    yield* seedAnalyzed(analyzedSummary("readable", SETTLED_AT));
    yield* seedAnalyzed(analyzedSummary("broken-before-overview", SETTLED_AT));
    yield* seedAnalyzed(analyzedSummary("broken-before-list", SETTLED_AT));
    const seedBadSettle = (threadId: string) =>
      seedAnalyzed(analyzedSummary(threadId, SETTLED_AT), { settledAt: "2026-01-10Tbad" });
    yield* seedBadSettle("bad-settle-before-overview");
    // The analyzer dates its summary by its row's settle time, in the same text.
    const seedSummarySettle = (threadId: string, summarySettledAt: string) =>
      seedAnalyzed(analyzedSummary(threadId, summarySettledAt), { settledAt: SETTLED_AT });
    yield* seedSummarySettle("summary-settle-broken", "broken");
    const breakSummary = (threadId: string) => sql`
      UPDATE monitoring_thread_analyses SET summary_json = '{"threadId":"broken"}'
      WHERE thread_id = ${threadId}
    `;

    yield* breakSummary("broken-before-overview");
    const overview = yield* monitoring.overview(january());
    yield* breakSummary("broken-before-list");
    yield* seedBadSettle("bad-settle-before-list");
    yield* seedSummarySettle("summary-settle-other", CREATED_AT);
    const listed = yield* listChats(monitoring);

    expect({
      grouped: overview.groups.reduce((total, group) => total + group.lifetimesMs.length, 0),
      unanalyzed: overview.unanalyzed,
      listed,
      revision: yield* nextChange(monitoring, 0),
      rows: yield* sql`
        SELECT thread_id, summary_json, error FROM monitoring_thread_analyses
        WHERE error IS NOT NULL ORDER BY thread_id
      `,
    }).toEqual({
      grouped: 2,
      unanalyzed: [{ projectId: "project-1", pending: 0, failed: 3 }],
      listed: { ids: ["readable"], total: 1 },
      revision: 2,
      rows: [
        {
          thread_id: "bad-settle-before-list",
          summary_json: null,
          error: "The stored analysis could not be read.",
        },
        {
          thread_id: "bad-settle-before-overview",
          summary_json: null,
          error: "The stored analysis could not be read.",
        },
        {
          thread_id: "broken-before-list",
          summary_json: null,
          error: "The stored analysis could not be read.",
        },
        {
          thread_id: "broken-before-overview",
          summary_json: null,
          error: "The stored analysis could not be read.",
        },
        {
          thread_id: "summary-settle-broken",
          summary_json: null,
          error: "The stored analysis could not be read.",
        },
        {
          thread_id: "summary-settle-other",
          summary_json: null,
          error: "The stored analysis could not be read.",
        },
      ],
    });
  }).pipe(Effect.scoped),
);
