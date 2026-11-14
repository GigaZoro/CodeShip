import { applyOrchestrationV2ProjectionEvent } from "../../../../packages/client-runtime/src/state/orchestrationV2Projection.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  PlanId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { projectTurnItemForWire } from "./WireProjection.ts";

const database = SqlitePersistence.layerMemory;
const eventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(database));
const projectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(database));
const stores = Layer.mergeAll(database, eventStoreProvided, projectionStoreProvided);
const layerTest = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const providerDriver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };

function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: "Turn item compaction",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function threadCreated(thread: OrchestrationV2AppThread, now: DateTime.Utc) {
  return {
    id: EventId.make("event:turn-item-compaction:thread"),
    type: "thread.created",
    threadId: thread.id,
    providerInstanceId,
    occurredAt: now,
    payload: thread,
  } satisfies OrchestrationV2DomainEvent;
}

const itemSpecs = [
  { key: "command", type: "command_execution", ordinal: 10 },
  { key: "reasoning", type: "reasoning", ordinal: 20 },
  { key: "todo", type: "todo_list", ordinal: 30 },
  { key: "commanded", type: "command_execution", ordinal: 40 },
] as const;

function itemEvent(
  threadId: ThreadId,
  now: DateTime.Utc,
  spec: (typeof itemSpecs)[number],
  revision: number,
  eventId = `event:turn-item-compaction:${spec.key}:${revision}`,
): OrchestrationV2DomainEvent {
  const id = TurnItemId.make(`turn-item:compaction:${spec.key}`);
  const growing = `${spec.key}:${revision}:` + "x".repeat((revision + 1) * 192);
  const completed = revision === 69;
  const base = {
    id,
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: spec.ordinal,
    status: completed ? ("completed" as const) : ("running" as const),
    title: spec.key,
    startedAt: now,
    completedAt: completed ? now : null,
    updatedAt: now,
  };
  let payload: OrchestrationV2TurnItem;
  switch (spec.type) {
    case "command_execution":
      payload = {
        ...base,
        type: "command_execution",
        input: `run ${spec.key}`,
        output: growing,
      };
      break;
    case "reasoning":
      payload = { ...base, type: "reasoning", text: growing, streaming: !completed };
      break;
    case "todo_list":
      payload = {
        ...base,
        type: "todo_list",
        planId: PlanId.make("plan:turn-item-compaction"),
        steps: [{ id: "step", text: growing, status: completed ? "completed" : "running" }],
        explanation: growing,
      };
      break;
  }
  return {
    id: EventId.make(eventId),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload,
  };
}

