import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProviderDriverKind,
  MessageId,
  NodeId,
  PlanId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";
import { projectTurnItemForWire } from "./WireProjection.ts";

const database = SqlitePersistence.layerMemory;
const eventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(database));
const projectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(database));
const stores = Layer.mergeAll(database, eventStoreProvided, projectionStoreProvided);
const layerTest = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
  ProjectionReplay.layer.pipe(Layer.provide(stores)),
);

const providerDriver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };

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
    const malformed = retentionThread("malformed", longAgo, settled);
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
      // A chat whose payload is not JSON has no family to judge, so it keeps its output.
      { pruned: false, members: [malformed] },
    ];
    const members = families.flatMap((family) => family.members);
    for (const member of members) yield* writeRetentionItems(member, member.updatedAt);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE orchestration_v2_projection_threads SET payload_json = '{broken'
      WHERE thread_id = ${malformed.id}
    `;
    const before = new Map<ThreadId, ReadonlyArray<OrchestrationV2TurnItem | null>>();
    for (const member of members) before.set(member.id, yield* storedRetentionItems(member.id));

    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    assert.deepEqual(
      yield* maintenance.pruneColdThreadToolOutput({ idleBefore }).pipe(Effect.withTracer(tracer)),
      { threadCount: 4, itemCount: 8, eventCount: 12, unreadableItemCount: 0 },
    );
    // Each family is read by root from its index, not from a walk over every chat.
    const familyReads = new Set(
      spans.flatMap((span) => {
        const query = span.attributes.get("db.query.text");
        return typeof query === "string" &&
          query.includes("orchestration_v2_projection_threads AS member")
          ? [query]
          : [];
      }),
    );
    assert.strictEqual(familyReads.size, 1);
    for (const statement of familyReads) {
      const lookups = (yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${statement}`,
      ))
        .map((row) => row.detail)
        .filter((detail) => /^(?:SCAN|SEARCH) member\b/.test(detail));
      assert.deepEqual(lookups, [
        "SEARCH member USING INDEX orchestration_v2_projection_threads_root_thread_idx (<expr>=?)",
      ]);
    }
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
    assert.deepEqual(yield* stored, after);
  }).pipe(Effect.provide(layerTest)),
);

const historyEntities = ["node", "message", "plan", "request", "provider-turn", "item"] as const;

