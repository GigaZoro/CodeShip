import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import type {
  MonitoringChange,
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
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
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
  type:
    | "thread.created"
    | "thread.settled"
    | "thread.unsettled"
    | "thread.pinned"
    | "thread.metadata-updated",
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
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.mock(UsageService.UsageService)({ priceTokens, clientSettingsKey: () => "unused" }),
    ),
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

const nextNotice = Effect.fn("nextNotice")(function* (
  monitoring: MonitoringService.MonitoringService["Service"],
  seen: number,
) {
  const next = yield* Stream.runHead(
    monitoring.subscribeChanges.pipe(Stream.filter((change) => change.revision > seen)),
  ).pipe(Effect.forkChild);
  yield* TestClock.adjust("3 seconds");
  return Option.getOrThrow(yield* Fiber.join(next));
});

const nextChange = (monitoring: MonitoringService.MonitoringService["Service"], seen: number) =>
  nextNotice(monitoring, seen).pipe(Effect.map((change) => change.revision));

const observeAnalysesStored = Effect.fn("observeAnalysesStored")(function* (count: number) {
  const done = yield* Deferred.make<void>();
  let stored = 0;
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      if (options.name !== "MonitoringService.storeRow") return span;
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        if (Exit.isSuccess(exit) && exit.value === true && ++stored === count) {
          Deferred.doneUnsafe(done, Effect.void);
        }
      };
      return span;
    },
  });
  return { tracer, done: Deferred.await(done) };
});

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
    const repriced = yield* Deferred.make<void>();
    let pricingCalls = 0;
    const { events, monitoring, seedThread, sql } = yield* makeHarness(() =>
      Effect.suspend(() =>
        ++pricingCalls === 2
          ? Deferred.succeed(repriced, undefined).pipe(Effect.as([]))
          : Effect.succeed([]),
      ),
    );
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
    const stored = sql<{ readonly settled_at: string }>`
      SELECT settled_at FROM monitoring_thread_analyses
    `;
    yield* Deferred.await(repriced);
    const reanalyzed = yield* nextChange(monitoring, analyzed);
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

it.effect("reads the stored detail and returns nothing for one that is not settled", () =>
  Effect.gen(function* () {
    const { monitoring, seedThread, sql } = yield* makeHarness();
    yield* seedThread("settled-chat");
    yield* seedThread("open-chat", { settledOverride: "active" });
    // Stamped as settled before it was created: its summary and stored key keep that stamp alike.
    yield* seedThread("skewed-chat", { settledAt: "2026-01-09T23:00:00.000Z" });

    yield* monitoring.start();
    yield* nextChange(monitoring, 0);
    const detail = yield* monitoring.thread({ threadId: ThreadId.make("settled-chat") });
    const open = yield* monitoring.thread({ threadId: ThreadId.make("open-chat") });

    expect([detail.detail?.summary.threadId, open.detail]).toEqual(["settled-chat", null]);
    yield* sql`DROP TABLE orchestration_v2_projection_runs`;
    expect(yield* monitoring.thread({ threadId: ThreadId.make("settled-chat") })).toEqual(detail);
    expect(yield* overviewIds(monitoring)).toEqual({
      ids: ["settled-chat", "skewed-chat"],
      pending: 0,
      failed: 0,
    });
  }).pipe(Effect.scoped),
);

it.effect("selects only IDs in one sweep and uses indexed point lookups to recheck them", () =>
  Effect.gen(function* () {
    const { monitoring, seedThread, sql } = yield* makeHarness();
    for (let i = 0; i < 27; i++) yield* seedThread(`candidate-${i}`);
    const scans: string[][] = [];
    const points: string[][] = [];
    const projections: string[] = [];
    const observe: Statement.Transformer = (statement) =>
      Effect.gen(function* () {
        const [query, params] = statement.compile();
        if (!query.includes("m.attempts = 0 OR m.retry_at <=")) return statement;
        if (!query.includes("t.thread_id = ?"))
          projections.push(query.slice(0, query.indexOf("FROM")).trim());
        const queryPlan = yield* sql
          .unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params)
          .pipe(Effect.provideService(Statement.CurrentTransformer, undefined), Effect.orDie);
        const plans = query.includes("t.thread_id = ?") ? points : scans;
        plans.push(queryPlan.map(({ detail }) => detail));
        return statement;
      });
    const stored = yield* observeAnalysesStored(27);
    yield* monitoring
      .start()
      .pipe(
        Effect.provideService(Statement.CurrentTransformer, observe),
        Effect.withTracer(stored.tracer),
      );
    yield* stored.done;
    expect((yield* overviewIds(monitoring)).ids).toHaveLength(27);
    expect(scans).toHaveLength(1);
    expect(projections).toEqual(["SELECT t.thread_id"]);
    expect(points).toHaveLength(27);
    expect(points.every((plan) => plan.some((step) => step.includes("SEARCH t USING INDEX")))).toBe(
      true,
    );
  }).pipe(Effect.scoped),
);