function subagentEvents(
  threadId: ThreadId,
  now: DateTime.Utc,
  revision: number,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const id = NodeId.make("subagent:turn-item-compaction");
  const prompt = revision === 0 ? "Review prompt A. ".repeat(40) : "Review prompt B. ".repeat(40);
  const progress = `Review progress ${revision}`;
  return [
    {
      id: EventId.make(`event:turn-item-compaction:subagent:${revision}`),
      type: "subagent.updated",
      threadId,
      occurredAt: now,
      payload: {
        id,
        threadId,
        runId: null,
        parentNodeId: NodeId.make("node:turn-item-compaction-parent"),
        origin: "provider_native",
        createdBy: "agent",
        driver: providerDriver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: {
          driver: providerDriver,
          nativeId: "compaction-review",
          strength: "strong",
        },
        prompt,
        progress,
        title: "Review",
        model: null,
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    },
    {
      id: EventId.make(`event:turn-item-compaction:subagent-item:${revision}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("turn-item:compaction:subagent"),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 50,
        status: "running",
        title: "Review",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "subagent",
        subagentId: id,
        origin: "provider_native",
        driver: providerDriver,
        providerInstanceId,
        childThreadId: null,
        prompt,
        progress,
        result: null,
      },
    },
  ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
}

it.effect(
  "compacts ordinary snapshots while preserving replay, prompts, command lookup, and positions",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:turn-item-compaction");
      const thread = makeThread(threadId, now);
      const writes = [...(yield* sink.write({ events: [threadCreated(thread, now)] }))];
      const commandId = CommandId.make("command:turn-item-compaction:middle");
      const snapshotsPerItem = 70;
      for (let revision = 0; revision < snapshotsPerItem; revision += 1) {
        const order =
          revision === 0
            ? [itemSpecs[0], itemSpecs[1], itemSpecs[2], itemSpecs[3]]
            : [itemSpecs[1], itemSpecs[0], itemSpecs[2], itemSpecs[3]];
        const events = order
          .filter((spec) => spec.key !== "commanded" || revision !== 35)
          .map((spec) => itemEvent(threadId, now, spec, revision));
        if (revision < 3) events.push(...subagentEvents(threadId, now, revision));
        const stored = yield* sink.write({ events });
        writes.push(...stored);
        if (revision === 35) {
          const middle = itemEvent(
            threadId,
            now,
            itemSpecs[3],
            revision,
            "event:turn-item-compaction:commanded:middle",
          );
          writes.push(...(yield* sink.write({ commandId, events: [middle] })));
        }
      }
      const beforeProjection = yield* projections.getThreadProjection(threadId);
      const highWater = yield* eventStore.latestSequence();
      const bytes = yield* sql<{ readonly rows: number; readonly payload_bytes: number }>`
      SELECT COUNT(*) AS rows, COALESCE(SUM(octet_length(payload_json)), 0) AS payload_bytes
      FROM orchestration_events WHERE stream_id = ${threadId}
    `;
      const summary = yield* maintenance.compactEventStore();
      const replay = yield* eventStore.read({ threadId }).pipe(Stream.runCollect);
      const expectedIds = new Set([
        "event:turn-item-compaction:thread",
        ...itemSpecs.flatMap((spec) => [
          `event:turn-item-compaction:${spec.key}:0`,
          `event:turn-item-compaction:${spec.key}:${snapshotsPerItem - 1}`,
        ]),
        "event:turn-item-compaction:commanded:middle",
        ...Array.from({ length: 3 }, (_, revision) => [
          `event:turn-item-compaction:subagent:${revision}`,
          `event:turn-item-compaction:subagent-item:${revision}`,
        ]).flat(),
      ]);
      assert.deepEqual(
        replay,
        writes.filter((stored) => expectedIds.has(stored.event.id)),
      );
      assert.lengthOf(replay, 16);
      assert.equal(summary.deletedEventCount, bytes[0]!.rows - replay.length);
      assert.isBelow(
        (yield* sql<{ readonly payload_bytes: number }>`
        SELECT COALESCE(SUM(octet_length(payload_json)), 0) AS payload_bytes
        FROM orchestration_events WHERE stream_id = ${threadId}
      `)[0]!.payload_bytes,
        bytes[0]!.payload_bytes,
      );
      assert.equal(yield* eventStore.latestSequence(), highWater);

      const commanded = yield* sink.readByCommandId({ commandId }).pipe(Stream.runCollect);
      assert.deepEqual(
        commanded.map((stored) => stored.event.id),
        [EventId.make("event:turn-item-compaction:commanded:middle")],
      );
      const storedPrompts = yield* sql<{
        readonly event_id: string;
        readonly sequence: number;
        readonly prompt: string;
        readonly prompt_sequence: number | null;
      }>`
      SELECT event_id, sequence,
        json_extract(payload_json, '$.prompt') AS prompt,
        json_extract(payload_json, '$.promptSequence') AS prompt_sequence
      FROM orchestration_events
      WHERE stream_id = ${threadId} AND event_type = 'subagent.updated'
      ORDER BY sequence ASC
    `;
      assert.lengthOf(storedPrompts, 3);
      assert.equal(storedPrompts[0]!.prompt_sequence, null);
      assert.equal(storedPrompts[1]!.prompt_sequence, null);
      assert.equal(storedPrompts[2]!.prompt, "");
      assert.equal(storedPrompts[2]!.prompt_sequence, storedPrompts[1]!.sequence);

      const deletedCursor = writes.find(
        (stored) => stored.event.id === "event:turn-item-compaction:command:35",
      )!.sequence;
      assert.isFalse(replay.some((stored) => stored.sequence === deletedCursor));
      const cursors = [0, deletedCursor, highWater];
      for (const cursor of cursors) {
        const cursorReplay = yield* eventStore
          .read({ threadId, afterSequence: cursor, throughSequence: highWater })
          .pipe(Stream.runCollect);
        const expected = replay.filter((stored) => stored.sequence > cursor);
        assert.deepEqual(
          cursorReplay.map((stored) => stored.sequence),
          expected.map((stored) => stored.sequence),
        );

        let clientProjection: typeof beforeProjection | null = {
          ...beforeProjection,
          subagents: [],
          turnItems: [],
          visibleTurnItems: [],
        };
        let latestLocalTurnOrdinal: number | null = null;
        for (const stored of [
          ...writes.filter((entry) => entry.sequence <= cursor),
          ...cursorReplay,
        ]) {
          clientProjection = applyOrchestrationV2ProjectionEvent(clientProjection, stored.event, {
            partialTimeline: true,
            latestLocalTurnOrdinal,
          });
          if (stored.event.type === "turn-item.updated") {
            latestLocalTurnOrdinal = Math.max(
              latestLocalTurnOrdinal ?? 0,
              stored.event.payload.ordinal,
            );
          }
        }
        assert.deepEqual(clientProjection?.turnItems, beforeProjection.turnItems);
        assert.deepEqual(clientProjection?.visibleTurnItems, beforeProjection.visibleTurnItems);
      }
      assert.isTrue((yield* maintenance.verify).valid);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(yield* projections.getThreadProjection(threadId), beforeProjection);
      const positions = yield* sql<{
        readonly turn_item_id: string;
        readonly ordinal: number;
      }>`
      SELECT turn_item_id, ordinal
      FROM orchestration_v2_turn_item_positions
      WHERE thread_id = ${threadId}
      ORDER BY ordinal ASC
    `;
      assert.deepEqual(
        positions.map((row) => [row.turn_item_id, row.ordinal]),
        [
          ...itemSpecs.map((spec, index) => [`turn-item:compaction:${spec.key}`, index + 1]),
          ["turn-item:compaction:subagent", 5],
        ],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps post-bound appends visible during compaction", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:turn-item-compaction-race");
      const thread = makeThread(threadId, now);
      const initial = yield* sink.write({
        events: [
          threadCreated(thread, now),
          ...[0, 1, 2].map((revision) => itemEvent(threadId, now, itemSpecs[0], revision)),
        ],
      });
      const beforeSequence = initial.at(-1)!.sequence;

      const streamReady = yield* Deferred.make<void>();
      const streamTracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            const query = span.attributes.get("db.query.text");
            if (typeof query === "string" && query.includes("MAX(sequence)")) {
              Deferred.doneUnsafe(streamReady, Effect.void);
            }
          };
          return span;
        },
      });
      const liveEvents = yield* sink
        .stream({ threadId, afterSequence: beforeSequence })
        .pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.withTracer(streamTracer),
          Effect.forkScoped,
        );
      yield* Deferred.await(streamReady);

      const scanStarted = yield* Deferred.make<void>();
      const releaseScan = yield* Deferred.make<void>();
      let blocked = false;
      const blockFirstScanPage: Statement.Transformer = (statement) => {
        const [query] = statement.compile();
        if (
          !blocked &&
          query.includes("FROM orchestration_events AS event") &&
          query.includes("ORDER BY event.sequence DESC")
        ) {
          blocked = true;
          return Deferred.succeed(scanStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseScan)),
            Effect.as(statement),
          );
        }
        return Effect.succeed(statement);
      };
      const compaction = yield* maintenance
        .compactEventStore()
        .pipe(
          Effect.provideService(Statement.CurrentTransformer, blockFirstScanPage),
          Effect.forkScoped,
        );
      yield* Deferred.await(scanStarted);
      const snapshots = [3, 4, 5].map((revision) =>
        itemEvent(
          threadId,
          now,
          itemSpecs[0],
          revision,
          `event:turn-item-compaction-race:${revision}`,
        ),
      );
      const appended = yield* sink.write({ events: snapshots });
      yield* Deferred.succeed(releaseScan, undefined);
      assert.equal((yield* Fiber.join(compaction)).deletedEventCount, 1);
      const streamed = yield* Fiber.join(liveEvents);
      assert.deepEqual(
        streamed.map((stored) => stored.sequence),
        appended.map((stored) => stored.sequence),
      );
      assert.deepEqual(
        streamed.map((stored) => stored.event.id),
        snapshots.map((event) => event.id),
      );
      assert.equal(yield* eventStore.latestSequence(), appended.at(-1)!.sequence);
      const firstPassRows = yield* eventStore
        .read({ threadId, eventType: "turn-item.updated" })
        .pipe(Stream.runCollect);
      assert.deepEqual(
        firstPassRows.map((stored) => stored.sequence),
        [initial[1]!.sequence, beforeSequence, ...appended.map((stored) => stored.sequence)],
      );
      yield* maintenance.compactEventStore();
      const secondPassRows = yield* eventStore
        .read({ threadId, eventType: "turn-item.updated" })
        .pipe(Stream.runCollect);
      assert.deepEqual(
        secondPassRows.map((stored) => stored.sequence),
        [initial[1]!.sequence, appended.at(-1)!.sequence],
      );
    }),
  ).pipe(Effect.provide(layerTest)),
);

const longAgo = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
const idleBefore = DateTime.makeUnsafe("2026-11-06T00:00:00.000Z");
const recently = DateTime.makeUnsafe("2026-11-10T00:00:00.000Z");
const weatherApp = {
  attachmentId: "retention-weather-html",
  server: "weather",
  tool: "get_weather",
  resourceUri: "ui://weather/dashboard",
};

function retentionItems(threadId: ThreadId, at: DateTime.Utc) {
  const base = {
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "completed" as const,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const command: OrchestrationV2TurnItem = {
    ...base,
    id: TurnItemId.make(`${threadId}:command`),
    ordinal: 1,
    title: "ls",
    type: "command_execution",
    input: "ls",
    output: "file\n".repeat(4_000),
    exitCode: 0,
  };
  const tool: OrchestrationV2TurnItem = {
    ...base,
    id: TurnItemId.make(`${threadId}:tool`),
    ordinal: 2,
    title: "Search",
    type: "dynamic_tool",
    toolName: "mcp__docs__search",
    input: { query: "q".repeat(20_000) },
    output: { content: [{ type: "text", text: "r".repeat(20_000) }] },
  };
  const app: OrchestrationV2TurnItem = {
    ...base,
    id: TurnItemId.make(`${threadId}:app`),
    ordinal: 3,
    title: "Weather",
    type: "dynamic_tool",
    toolName: "weather.get_weather",
    input: { city: "Kyiv" },
    output: { t3McpApp: weatherApp, result: { content: [{ type: "text", text: "Sunny" }] } },
  };
  const running: OrchestrationV2TurnItem = {
    ...base,
    id: TurnItemId.make(`${threadId}:running`),
    ordinal: 4,
    title: "tail",
    type: "command_execution",
    input: "tail -f log",
    output: "line\n".repeat(100),
    status: "running",
    completedAt: null,
  };
  const commandStarted: OrchestrationV2TurnItem = {
    ...command,
    status: "running",
    completedAt: null,
    output: "file\n".repeat(10),
  };
  return { command, tool, app, running, commandStarted };
}

function retentionThread(
  key: string,
  at: DateTime.Utc,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread {
  return { ...makeThread(ThreadId.make(`thread:retention:${key}`), at), ...overrides };
}

const writeRetentionThread = Effect.fnUntraced(function* (
  thread: OrchestrationV2AppThread,
  at: DateTime.Utc,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
) {
  const sink = yield* EventSink.EventSinkV2;
  yield* sink.write({
    events: [
      {
        id: EventId.make(`event:retention:${thread.id}:created`),
        type: "thread.created",
        threadId: thread.id,
        providerInstanceId,
        occurredAt: at,
        payload: thread,
      },
      ...items.map(
        (payload, index) =>
          ({
            id: EventId.make(`event:retention:${thread.id}:${index}`),
            type: "turn-item.updated",
            threadId: thread.id,
            occurredAt: at,
            payload,
          }) satisfies OrchestrationV2DomainEvent,
      ),
    ],
  });
});

const writeRetentionItems = (thread: OrchestrationV2AppThread, at: DateTime.Utc) => {
  const items = retentionItems(thread.id, at);
  return writeRetentionThread(thread, at, [
    items.commandStarted,
    items.command,
    items.tool,
    items.app,
    items.running,
  ]);
};

// The finished command and tool lose their output; the MCP app and the running command keep it.
const prunedRetentionItems = (items: ReadonlyArray<OrchestrationV2TurnItem | null>) =>
  items.map((item, index) => (index < 2 && item !== null ? projectTurnItemForWire(item) : item));

const storedRetentionItems = Effect.fnUntraced(function* (threadId: ThreadId) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const items = retentionItems(threadId, longAgo);
  return yield* Effect.forEach([items.command, items.tool, items.app, items.running], (item) =>
    projections.getTurnItem({ threadId, itemId: item.id }),
  );
});

it.effect(
  "removes old tool output from idle archived, deleted-root and settled chats without changing their timeline",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      const settled = retentionThread("settled", longAgo, {
        settledOverride: "settled",
        settledAt: longAgo,
      });
      const archived = retentionThread("archived", longAgo, { archivedAt: longAgo });
      const deleted = retentionThread("deleted", longAgo, { deletedAt: longAgo });
      const child = retentionThread("child", longAgo, {
        lineage: {
          rootThreadId: archived.id,
          parentThreadId: archived.id,
          relationshipToParent: "subagent",
        },
      });
      const open = retentionThread("open", longAgo);
      const openChild = retentionThread("open-child", longAgo, {
        settledOverride: "settled",
        settledAt: longAgo,
        lineage: {
          rootThreadId: open.id,
          parentThreadId: open.id,
          relationshipToParent: "subagent",
        },
      });
      const pinned = retentionThread("pinned", longAgo, {
        settledOverride: "settled",
        settledAt: longAgo,
        pinnedAt: longAgo,
      });
      const recent = retentionThread("recent", recently, {
        settledOverride: "settled",
        settledAt: recently,
      });
      const cold = [settled, archived, deleted, child];
      const kept = [open, openChild, pinned, recent];
      for (const entry of [...cold, ...kept]) {
        yield* writeRetentionItems(entry, entry === recent ? recently : longAgo);
      }
      const eventBytes = sql<{ readonly bytes: number }>`
        SELECT SUM(length(CAST(payload_json AS BLOB))) AS bytes FROM orchestration_events
      `.pipe(Effect.map((rows) => rows[0]!.bytes));
      const before = new Map<ThreadId, ReadonlyArray<OrchestrationV2TurnItem | null>>();
      for (const entry of [...cold, ...kept])
        before.set(entry.id, yield* storedRetentionItems(entry.id));
      const bytesBefore = yield* eventBytes;

      const result = yield* maintenance.pruneColdThreadToolOutput({ idleBefore });

      assert.deepEqual(result, {
        threadCount: cold.length,
        itemCount: cold.length * 2,
        eventCount: cold.length * 3,
        unreadableItemCount: 0,
      });
      const after = new Map<ThreadId, ReadonlyArray<OrchestrationV2TurnItem | null>>();
      for (const entry of [...cold, ...kept])
        after.set(entry.id, yield* storedRetentionItems(entry.id));
      for (const entry of [...cold, ...kept]) {
        const items = before.get(entry.id)!;
        const expected = cold.includes(entry) ? prunedRetentionItems(items) : items;
        assert.deepEqual(after.get(entry.id), expected, entry.id);
        assert.deepEqual(
          after.get(entry.id)!.map((item) => projectTurnItemForWire(item!)),
          before.get(entry.id)!.map((item) => projectTurnItemForWire(item!)),
        );
      }
      const outputEvents = yield* sql<{ readonly stream_id: string; readonly item_id: string }>`
        SELECT stream_id, json_extract(payload_json, '$.id') AS item_id
        FROM orchestration_events
        WHERE event_type = 'turn-item.updated' AND json_extract(payload_json, '$.output') IS NOT NULL
        ORDER BY sequence
      `;
      assert.deepEqual(
        outputEvents.filter((row) => cold.some((entry) => entry.id === row.stream_id)),
        cold.flatMap((entry) => [
          { stream_id: entry.id, item_id: `${entry.id}:app` },
          { stream_id: entry.id, item_id: `${entry.id}:running` },
        ]),
      );
      assert.isBelow(yield* eventBytes, bytesBefore - cold.length * 50_000);

      assert.isTrue((yield* maintenance.rebuild).valid);
      for (const entry of [...cold, ...kept]) {
        assert.deepEqual(yield* storedRetentionItems(entry.id), after.get(entry.id));
      }
      assert.deepEqual(yield* maintenance.pruneColdThreadToolOutput({ idleBefore }), {
        threadCount: 0,
        itemCount: 0,
        eventCount: 0,
        unreadableItemCount: 0,
      });

      // New activity in a pruned chat brings it back into the next pass.
      const later = DateTime.makeUnsafe("2026-10-02T00:00:00.000Z");
      const laterCommand = {
        ...retentionItems(settled.id, later).command,
        id: TurnItemId.make(`${settled.id}:later`),
        ordinal: 5,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:retention:later"),
            type: "turn-item.updated",
            threadId: settled.id,
            occurredAt: later,
            payload: laterCommand,
          },
        ],
      });
      assert.deepEqual(yield* maintenance.pruneColdThreadToolOutput({ idleBefore }), {
        threadCount: 1,
        itemCount: 1,
        eventCount: 1,
        unreadableItemCount: 0,
      });
      assert.deepEqual(
        yield* projections.getTurnItem({ threadId: settled.id, itemId: laterCommand.id }),
        projectTurnItemForWire(laterCommand),
      );
      const replay = yield* eventStore.read({ threadId: settled.id }).pipe(Stream.runCollect);
      assert.isTrue(replay.some((stored) => stored.event.id === "event:retention:later"));
    }).pipe(Effect.provide(layerTest)),
);

it.effect("applies the retention days setting, and null keeps all tool output", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(recently) + 4 * 86_400_000);
    const archived = retentionThread("days-archived", longAgo, { archivedAt: longAgo });
    yield* writeRetentionItems(archived, longAgo);
    const before = yield* storedRetentionItems(archived.id);

    assert.isNull(yield* ProjectionMaintenance.pruneToolOutputAfterDays(null));
    assert.deepEqual(yield* storedRetentionItems(archived.id), before);
    const result = yield* ProjectionMaintenance.pruneToolOutputAfterDays(7);
    assert.equal(result?.threadCount, 1);
    assert.deepEqual(yield* storedRetentionItems(archived.id), prunedRetentionItems(before));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps old tool output while any chat sharing the root is open, pinned or active", () =>
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const settled = { settledOverride: "settled", settledAt: longAgo } as const;
    const forkOf = (
      source: OrchestrationV2AppThread,
      key: string,
      at: DateTime.Utc,
      overrides: Partial<OrchestrationV2AppThread> = {},
    ) =>
      retentionThread(key, at, {
        lineage: {
          rootThreadId: source.id,
          parentThreadId: source.id,
          relationshipToParent: "fork",
        },
        ...overrides,
      });
    const openSource = retentionThread("open-fork-source", longAgo, settled);
    const pinnedSource = retentionThread("pinned-fork-source", longAgo, settled);
    const activeSource = retentionThread("active-fork-source", longAgo, settled);
    const settledSource = retentionThread("settled-fork-source", longAgo, settled);
    const archivedParent = retentionThread("side-chat-parent", longAgo, { archivedAt: longAgo });
    const families = [
      { pruned: false, members: [openSource, forkOf(openSource, "open-fork", longAgo)] },
      {
        pruned: false,
        members: [
          pinnedSource,
          forkOf(pinnedSource, "pinned-fork", longAgo, { ...settled, pinnedAt: longAgo }),
        ],
      },
      {
        pruned: false,
        members: [
          activeSource,
          forkOf(activeSource, "active-fork", recently, {
            settledOverride: "settled",
            settledAt: recently,
          }),
        ],
      },
      {
        pruned: true,
        members: [settledSource, forkOf(settledSource, "settled-fork", longAgo, settled)],
      },
      {
        // A side chat lives in its parent's view, so its own open state does not keep the family.
        pruned: true,
        members: [
          archivedParent,
          forkOf(archivedParent, "side-chat", longAgo, {
            lineage: {
              rootThreadId: archivedParent.id,
              parentThreadId: archivedParent.id,
              relationshipToParent: "fork",
              sideChat: true,
            },
          }),
        ],
      },
    ];
    const members = families.flatMap((family) => family.members);
    for (const member of members) yield* writeRetentionItems(member, member.updatedAt);
    const before = new Map<ThreadId, ReadonlyArray<OrchestrationV2TurnItem | null>>();
    for (const member of members) before.set(member.id, yield* storedRetentionItems(member.id));

    assert.deepEqual(yield* maintenance.pruneColdThreadToolOutput({ idleBefore }), {
      threadCount: 4,
      itemCount: 8,
      eventCount: 12,
      unreadableItemCount: 0,
    });
    for (const family of families) {
      for (const member of family.members) {
        const items = before.get(member.id)!;
        const expected = family.pruned ? prunedRetentionItems(items) : items;
        assert.deepEqual(yield* storedRetentionItems(member.id), expected, member.id);
      }
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("stops pruning a chat that reopens mid-pass and keeps events newer than the pass", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const thread = retentionThread("reopened", longAgo, {
      settledOverride: "settled",
      settledAt: longAgo,
    });
    const { command } = retentionItems(thread.id, longAgo);
    // One more than a page, so the pass pauses between two item pages.
    const commands = Array.from({ length: 51 }, (_, index) => ({
      ...command,
      id: TurnItemId.make(`${thread.id}:command:${index}`),
      ordinal: index + 1,
    }));
    yield* writeRetentionThread(thread, longAgo, commands);
    const write = (event: OrchestrationV2DomainEvent) =>
      sink.write({ events: [event] }).pipe(Effect.asVoid, Effect.orDie);
    // Runs the write on the pass's first pause only.
    const onFirstPause = (event: OrchestrationV2DomainEvent) => {
      let written = false;
      return Effect.suspend(() => {
        if (written) return Effect.void;
        written = true;
        return write(event);
      });
    };
    const stored = Effect.forEach(commands, (item) =>
      projections.getTurnItem({ threadId: thread.id, itemId: item.id }),
    );
    const outputEventItemIds = sql<{ readonly item_id: string }>`
      SELECT json_extract(payload_json, '$.id') AS item_id
      FROM orchestration_events
      WHERE event_type = 'turn-item.updated' AND json_extract(payload_json, '$.output') IS NOT NULL
      ORDER BY sequence
    `.pipe(Effect.map((rows) => rows.map((row) => row.item_id)));
    const marks = sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_thread_output_retention
    `;
    const before = yield* stored;

    // Pinned after the first page: that page stays pruned; the rest and every event keep output.
    assert.deepEqual(
      yield* maintenance.pruneColdThreadToolOutput({
        idleBefore,
        betweenPages: onFirstPause({
          id: EventId.make("event:retention:reopened:pinned"),
          type: "thread.pinned",
          threadId: thread.id,
          occurredAt: longAgo,
          payload: { ...thread, pinnedAt: longAgo },
        }),
      }),
      { threadCount: 0, itemCount: 50, eventCount: 0, unreadableItemCount: 0 },
    );
    assert.deepEqual(
      yield* stored,
      before.map((item, index) => (index < 50 ? projectTurnItemForWire(item!) : item)),
    );
    assert.deepEqual(
      yield* outputEventItemIds,
      commands.map((item) => item.id),
    );
    assert.deepEqual(yield* marks, []);

    // Unpinned, the next pass finishes the chat. The full-output event that lands mid-pass is
    // newer than the pass, so it stays as written and a rebuild keeps the same timeline.
    yield* write({
      id: EventId.make("event:retention:reopened:unpinned"),
      type: "thread.unpinned",
      threadId: thread.id,
      occurredAt: longAgo,
      payload: { ...thread, pinnedAt: null },
    });
    assert.deepEqual(
      yield* maintenance.pruneColdThreadToolOutput({
        idleBefore,
        betweenPages: onFirstPause({
          id: EventId.make("event:retention:reopened:late"),
          type: "turn-item.updated",
          threadId: thread.id,
          occurredAt: longAgo,
          payload: commands[0]!,
        }),
      }),
      { threadCount: 1, itemCount: 1, eventCount: 51, unreadableItemCount: 0 },
    );
    const after = yield* stored;
    assert.deepEqual(
      after,
      before.map((item, index) => (index === 0 ? item : projectTurnItemForWire(item!))),
    );
    assert.deepEqual(yield* outputEventItemIds, [commands[0]!.id]);
    assert.deepEqual(yield* marks, [{ thread_id: thread.id }]);
    assert.isTrue((yield* maintenance.rebuild).valid);
    assert.deepEqual(yield* stored, after);
  }).pipe(Effect.provide(layerTest)),
);