// `revisions` updates of every entity whose projection row is replaced whole. Only the second
// provider-turn update reports token usage, which the projection keeps from then on.
function historyEvents(
  thread: OrchestrationV2AppThread,
  revisions: number,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const threadId = thread.id;
  const at = thread.updatedAt;
  const nodeId = NodeId.make(`${threadId}:node`);
  const providerTurnId = ProviderTurnId.make(`${threadId}:provider-turn`);
  const { command } = retentionItems(threadId, at);
  return Array.from({ length: revisions }, (_, revision) => {
    const done = revision === revisions - 1;
    const event = (key: (typeof historyEntities)[number]) => ({
      id: EventId.make(`event:history:${threadId}:${key}:${revision}`),
      threadId,
      occurredAt: at,
    });
    return [
      {
        ...event("node"),
        type: "node.updated",
        payload: {
          id: nodeId,
          threadId,
          runId: null,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind: "root_turn",
          status: done ? "completed" : "running",
          countsForRun: true,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: at,
          completedAt: done ? at : null,
        },
      },
      {
        ...event("message"),
        type: "message.updated",
        payload: {
          id: MessageId.make(`${threadId}:message`),
          threadId,
          runId: null,
          nodeId,
          role: "assistant",
          text: `Answer ${revision}`,
          attachments: [],
          streaming: !done,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: at,
          updatedAt: at,
        },
      },
      {
        ...event("plan"),
        type: "plan.updated",
        payload: {
          id: PlanId.make(`${threadId}:plan`),
          threadId,
          runId: null,
          nodeId,
          status: done ? "completed" : "active",
          kind: "proposed_plan",
          markdown: `Plan ${revision}`,
        },
      },
      {
        ...event("request"),
        type: "runtime-request.updated",
        payload: {
          id: RuntimeRequestId.make(`${threadId}:request`),
          nodeId,
          providerTurnId,
          nativeRequestRef: null,
          kind: "command",
          status: done ? "resolved" : "pending",
          responseCapability: { type: "message" },
          createdAt: at,
          resolvedAt: done ? at : null,
        },
      },
      {
        ...event("provider-turn"),
        type: "provider-turn.updated",
        payload: {
          id: providerTurnId,
          providerThreadId: ProviderThreadId.make(`${threadId}:provider-thread`),
          nodeId,
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: done ? "completed" : "running",
          startedAt: at,
          completedAt: done ? at : null,
          ...(revision === 1
            ? { tokenUsage: { usedTokens: 1_200, updatedAt: DateTime.formatIso(at) } }
            : {}),
        },
      },
      {
        ...event("item"),
        type: "turn-item.updated",
        payload: { ...command, output: `out ${revision}` },
      },
    ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
  }).flat();
}

// A commanded first revision of the item, which a duplicate command replays, then the history,
// then subagent events, whose order the subagent prompt history needs.
const writeHistoryThread = Effect.fnUntraced(function* (
  thread: OrchestrationV2AppThread,
  revisions: number,
) {
  const sink = yield* EventSink.EventSinkV2;
  const at = thread.updatedAt;
  const subagentId = NodeId.make(`${thread.id}:subagent`);
  const ownSubagent = (event: OrchestrationV2DomainEvent): OrchestrationV2DomainEvent => {
    const id = EventId.make(`${event.id}:${thread.id}`);
    if (event.type === "subagent.updated") {
      return { ...event, id, payload: { ...event.payload, id: subagentId } };
    }
    if (event.type === "turn-item.updated" && event.payload.type === "subagent") {
      const payload = {
        ...event.payload,
        id: TurnItemId.make(`${thread.id}:subagent`),
        subagentId,
      };
      return { ...event, id, payload };
    }
    return event;
  };
  yield* writeRetentionThread(thread, at, []);
  yield* sink.write({
    commandId: CommandId.make(`command:history:${thread.id}`),
    events: [
      {
        id: EventId.make(`event:history:${thread.id}:commanded`),
        type: "turn-item.updated",
        threadId: thread.id,
        occurredAt: at,
        payload: retentionItems(thread.id, at).command,
      },
    ],
  });
  yield* sink.write({ events: historyEvents(thread, revisions) });
  yield* sink.write({
    events: [0, 1].flatMap((revision) => subagentEvents(thread.id, at, revision).map(ownSubagent)),
  });
});

const keptHistoryEventIds = (threadId: ThreadId, revisions: number) => [
  `event:retention:${threadId}:created`,
  `event:history:${threadId}:commanded`,
  `event:history:${threadId}:provider-turn:1`,
  ...historyEntities.map((key) => `event:history:${threadId}:${key}:${revisions - 1}`),
  ...[0, 1].flatMap((revision) => [
    `event:turn-item-compaction:subagent:${revision}:${threadId}`,
    `event:turn-item-compaction:subagent-item:${revision}:${threadId}`,
  ]),
];

// Every entity loses all but its newest event, and the provider turn also keeps its usage event.
const supersededHistoryEventCount = (revisions: number) =>
  historyEntities.length * (revisions - 1) - 1;

const historyEventIds = Effect.fnUntraced(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly event_id: string }>`
    SELECT event_id FROM orchestration_events WHERE stream_id = ${threadId} ORDER BY sequence
  `;
  return rows.map((row) => row.event_id);
});

