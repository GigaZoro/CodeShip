import { expect, it } from "@effect/vitest";
import type { OrchestrationV2AppThread, OrchestrationV2DomainEvent } from "@t3tools/contracts";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  UsageReadError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as MonitoringService from "./MonitoringService.ts";

const SINCE = "2026-01-01T00:00:00.000Z";
const UNTIL = "2026-02-01T00:00:00.000Z";
const CREATED_AT = "2026-01-10T00:00:00.000Z";
const SETTLED_AT = "2026-01-10T02:00:00.000Z";

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

  return { eventStore, events, monitoring, seedThread, sql };
});

const overviewIds = (monitoring: MonitoringService.MonitoringService["Service"]) =>
  monitoring.overview({ since: SINCE, until: UNTIL }).pipe(
    Effect.map((result) => ({
      ids: result.threads.map((t) => t.threadId),
      pending: result.pendingAnalysis,
      failed: result.failedAnalysis,
    })),
  );

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

it.effect("lists a chat under its current project and title after it moved", () =>
  Effect.gen(function* () {
    const { monitoring, seedThread, sql } = yield* makeHarness();
    yield* seedThread("moved-chat");
    yield* monitoring.start();
    yield* nextChange(monitoring, 0);

    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET project_id = 'project-2', title = 'Renamed chat'
      WHERE thread_id = 'moved-chat'
    `;
    const current = { projectId: "project-2", title: "Renamed chat" };
    const { threads } = yield* monitoring.overview({ since: SINCE, until: UNTIL });
    expect(threads).toMatchObject([current]);
    expect(yield* monitoring.summaries([ThreadId.make("moved-chat")])).toMatchObject([current]);
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
    const reanalyzed = yield* nextChange(monitoring, analyzed);
    const stored = yield* sql<{ readonly settled_at: string }>`
      SELECT settled_at FROM monitoring_thread_analyses
    `;
    expect(stored).toEqual([{ settled_at: resettledAt }]);

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
    // Settled before it was created: the summary clamps the settle, the stored key must not.
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
    const failedRows = sql<{ readonly thread_id: string; readonly error: string | null }>`
      SELECT thread_id, error FROM monitoring_thread_analyses ORDER BY thread_id
    `;

    yield* monitoring.start();
    const failed = yield* nextChange(monitoring, 0);
    expect(yield* overviewIds(monitoring)).toEqual({ ids: [], pending: 0, failed: 2 });

    pricing.result = Effect.die("pricing bug");
    yield* TestClock.adjust("30 minutes");
    yield* Queue.offer(events, domainEvent("thread.settled", appThread("failing-chat")));
    const retried = yield* nextChange(monitoring, failed);
    expect(yield* failedRows).toEqual([
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
      failed: 0,
    });
  }).pipe(Effect.scoped),
);