it.effect(
  "reads stored details on the interactive pool and does not erase a concurrent repair",
  () =>
    Effect.gen(function* () {
      const { monitoring, seedThread, sql } = yield* makeHarness();
      yield* seedThread("repaired-chat");
      yield* monitoring.start();
      yield* nextChange(monitoring, 0);
      const threadId = ThreadId.make("repaired-chat");
      const previous = yield* monitoring.thread({ threadId });
      const [stored] = yield* sql<{
        detail_json: string;
      }>`SELECT detail_json FROM monitoring_thread_analyses WHERE thread_id = ${threadId}`;
      yield* sql`UPDATE monitoring_thread_analyses SET detail_json = '{}' WHERE thread_id = ${threadId}`;
      const detailsReadInBackground: boolean[] = [];
      const repair: Statement.Transformer = (statement) =>
        Effect.gen(function* () {
          const [query] = statement.compile();
          if (query.includes("SELECT m.thread_id, m.settled_at, m.summary_json, m.detail_json")) {
            detailsReadInBackground.push(yield* NodeSqliteClient.Background);
          }
          if (query.includes("SET summary_json = NULL, detail_json = NULL")) {
            yield* sql`UPDATE monitoring_thread_analyses SET detail_json = ${stored!.detail_json} WHERE thread_id = ${threadId}`.pipe(
              Effect.provideService(Statement.CurrentTransformer, undefined),
              Effect.orDie,
            );
          }
          return statement;
        });
      yield* monitoring
        .thread({ threadId })
        .pipe(Effect.provideService(Statement.CurrentTransformer, repair), Effect.flip);
      expect(detailsReadInBackground).toEqual([false]);
      expect((yield* monitoring.thread({ threadId })).detail).toEqual(previous.detail);
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

    yield* monitoring.start();
    yield* nextChange(monitoring, 0);
    const detail = yield* monitoring.thread({ threadId: ThreadId.make("reopened-chat") });

    expect(detail.detail?.summary.reopens).toBe(4);
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

    yield* monitoring.start();
    yield* TestClock.adjust("3 seconds");

    expect(yield* sql`SELECT thread_id FROM monitoring_thread_analyses`).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("backs off unchanged failures without announcing them and publishes a recovery", () =>
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

    yield* TestClock.adjust("30 minutes");
    expect((yield* monitoring.overview(january())).revision).toBe(failed);
    expect(yield* sql`SELECT DISTINCT attempts FROM monitoring_thread_analyses`).toEqual([
      { attempts: 2 },
    ]);
    expect(yield* failedRows).toEqual([
      {
        thread_id: "bad-settle",
        error: "The analysis failed: The chat's stored settle time is damaged.",
      },
      {
        thread_id: "crashing-chat",
        error: "The analysis failed: Usage read failed (scanFailed): The usage store is offline.",
      },
      {
        thread_id: "failing-chat",
        error: "The analysis failed: Usage read failed (scanFailed): The usage store is offline.",
      },
    ]);

    pricing.result = Effect.succeed([]);
    yield* TestClock.adjust("30 minutes");
    yield* Queue.offer(events, domainEvent("thread.settled", appThread("failing-chat")));
    yield* TestClock.adjust("3 seconds");
    expect((yield* monitoring.overview(january())).revision).toBe(failed);
    expect(yield* sql`SELECT DISTINCT attempts FROM monitoring_thread_analyses`).toEqual([
      { attempts: 2 },
    ]);
    yield* TestClock.adjust("30 minutes");
    yield* nextChange(monitoring, failed);
    expect(yield* overviewIds(monitoring)).toEqual({
      ids: ["crashing-chat", "failing-chat"],
      pending: 0,
      failed: 1,
    });
    expect(yield* unanalyzedOf(monitoring)).toEqual([
      { projectId: "project-1", pending: 0, failed: 1 },
    ]);
    yield* TestClock.adjust("15 hours");
    const abandoned = sql`SELECT attempts, retry_at FROM monitoring_thread_analyses WHERE thread_id = 'bad-settle'`;
    expect(yield* abandoned).toEqual([{ attempts: 6, retry_at: null }]);
    yield* TestClock.adjust("1 day");
    expect(yield* abandoned).toEqual([{ attempts: 6, retry_at: null }]);
    const failedDetail = yield* monitoring
      .thread({ threadId: ThreadId.make("bad-settle") })
      .pipe(Effect.flip);
    expect(failedDetail.message).toBe(
      "The analysis failed: The chat's stored settle time is damaged.",
    );
  }).pipe(Effect.scoped),
);

it.effect("records malformed details as failed and advances beyond a full batch of them", () =>
  Effect.gen(function* () {
    const { monitoring, seedThread, sql } = yield* makeHarness();
    yield* seedThread("valid", { settledAt: CREATED_AT });
    for (let index = 0; index < 25; index++) {
      const id = `malformed-${index}`;
      yield* seedThread(id);
      // The projection schema rejects these values before a normal write.
      const workflow = {
        agents: [{ label: "Worker", state: "queued", totalTokens: index === 0 ? -1 : 2 }],
      };
      yield* sql`
        INSERT INTO orchestration_v2_projection_subagents (
          subagent_id, thread_id, parent_node_id, provider, child_thread_id, origin, status, updated_at, payload_json
        ) VALUES (${id}, ${id}, 'parent', 'claude_test', '', 'provider', 'completed', ${SETTLED_AT},
          ${JSON.stringify({ workflow })})
      `;
    }
    const stored = yield* observeAnalysesStored(26);
    yield* monitoring.start().pipe(Effect.withTracer(stored.tracer));
    yield* stored.done;
    expect(yield* overviewIds(monitoring)).toEqual({ ids: ["valid"], pending: 0, failed: 25 });
    expect(
      yield* sql`
      SELECT count(*) AS failed FROM monitoring_thread_analyses
      WHERE error IS NOT NULL AND attempts = 1 AND retry_at IS NOT NULL
    `,
    ).toEqual([{ failed: 25 }]);
  }).pipe(Effect.scoped),
);

it.effect("batches a burst of settles and returns their revision on each read", () =>
  Effect.gen(function* () {
    const ids = ["first", "second", "third"];
    const { events, monitoring, seedThread } = yield* makeHarness();
    const stored = yield* observeAnalysesStored(1 + ids.length);
    yield* seedThread("at-startup");
    yield* monitoring.start().pipe(Effect.withTracer(stored.tracer));
    const startup = yield* nextChange(monitoring, 0);
    const collecting = yield* Queue.unbounded<MonitoringChange>();
    yield* Stream.runForEach(monitoring.subscribeChanges, (change) =>
      Queue.offer(collecting, change),
    ).pipe(Effect.forkScoped);
    expect((yield* Queue.take(collecting)).revision).toBe(startup);
    for (const id of ids) yield* seedThread(id);
    yield* Queue.offerAll(
      events,
      ids.map((id) => domainEvent("thread.settled", appThread(id))),
    );
    yield* stored.done;

    yield* TestClock.adjust("3 seconds");
    const batches = yield* Queue.clear(collecting);
    expect(batches).toHaveLength(1);
    const [batch] = batches;
    expect(batch).toBeDefined();
    expect(batch!.sinceRevision).toBe(startup);
    expect([...(batch!.threadIds ?? [])].sort()).toEqual(ids);
    expect((yield* monitoring.overview(january())).revision).toBe(batch!.revision);
    expect((yield* monitoring.thread({ threadId: ThreadId.make("first") })).revision).toBe(
      batch!.revision,
    );
  }).pipe(Effect.scoped),
);

it.effect(
  "announces a rename and a project-only move once each and uses the current title in the timeline",
  () =>
    Effect.gen(function* () {
      // The second chat analyzed waits for the scope to end, so it stays pending.
      let calls = 0;
      const { eventStore, events, monitoring, seedThread, sql } = yield* makeHarness(() =>
        Effect.suspend(() => {
          calls++;
          return calls === 2 ? Effect.never : Effect.succeed([]);
        }),
      );
      yield* seedThread("moved-chat");
      yield* monitoring.start();
      const analyzed = yield* nextChange(monitoring, 0);

      const original = appThread("moved-chat");
      const send = (event: OrchestrationV2DomainEvent) => Queue.offer(events, event);
      yield* sql`ALTER TABLE orchestration_events RENAME TO hidden_events`;
      yield* send(domainEvent("thread.metadata-updated", original, "unchanged"));
      yield* TestClock.adjust("3 seconds");
      expect((yield* monitoring.overview(january())).revision).toBe(analyzed);
      yield* sql`ALTER TABLE hidden_events RENAME TO orchestration_events`;
      const unchanged = domainEvent("thread.metadata-updated", original, "after-compaction");
      yield* eventStore.appendAgentEvents({
        events: [
          domainEvent("thread.created", appThread("moved-chat", null)),
          domainEvent("thread.settled", original),
          unchanged,
        ],
      });
      yield* sql`DELETE FROM orchestration_events WHERE event_type = 'thread.settled'`;
      yield* send(unchanged);
      yield* TestClock.adjust("3 seconds");
      expect((yield* monitoring.overview(january())).revision).toBe(analyzed);

      yield* sql`
      UPDATE orchestration_v2_projection_threads SET title = 'New name'
      WHERE thread_id = 'moved-chat'
    `;
      yield* send(
        domainEvent(
          "thread.metadata-updated",
          {
            ...original,
            title: "New name",
          },
          "rename",
        ),
      );
      yield* TestClock.adjust("3 seconds");
      const renamed = (yield* monitoring.overview(january())).revision;
      expect(renamed).toBe(analyzed + 1);
      yield* sql`
      UPDATE orchestration_v2_projection_threads SET project_id = 'project-2'
      WHERE thread_id = 'moved-chat'
    `;
      yield* send(
        domainEvent(
          "thread.metadata-updated",
          {
            ...original,
            title: "New name",
            projectId: ProjectId.make("project-2"),
          },
          "move-only",
        ),
      );
      yield* TestClock.adjust("3 seconds");
      const overview = yield* monitoring.overview(january());
      expect(overview.revision).toBe(analyzed + 2);
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

      const detail = (yield* monitoring.thread({ threadId: original.id })).detail;
      expect(detail?.summary.title).toBe("New name");
      expect(detail?.lanes.find((lane) => lane.kind === "chat")?.label).toBe("New name");

      yield* seedThread("pending-chat");
      const pending = appThread("pending-chat");
      yield* sql`
      UPDATE orchestration_v2_projection_threads SET project_id = 'project-2'
      WHERE thread_id = 'pending-chat'
    `;
      yield* send(
        domainEvent(
          "thread.metadata-updated",
          {
            ...pending,
            projectId: ProjectId.make("project-2"),
          },
          "move",
        ),
      );
      yield* TestClock.adjust("3 seconds");
      const pendingMoved = (yield* monitoring.overview(january())).revision;
      expect(pendingMoved).toBe(analyzed + 3);
      yield* sql`ALTER TABLE monitoring_thread_analyses RENAME TO hidden_analyses`;
      yield* send(domainEvent("thread.metadata-updated", original, "unreadable"));
      yield* TestClock.adjust("3 seconds");
      yield* sql`ALTER TABLE hidden_analyses RENAME TO monitoring_thread_analyses`;
      expect((yield* monitoring.overview(january())).revision).toBe(analyzed + 4);

      expect({
        groups: overview.groups.map((group) => group.projectId),
        moved,
        left,
        unanalyzed: yield* unanalyzedOf(monitoring),
      }).toEqual({
        groups: ["project-2"],
        moved: [{ title: "New name", project: "project-2" }],
        left: [],
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
      revision: (yield* monitoring.overview(january())).revision,
      rows: yield* sql`
        SELECT thread_id, summary_json, error FROM monitoring_thread_analyses
        WHERE error IS NOT NULL ORDER BY thread_id
      `,
    }).toEqual({
      grouped: 2,
      unanalyzed: [{ projectId: "project-1", pending: 0, failed: 3 }],
      listed: { ids: ["readable"], total: 1 },
      revision: 6,
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