it.effect(
  "bounds the event log of cold chats to one event per entity, whatever its revisions",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const brief = retentionThread("history-brief", longAgo, {
        settledOverride: "settled",
        settledAt: longAgo,
      });
      const long = retentionThread("history-long", longAgo, { archivedAt: longAgo });
      yield* writeHistoryThread(brief, 3);
      yield* writeHistoryThread(long, 40);
      const projected = Effect.forEach([brief, long], (thread) =>
        projections.getThreadProjection(thread.id),
      );
      const before = yield* projected;

      assert.deepEqual(yield* maintenance.compactColdThreadHistory({ idleBefore }), {
        threadCount: 2,
        deletedEventCount: supersededHistoryEventCount(3) + supersededHistoryEventCount(40),
      });
      assert.deepEqual(yield* historyEventIds(brief.id), keptHistoryEventIds(brief.id, 3));
      assert.deepEqual(yield* historyEventIds(long.id), keptHistoryEventIds(long.id, 40));
      assert.deepEqual(yield* projected, before);
      assert.isTrue((yield* (yield* ProjectionReplay.ProjectionReplay).verify).valid);
      assert.isTrue((yield* (yield* ProjectionReplay.ProjectionReplay).rebuild).valid);
      assert.deepEqual(yield* projected, before);

      // The mark skips a compacted chat until it has new events.
      assert.deepEqual(yield* maintenance.compactColdThreadHistory({ idleBefore }), {
        threadCount: 0,
        deletedEventCount: 0,
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:history:brief:visited"),
            type: "thread.visited",
            threadId: brief.id,
            occurredAt: longAgo,
            payload: brief,
          },
        ],
      });
      assert.deepEqual(yield* maintenance.compactColdThreadHistory({ idleBefore }), {
        threadCount: 1,
        deletedEventCount: 0,
      });
    }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps every event of chats whose family is open, pinned or recently active", () =>
  Effect.gen(function* () {
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const settled = { settledOverride: "settled", settledAt: longAgo } as const;
    const openSource = retentionThread("history-open-source", longAgo);
    const threads = [
      openSource,
      retentionThread("history-open-fork", longAgo, {
        ...settled,
        lineage: {
          rootThreadId: openSource.id,
          parentThreadId: openSource.id,
          relationshipToParent: "fork",
        },
      }),
      retentionThread("history-pinned", longAgo, { ...settled, pinnedAt: longAgo }),
      retentionThread("history-recent", recently, {
        settledOverride: "settled",
        settledAt: recently,
      }),
    ];
    for (const thread of threads) yield* writeHistoryThread(thread, 3);
    const eventIds = Effect.forEach(threads, (thread) => historyEventIds(thread.id));
    const before = yield* eventIds;

    assert.deepEqual(yield* maintenance.compactColdThreadHistory({ idleBefore }), {
      threadCount: 0,
      deletedEventCount: 0,
    });
    assert.deepEqual(yield* eventIds, before);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("stops compacting when the family reopens mid-pass and finishes once it is cold", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const settled = { settledOverride: "settled", settledAt: longAgo } as const;
    // The source sorts first, so the pass pauses inside its history before reaching the fork.
    const source = retentionThread("history-family-a", longAgo, settled);
    const fork = retentionThread("history-family-b", longAgo, {
      ...settled,
      lineage: { rootThreadId: source.id, parentThreadId: source.id, relationshipToParent: "fork" },
    });
    // More than a page of events, so the pass pauses inside the source.
    yield* writeHistoryThread(source, 20);
    yield* writeRetentionThread(fork, longAgo, []);
    const before = yield* projections.getThreadProjection(source.id);
    const forkEvent = (type: "thread.unsettled" | "thread.settled", payload: typeof fork) =>
      sink
        .write({
          events: [
            {
              id: EventId.make(`event:history:fork:${type}`),
              type,
              threadId: fork.id,
              occurredAt: longAgo,
              payload,
            },
          ],
        })
        .pipe(Effect.asVoid, Effect.orDie);
    let paused = false;
    const reopenForkOnFirstPause = Effect.suspend(() => {
      if (paused) return Effect.void;
      paused = true;
      return forkEvent("thread.unsettled", { ...fork, settledOverride: null, settledAt: null });
    });

    // The first page of 50 events goes: the subagent events and 46 newer history events, 40 of
    // them superseded.
    assert.deepEqual(
      yield* maintenance.compactColdThreadHistory({
        idleBefore,
        betweenPages: reopenForkOnFirstPause,
      }),
      { threadCount: 0, deletedEventCount: 40 },
    );
    const total = 1 + 1 + historyEntities.length * 20 + 4;
    assert.lengthOf(yield* historyEventIds(source.id), total - 40);

    // Only the fork changes, yet the source comes back because its mark covers only what went.
    yield* forkEvent("thread.settled", fork);
    assert.deepEqual(yield* maintenance.compactColdThreadHistory({ idleBefore }), {
      threadCount: 2,
      deletedEventCount: supersededHistoryEventCount(20) - 40,
    });
    assert.deepEqual(yield* historyEventIds(source.id), keptHistoryEventIds(source.id, 20));
    assert.isTrue((yield* (yield* ProjectionReplay.ProjectionReplay).rebuild).valid);
    assert.deepEqual(yield* projections.getThreadProjection(source.id), before);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("compacts the history of chats idle for a day, whatever the tool output retention", () =>
  Effect.gen(function* () {
    const thread = retentionThread("history-day", recently, {
      settledOverride: "settled",
      settledAt: recently,
    });
    yield* writeHistoryThread(thread, 3);
    const compact = ProjectionMaintenance.compactIdleThreadHistory();

    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(recently, { hours: 23 })));
    assert.equal((yield* compact).threadCount, 0);
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(recently, { hours: 25 })));
    assert.deepEqual(yield* compact, {
      threadCount: 1,
      deletedEventCount: supersededHistoryEventCount(3),
    });
  }).pipe(Effect.provide(layerTest)),
);
