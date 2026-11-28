import { EventId, ProjectId, ProviderThreadId, ThreadId } from "@t3tools/contracts/baseSchemas";
import type { ModelSelection } from "@t3tools/contracts/modelSelection";
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderThread,
} from "@t3tools/contracts/orchestrationV2";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { runMigrations } from "../Migrations.ts";

// Built after migrating to 123: the stores read projection tables when they start.
const storesLayer = EventSink.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(EventStore.layer, ProjectionStore.layer)),
);

const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("claudeAgent");
const providerInstanceId = modelSelection.instanceId;
const threadId = ThreadId.make("thread:pin-migration");
const providerThreadId = ProviderThreadId.make("provider-thread:pin-migration");
const createdAt = DateTime.makeUnsafe("2026-11-27T00:00:00.000Z");
const at = (minutes: number) => DateTime.add(createdAt, { minutes });

const providerThread: OrchestrationV2ProviderThread = {
  id: providerThreadId,
  driver,
  providerInstanceId,
  providerSessionId: null,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver, nativeId: "native-pin-migration", strength: "strong" },
  nativeConversationHeadRef: null,
  status: "active",
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  createdAt,
  updatedAt: createdAt,
};

let eventNumber = 0;
const providerThreadEvents = (input: {
  readonly updatedAt: DateTime.Utc;
  readonly pin: { readonly key: string; readonly text: string };
}): ReadonlyArray<OrchestrationV2DomainEvent> => {
  eventNumber += 1;
  return [
    {
      id: EventId.make(`event:pin-migration:${eventNumber}:updated`),
      type: "provider-thread.updated",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: input.updatedAt,
      // Adapters hand over hydrated snapshots; the sink must not store their pin.
      payload: {
        ...providerThread,
        pinnedSystemInstructions: input.pin,
        updatedAt: input.updatedAt,
      },
    },
    {
      id: EventId.make(`event:pin-migration:${eventNumber}:pin`),
      type: "provider-thread.pinned-instructions-set",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: input.updatedAt,
      payload: { providerThreadId, ...input.pin },
    },
  ];
};

it.effect("writes, reads and compares provider threads before and after migration 124", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 123 });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const eventSink = yield* EventSink.EventSinkV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:pin-migration:thread"),
            type: "thread.created",
            threadId,
            occurredAt: createdAt,
            payload: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId: ProjectId.make("project:pin-migration"),
              title: "Pin migration thread",
              providerInstanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              activeProviderThreadId: providerThreadId,
              createdAt,
              updatedAt: createdAt,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          },
          ...providerThreadEvents({ updatedAt: at(1), pin: { key: "key-1", text: "PIN_TEXT_1" } }),
        ],
      });
      const readProviderThread = Effect.map(
        store.getThreadProviderContext(threadId, providerInstanceId),
        (context) => context.providerThreads[0]!,
      );

      const beforeMigration = yield* readProviderThread;
      assert.isNull(beforeMigration.pinnedSystemInstructions);
      const staleBeforeMigration = { ...beforeMigration, updatedAt: createdAt };
      assert.isTrue(
        (yield* eventSink.writeIfProviderThreadUnchanged({
          expected: beforeMigration,
          events: providerThreadEvents({
            updatedAt: at(2),
            pin: { key: "key-2", text: "PIN_TEXT_2" },
          }),
        })).committed,
      );
      assert.isFalse(
        (yield* eventSink.writeIfProviderThreadUnchanged({
          expected: staleBeforeMigration,
          events: [],
        })).committed,
      );

      yield* runMigrations({ toMigrationInclusive: 124 });
      yield* eventSink.write({
        events: providerThreadEvents({
          updatedAt: at(3),
          pin: { key: "key-3", text: "PIN_TEXT_3" },
        }),
      });
      const afterMigration = yield* readProviderThread;
      assert.deepEqual(afterMigration.pinnedSystemInstructions, {
        key: "key-3",
        text: "PIN_TEXT_3",
      });
      assert.isTrue(
        (yield* eventSink.writeIfProviderThreadUnchanged({
          expected: afterMigration,
          events: providerThreadEvents({
            updatedAt: at(4),
            pin: { key: "key-4", text: "PIN_TEXT_4" },
          }),
        })).committed,
      );
      assert.isFalse(
        (yield* eventSink.writeIfProviderThreadUnchanged({
          expected: afterMigration,
          events: [],
        })).committed,
      );
      assert.deepEqual((yield* readProviderThread).pinnedSystemInstructions, {
        key: "key-4",
        text: "PIN_TEXT_4",
      });

      const stored = yield* sql<{ readonly event_type: string; readonly payload_json: string }>`
        SELECT event_type, payload_json
        FROM orchestration_events
        WHERE stream_id = ${threadId} AND event_type LIKE 'provider-thread.%'
        ORDER BY sequence
      `;
      const updates = stored.filter((row) => row.event_type === "provider-thread.updated");
      const pins = stored.filter(
        (row) => row.event_type === "provider-thread.pinned-instructions-set",
      );
      assert.lengthOf(updates, 4);
      for (const update of updates) {
        assert.notInclude(update.payload_json, "pinnedSystemInstructions");
        assert.notInclude(update.payload_json, "PIN_TEXT");
      }
      assert.deepEqual(
        pins.map((row) => JSON.parse(row.payload_json).text),
        ["PIN_TEXT_1", "PIN_TEXT_2", "PIN_TEXT_3", "PIN_TEXT_4"],
      );
    }).pipe(Effect.provide(storesLayer));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
