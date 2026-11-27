import {
  type OrchestrationV2DomainEvent,
  OrchestrationV2TurnItemJson,
  type OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { mcpAppFromToolItem } from "@t3tools/shared/toolOutput";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { stripTurnItemPayloadColumns, turnItemPayloadSql } from "./TurnItemPayloadColumns.ts";
import { projectTurnItemForWire } from "./WireProjection.ts";

export interface ProjectionVerificationV2 {
  readonly valid: boolean;
  readonly schemaVersion: number;
  readonly expectedSequence: number;
  readonly projectionSequence: number;
  readonly unreadableThreadIds: ReadonlyArray<ThreadId>;
  readonly missingThreadIds: ReadonlyArray<ThreadId>;
  readonly unexpectedThreadIds: ReadonlyArray<ThreadId>;
}

export class ProjectionMaintenanceError extends Schema.TaggedError<ProjectionMaintenanceError>()(
  "ProjectionMaintenanceError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ToolOutputRetentionResult {
  readonly threadCount: number;
  readonly itemCount: number;
  readonly eventCount: number;
  readonly unreadableItemCount: number;
}

export interface ColdThreadHistoryResult {
  readonly threadCount: number;
  readonly deletedEventCount: number;
}

export interface ProjectionMaintenanceV2Shape {
  readonly verify: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  readonly rebuild: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  /**
   * Compact new events and the older thread state they can supersede. Offline repair can still
   * run a full pass on databases that predate incremental compaction.
   */
  readonly compactEventStore: (
    betweenPages?: Effect.Effect<void>,
    mode?: "incremental" | "full",
  ) => Effect.Effect<
    {
      readonly deletedEventCount: number;
      readonly deletedReceiptCount: number;
      readonly reclaimableBytes: number;
    },
    ProjectionMaintenanceError
  >;
  /**
   * Store the wire shape of finished command and tool items in chats whose whole family (every
   * chat sharing the root) is archived, deleted or settled, unpinned, and idle since
   * `idleBefore`. The timeline stays the same.
   */
  readonly pruneColdThreadToolOutput: (input: {
    readonly idleBefore: DateTime.Utc;
    readonly betweenPages?: Effect.Effect<void>;
  }) => Effect.Effect<ToolOutputRetentionResult, ProjectionMaintenanceError>;
  /**
   * In chats whose whole family is cold (as above) and idle since `idleBefore`, delete each
   * entity's superseded events, so the log holds one event per entity whatever its revisions.
   * A rebuild yields the same projections, and a resume from before the pass gets a snapshot.
   */
  readonly compactColdThreadHistory: (input: {
    readonly idleBefore: DateTime.Utc;
    readonly betweenPages?: Effect.Effect<void>;
  }) => Effect.Effect<ColdThreadHistoryResult, ProjectionMaintenanceError>;
}

export class ProjectionMaintenanceV2 extends Context.Service<
  ProjectionMaintenanceV2,
  ProjectionMaintenanceV2Shape
>()("t3/orchestration-v2/ProjectionMaintenance/ProjectionMaintenanceV2") {}

/** The one retention rule for old tool output, shared by the server's storage pass and `t3 doctor`. */
export const pruneToolOutputAfterDays = Effect.fn("ProjectionMaintenance.pruneToolOutputAfterDays")(
  function* (days: number | null, betweenPages?: Effect.Effect<void>) {
    if (days === null) return null;
    const maintenance = yield* ProjectionMaintenanceV2;
    const idleBefore = DateTime.subtract(yield* DateTime.now, { days });
    return yield* maintenance.pruneColdThreadToolOutput({
      idleBefore,
      ...(betweenPages === undefined ? {} : { betweenPages }),
    });
  },
);

// Nothing visible changes and a resume from before the pass gets a snapshot, so a day is enough.
const COLD_HISTORY_IDLE_DAYS = 1;

/** Bound the event log of chats past retention, for the server's storage pass and `t3 doctor`. */
export const compactIdleThreadHistory = Effect.fn("ProjectionMaintenance.compactIdleThreadHistory")(
  function* (betweenPages?: Effect.Effect<void>) {
    const maintenance = yield* ProjectionMaintenanceV2;
    const idleBefore = DateTime.subtract(yield* DateTime.now, { days: COLD_HISTORY_IDLE_DAYS });
    return yield* maintenance.compactColdThreadHistory({
      idleBefore,
      ...(betweenPages === undefined ? {} : { betweenPages }),
    });
  },
);

/**
 * "latest": the projection replaces the whole row by entity id, so only the newest event per
 * entity matters. "all": the event is kept. A new event type fails typecheck here until it is
 * classified, so the log of chats past retention stays bounded.
 */
const COLD_HISTORY_RULE: Record<OrchestrationV2DomainEvent["type"], "latest" | "all"> = {
  "node.updated": "latest",
  "message.updated": "latest",
  "plan.updated": "latest",
  "runtime-request.updated": "latest",
  // Subagent items keep every snapshot: later rows can reference an earlier prompt.
  "turn-item.updated": "latest",
  // The projection keeps the last token usage when a newer event has none.
  "provider-turn.updated": "latest",
  // Replaces both pin columns; every provider-thread.updated stays, so the row exists on replay.
  "provider-thread.pinned-instructions-set": "latest",
  // Subagent snapshots keep the prompt later rows point at.
  "subagent.updated": "all",
  "checkpoint-scope.created": "all",
  "checkpoint.captured": "all",
  "checkpoint.rollback-requested": "all",
  "context-handoff.updated": "all",
  "context-transfer.created": "all",
  "context-transfer.updated": "all",
  "provider-session.attached": "all",
  "provider-session.detached": "all",
  "provider-session.updated": "all",
  "provider-thread.updated": "all",
  "run-attempt.created": "all",
  "run-attempt.updated": "all",
  "run.background-work-cancelled": "all",
  "run.created": "all",
  "run.delegated-completion-updated": "all",
  "run.updated": "all",
  // The global event-store pass keeps the newest of each thread group and the thread.created anchor.
  "thread.created": "all",
  "thread.archived": "all",
  "thread.unarchived": "all",
  "thread.deleted": "all",
  "thread.settled": "all",
  "thread.unsettled": "all",
  "thread.snoozed": "all",
  "thread.unsnoozed": "all",
  "thread.pinned": "all",
  "thread.auto-settle-set": "all",
  "thread.later-set": "all",
  "thread.unpinned": "all",
  "thread.pin-reordered": "all",
  "thread.active-reordered": "all",
  "thread.tags-updated": "all",
  "thread.notification-level-updated": "all",
  "thread.color-updated": "all",
  "thread.message-stars-updated": "all",
  "thread.folder-updated": "all",
  "thread.artifacts-updated": "all",
  "thread.visited": "all",
  "thread.marked-unread": "all",
  "thread.metadata-updated": "all",
  "thread.pull-request-synced": "all",
  "thread.pull-request-link-updated": "all",
  "thread.runtime-mode-updated": "all",
  "thread.interaction-mode-updated": "all",
  "thread.model-selection-updated": "all",
  "thread.provider-switched": "all",
  "thread.guest-share-updated": "all",
};

const LATEST_ONLY_EVENT_TYPES = Object.entries(COLD_HISTORY_RULE)
  .filter(([, rule]) => rule === "latest")
  .map(([type]) => type);

type ProjectionMetadataRow = {
  readonly schema_version: number;
  readonly last_sequence: number;
};

const encodeEntityKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.NullOr(Schema.String)])),
);

// Projection rows and turn-item.updated event payloads share this encoding.
const TurnItemPayload = Schema.fromJsonString(OrchestrationV2TurnItemJson);
const decodeTurnItemPayload = Schema.decodeUnknownEffect(TurnItemPayload);
const encodeTurnItemPayload = Schema.encodeEffect(TurnItemPayload);

const SETTLED_ITEM_STATUSES = ["completed", "failed", "cancelled", "interrupted"];
// The MCP App frame renders from the full input and output.
const keepsFullOutput = (item: OrchestrationV2TurnItem) =>
  (item.type !== "command_execution" && item.type !== "dynamic_tool") ||
  (item.type === "dynamic_tool" && mcpAppFromToolItem(item) !== undefined);

export const layer: Layer.Layer<
  ProjectionMaintenanceV2,
  never,
  EventStore.EventStoreV2 | ProjectionStore.ProjectionStoreV2 | SqlClient.SqlClient
> = Layer.effect(
  ProjectionMaintenanceV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* EventStore.EventStoreV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;

    const verify = Effect.gen(function* () {
      const expectedThreadRows = yield* sql<{ readonly thread_id: string }>`
        SELECT DISTINCT stream_id AS thread_id
        FROM orchestration_events INDEXED BY orchestration_events_v2_created_threads_idx
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND event_type = 'thread.created'
        ORDER BY stream_id ASC
      `;
      const projectionRows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id
        FROM orchestration_v2_projection_threads
        ORDER BY thread_id ASC
      `;
      const actualIds = projectionRows.map((row) => ThreadId.make(row.thread_id));
      const expectedIds = expectedThreadRows.map((row) => ThreadId.make(row.thread_id));
      const actualSet = new Set(actualIds);
      const expectedSet = new Set(expectedIds);
      const missingThreadIds = expectedIds.filter((threadId) => !actualSet.has(threadId));
      const unexpectedThreadIds = actualIds.filter((threadId) => !expectedSet.has(threadId));
      const unreadableThreadIds = yield* projectionStore.getUnreadableThreadIds();
      const metadata = yield* sql<ProjectionMetadataRow>`
        SELECT schema_version, last_sequence
        FROM orchestration_v2_projection_metadata
        WHERE projection_name = 'thread-projections'
        LIMIT 1
      `;
      const expectedSequence = yield* eventStore.latestSequence();
      const schemaVersion = metadata[0]?.schema_version ?? 0;
      const projectionSequence = metadata[0]?.last_sequence ?? 0;
      return {
        valid:
          schemaVersion === ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION &&
          projectionSequence === expectedSequence &&
          missingThreadIds.length === 0 &&
          unexpectedThreadIds.length === 0 &&
          unreadableThreadIds.length === 0,
        schemaVersion,
        expectedSequence,
        projectionSequence,
        unreadableThreadIds,
        missingThreadIds,
        unexpectedThreadIds,
      } satisfies ProjectionVerificationV2;
    }).pipe(sql.withTransaction);

    const rebuild = Effect.gen(function* () {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const throughSequence = yield* eventStore.latestSequence();
          yield* sql`DELETE FROM orchestration_v2_projection_context_transfers`;
          yield* sql`DELETE FROM orchestration_v2_projection_context_handoffs`;
          yield* sql`DELETE FROM orchestration_v2_projection_checkpoints`;
          yield* sql`DELETE FROM orchestration_v2_projection_checkpoint_scopes`;
          yield* sql`DELETE FROM orchestration_v2_projection_turn_items`;
          yield* sql`DELETE FROM orchestration_v2_projection_plans`;
          yield* sql`DELETE FROM orchestration_v2_projection_messages`;
          yield* sql`DELETE FROM orchestration_v2_projection_runtime_requests`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_turns`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_threads`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_session_bindings`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_sessions`;
          yield* sql`DELETE FROM orchestration_v2_projection_subagents`;
          yield* sql`DELETE FROM orchestration_v2_projection_nodes`;
          yield* sql`DELETE FROM orchestration_v2_projection_run_attempts`;
          yield* sql`DELETE FROM orchestration_v2_projection_runs`;
          yield* sql`DELETE FROM orchestration_v2_projection_threads`;
          yield* sql`DELETE FROM orchestration_v2_turn_item_positions`;

          const pageSize = 500;
          let lastSequence = 0;
          while (true) {
            const page = yield* eventStore
              .read({ afterSequence: lastSequence, throughSequence, limit: pageSize })
              .pipe(Stream.runCollect);
            for (const stored of page) {
              yield* projectionStore.apply(stored.event);
              if (stored.event.type === "turn-item.updated") {
                yield* sql`
                INSERT INTO orchestration_v2_turn_item_positions (
                  thread_id,
                  turn_item_id,
                  ordinal
                )
                VALUES (
                  ${stored.event.threadId},
                  ${stored.event.payload.id},
                  ${stored.event.payload.ordinal}
                )
                ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET
                  ordinal = excluded.ordinal
                `;
              }
              lastSequence = stored.sequence;
            }
            if (page.length < pageSize) break;
            yield* Effect.yieldNow;
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
              ${lastSequence},
              ${now}
            )
            ON CONFLICT(projection_name) DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
        }),
      );
      return yield* verify;
    });

    const mapError =
      (operation: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.mapError((cause) => new ProjectionMaintenanceError({ operation, cause })),
        );

    // Keep thread.created as the verification and replay anchor; clients recognize deletion by thread.deleted event type.
    const SUPERSEDABLE_THREAD_EVENT_TYPES = [
      "thread.archived",
      "thread.unarchived",
      "thread.settled",
      "thread.unsettled",
      "thread.snoozed",
      "thread.unsnoozed",
      "thread.pinned",
      "thread.auto-settle-set",
      "thread.later-set",
      "thread.unpinned",
      "thread.pin-reordered",
      "thread.active-reordered",
      "thread.metadata-updated",
      "thread.pull-request-synced",
      "thread.runtime-mode-updated",
      "thread.interaction-mode-updated",
      "thread.model-selection-updated",
      "thread.provider-switched",
      "thread.guest-share-updated",
    ];
    // Read-state events preserve updatedAt and supersede only each other. Activity events supersede both groups.
    const READ_STATE_THREAD_EVENT_TYPES = ["thread.visited", "thread.marked-unread"];
    // Older clients may skip these events, so only a newer event of the same type or activity supersedes them.
    const METADATA_THREAD_EVENT_TYPES = [
      "thread.tags-updated",
      "thread.folder-updated",
      "thread.notification-level-updated",
      "thread.color-updated",
    ];
    // The order of orchestration_events_v2_thread_state_idx (migration 113). The pass names that
    // index, so a type added here fails there until a migration rebuilds the index with it.
    const THREAD_STATE_EVENT_TYPES = [
      ...SUPERSEDABLE_THREAD_EVENT_TYPES,
      ...READ_STATE_THREAD_EVENT_TYPES,
      ...METADATA_THREAD_EVENT_TYPES,
      "thread.pull-request-link-updated",
    ];
    // Literal, not bound: SQLite uses a partial index only for terms that match its own.
    const threadStateEventTypeList = sql.literal(
      THREAD_STATE_EVENT_TYPES.map((type) => `'${type}'`).join(", "),
    );

    const supersedableThreadEventTypes = new Set(SUPERSEDABLE_THREAD_EVENT_TYPES);
    const readStateThreadEventTypes = new Set(READ_STATE_THREAD_EVENT_TYPES);
    const metadataThreadEventTypes = new Set(METADATA_THREAD_EVENT_TYPES);
    const threadStateEventTypes = new Set(THREAD_STATE_EVENT_TYPES);
    // Subagent snapshots stay intact because later rows can reference an earlier prompt.
    // Commanded turn items stay for command-result replay.
    // Small pages bound work on the reader worker and synchronous fallback.
    const COMPACTION_PAGE_SIZE = 50;

    interface CompactionEventRow {
      readonly sequence: number;
      readonly application_event_version: number;
      readonly aggregate_kind: string;
      readonly stream_id: string;
      readonly event_type: string;
      readonly entity_id: string | null;
    }

    const pullRequestLinkKey = sql.literal(`json_array(
      json_extract(event.payload_json, '$.host'),
      json_extract(event.payload_json, '$.repository'),
      json_extract(event.payload_json, '$.number'))`);

    // Keep first/latest keyed events for replay order. A pass classifies the events past the mark
    // the last complete pass reached, newest first, then each chat's thread state below it that
    // those events can supersede. That deletes what a full pass would, except that a message, node
    // or turn item keeps one more event on each side of every mark its updates span.
    const compactEventStore = Effect.fn("ProjectionMaintenance.compactEventStore")(function* (
      betweenPages: Effect.Effect<void> = Effect.void,
      mode: "incremental" | "full" = "incremental",
    ) {
      const incremental = mode === "incremental";
      const storedMark = incremental
        ? sql`(SELECT compacted_through_sequence FROM orchestration_v2_event_store_compaction)`
        : sql.literal("0");
      const bounds = yield* sql<{
        readonly event_sequence: number;
        readonly compacted_through_sequence: number;
        readonly receipt_row_id: number;
      }>`
        SELECT
          COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) AS event_sequence,
          COALESCE(${storedMark}, 0) AS compacted_through_sequence,
          COALESCE((SELECT MAX(rowid) FROM orchestration_command_receipts), 0) AS receipt_row_id
      `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
      const throughSequence = bounds[0]?.event_sequence ?? 0;
      const compactedThroughSequence = bounds[0]?.compacted_through_sequence ?? 0;
      const throughReceiptRowId = bounds[0]?.receipt_row_id ?? 0;
      const retainedThreadIds = new Set<string>();
      const retainedReadStateThreadIds = new Set<string>();
      const retainedMetadataEvents = new Set<string>();
      // Retain each key's oldest candidate, deleting it only when an older event appears.
      const oldestCandidateByEntityKey = new Map<string, number | null>();
      const touchedThreadIds = new Set<string>();
      let deletedEventCount = 0;
      let deletedReceiptCount = 0;
      let pages = 0;
      const nextPage = Effect.suspend(() => (pages++ === 0 ? Effect.void : betweenPages));

      // Rows arrive newest first. Returns the sequences the row makes obsolete.
      const classify = (row: CompactionEventRow): ReadonlyArray<number> => {
        if (row.application_event_version !== 2) return [];
        if (row.aggregate_kind === "thread" && supersedableThreadEventTypes.has(row.event_type)) {
          if (retainedThreadIds.has(row.stream_id)) return [row.sequence];
          retainedThreadIds.add(row.stream_id);
          return [];
        }
        if (row.aggregate_kind === "thread" && readStateThreadEventTypes.has(row.event_type)) {
          if (
            retainedThreadIds.has(row.stream_id) ||
            retainedReadStateThreadIds.has(row.stream_id)
          ) {
            return [row.sequence];
          }
          retainedReadStateThreadIds.add(row.stream_id);
          return [];
        }
        if (row.aggregate_kind === "thread" && metadataThreadEventTypes.has(row.event_type)) {
          const key = `${row.event_type}:${row.stream_id}`;
          if (retainedThreadIds.has(row.stream_id) || retainedMetadataEvents.has(key)) {
            return [row.sequence];
          }
          retainedMetadataEvents.add(key);
          return [];
        }
        if (
          row.event_type === "thread.pull-request-link-updated" &&
          retainedThreadIds.has(row.stream_id)
        ) {
          // A newer whole-thread payload already carries this link's state.
          return [row.sequence];
        }
        if (
          row.event_type !== "thread.pull-request-link-updated" &&
          row.event_type !== "message.updated" &&
          row.event_type !== "node.updated" &&
          !(row.event_type === "turn-item.updated" && row.entity_id !== null)
        ) {
          return [];
        }
        const key = encodeEntityKey([row.event_type, row.stream_id, row.entity_id]);
        const candidate = oldestCandidateByEntityKey.get(key);
        oldestCandidateByEntityKey.set(key, candidate === undefined ? null : row.sequence);
        return candidate === undefined || candidate === null ? [] : [candidate];
      };

      // One per page, inside the pass span.
      const deleteEvents = Effect.fnUntraced(function* (sequences: ReadonlyArray<number>) {
        // Never hold a transaction or the reader lock across a yield or a rest.
        yield* Effect.yieldNow;
        if (sequences.length === 0) return;
        const deleted = yield* sql`
          DELETE FROM orchestration_events WHERE sequence IN ${sql.in(sequences)} RETURNING sequence
        `;
        deletedEventCount += deleted.length;
        yield* Effect.yieldNow;
      });

      // Page every event past the mark to bound sparse scans.
      let throughWindow = throughSequence;
      while (throughWindow > compactedThroughSequence) {
        yield* nextPage;
        const rows = yield* sql<CompactionEventRow>`
          SELECT
            event.sequence,
            event.application_event_version,
            event.aggregate_kind,
            event.stream_id,
            event.event_type,
            CASE
              WHEN event.application_event_version = 2
                AND event.event_type IN ('message.updated', 'node.updated')
              THEN json_extract(event.payload_json, '$.id')
              WHEN event.application_event_version = 2
                AND event.event_type = 'turn-item.updated'
                AND event.command_id IS NULL
                AND json_extract(event.payload_json, '$.type') <> 'subagent'
              THEN json_extract(event.payload_json, '$.id')
              WHEN event.application_event_version = 2
                AND event.event_type = 'thread.pull-request-link-updated'
              THEN ${pullRequestLinkKey}
              ELSE NULL
            END AS entity_id
          FROM orchestration_events AS event
          WHERE event.sequence > ${compactedThroughSequence}
            AND event.sequence <= ${throughWindow}
          ORDER BY event.sequence DESC
          LIMIT ${COMPACTION_PAGE_SIZE + 1}
        `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
        const page = rows.slice(0, COMPACTION_PAGE_SIZE);
        for (const row of page) {
          if (
            row.application_event_version === 2 &&
            row.aggregate_kind === "thread" &&
            threadStateEventTypes.has(row.event_type)
          ) {
            touchedThreadIds.add(row.stream_id);
          }
        }
        yield* deleteEvents(page.flatMap(classify));
        throughWindow = rows[COMPACTION_PAGE_SIZE]?.sequence ?? compactedThroughSequence;
      }

      // Earlier passes left each chat a few thread-state events below the mark.
      for (const threadId of touchedThreadIds) {
        let throughThreadState = compactedThroughSequence;
        while (throughThreadState > 0) {
          yield* nextPage;
          const rows = yield* sql<CompactionEventRow>`
            SELECT
              event.sequence,
              event.application_event_version,
              event.aggregate_kind,
              event.stream_id,
              event.event_type,
              CASE
                WHEN event.application_event_version = 2
                  AND event.event_type = 'thread.pull-request-link-updated'
                THEN ${pullRequestLinkKey}
                ELSE NULL
              END AS entity_id
            FROM orchestration_events AS event
              INDEXED BY orchestration_events_v2_thread_state_idx
            WHERE event.aggregate_kind = 'thread'
              AND event.event_type IN (${threadStateEventTypeList})
              AND event.stream_id = ${threadId}
              AND event.sequence <= ${throughThreadState}
            ORDER BY event.sequence DESC
            LIMIT ${COMPACTION_PAGE_SIZE + 1}
          `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
          yield* deleteEvents(rows.slice(0, COMPACTION_PAGE_SIZE).flatMap(classify));
          throughThreadState = rows[COMPACTION_PAGE_SIZE]?.sequence ?? 0;
        }
      }

      if (incremental && throughSequence > compactedThroughSequence) {
        yield* sql`
          INSERT INTO orchestration_v2_event_store_compaction (id, compacted_through_sequence)
          VALUES (1, ${throughSequence})
          ON CONFLICT(id) DO UPDATE SET compacted_through_sequence =
            MAX(compacted_through_sequence, excluded.compacted_through_sequence)
        `;
      }

      // An imported chat's v1 events and legacy receipts are obsolete, and nothing writes either
      // anymore, so the first pass after its import deletes them and marks the chat done. Untraced:
      // one per chat, inside the pass span.
      const compactLegacyThread = Effect.fnUntraced(function* (threadId: string) {
        // Advance by every indexed row so even a page with no legacy rows bounds reader work.
        let throughLegacySequence = throughSequence;
        while (throughLegacySequence > 0) {
          yield* nextPage;
          const rows = yield* sql<{
            readonly sequence: number;
            readonly application_event_version: number;
          }>`
            SELECT event.sequence, event.application_event_version
            FROM orchestration_events AS event INDEXED BY idx_orch_events_stream_sequence
            WHERE event.aggregate_kind = 'thread'
              AND event.stream_id = ${threadId}
              AND event.sequence <= ${throughLegacySequence}
            ORDER BY event.sequence DESC
            LIMIT ${COMPACTION_PAGE_SIZE + 1}
          `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
          const sequences = rows
            .slice(0, COMPACTION_PAGE_SIZE)
            .filter((row) => row.application_event_version === 1)
            .map((row) => row.sequence);
          yield* deleteEvents(sequences);
          throughLegacySequence = rows[COMPACTION_PAGE_SIZE]?.sequence ?? 0;
        }
        let throughLegacyRowId = throughReceiptRowId;
        while (throughLegacyRowId > 0) {
          yield* nextPage;
          const rows = yield* sql<{
            readonly command_id: string;
            readonly row_id: number;
            readonly command_type: string;
          }>`
            SELECT receipt.command_id, receipt.rowid AS row_id, receipt.command_type
            FROM orchestration_command_receipts AS receipt
              INDEXED BY idx_orch_command_receipts_aggregate
            WHERE receipt.aggregate_kind = 'thread'
              AND receipt.aggregate_id = ${threadId}
              AND receipt.rowid <= ${throughLegacyRowId}
            ORDER BY receipt.rowid DESC
            LIMIT ${COMPACTION_PAGE_SIZE + 1}
          `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
          const commandIds = rows
            .slice(0, COMPACTION_PAGE_SIZE)
            .filter((row) => row.command_type === "legacy")
            .map((row) => row.command_id);
          yield* Effect.yieldNow;
          if (commandIds.length > 0) {
            const deleted = yield* sql`
              DELETE FROM orchestration_command_receipts
              WHERE command_id IN ${sql.in(commandIds)} AND command_type = 'legacy'
              RETURNING command_id
            `;
            deletedReceiptCount += deleted.length;
            yield* Effect.yieldNow;
          }
          throughLegacyRowId = rows[COMPACTION_PAGE_SIZE]?.row_id ?? 0;
        }
        if (incremental) {
          yield* sql`
            UPDATE orchestration_v2_legacy_imports
            SET legacy_rows_compacted_at = ${DateTime.formatIso(yield* DateTime.now)}
            WHERE thread_id = ${threadId}
          `;
        }
      });

      let afterLegacyThreadId = "";
      let legacyThreadCount = COMPACTION_PAGE_SIZE;
      while (legacyThreadCount === COMPACTION_PAGE_SIZE) {
        yield* nextPage;
        const threads = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id
          FROM orchestration_v2_legacy_imports
          WHERE transcript_imported_at IS NOT NULL
            ${incremental ? sql`AND legacy_rows_compacted_at IS NULL` : sql.literal("")}
            AND thread_id > ${afterLegacyThreadId}
          ORDER BY thread_id
          LIMIT ${COMPACTION_PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
        for (const thread of threads) {
          yield* compactLegacyThread(thread.thread_id);
        }
        legacyThreadCount = threads.length;
        afterLegacyThreadId = threads.at(-1)?.thread_id ?? afterLegacyThreadId;
      }

      const freelistRows = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      const pageSizeRows = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
      const reclaimableBytes =
        (freelistRows[0]?.freelist_count ?? 0) * (pageSizeRows[0]?.page_size ?? 0);

      return { deletedEventCount, deletedReceiptCount, reclaimableBytes };
    }, mapError("compact event store"));

    // Untraced: runs once per item row and event. Undefined when the payload does not decode,
    // null when the item keeps its full output.
    const prunedItemPayload = Effect.fnUntraced(function* (payloadJson: string) {
      const decoded = yield* Effect.result(decodeTurnItemPayload(payloadJson));
      if (Result.isFailure(decoded)) return undefined;
      if (keepsFullOutput(decoded.success)) return null;
      return yield* encodeTurnItemPayload(projectTurnItemForWire(decoded.success));
    });

    // A fork reads inherited items from its source's rows, and side chats and subagents live in
    // their parent's view, so a chat is cold only when its whole family is: every listed chat
    // settled, archived or deleted, none pinned, and none active since idleBefore.
    const familyIsCold = (rootThreadId: string, idleBefore: string) =>
      sql<{ readonly cold: number }>`
        SELECT (
          EXISTS (
            SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${rootThreadId}
          )
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_v2_projection_threads AS member
            WHERE json_extract(member.payload_json, '$.lineage.rootThreadId') = ${rootThreadId}
              AND (
                member.updated_at >= ${idleBefore}
                OR json_extract(member.payload_json, '$.pinnedAt') IS NOT NULL
                OR (
                  json_extract(member.payload_json, '$.lineage.relationshipToParent')
                    IS NOT 'subagent'
                  AND json_extract(member.payload_json, '$.lineage.sideChat') IS NOT 1
                  AND member.archived_at IS NULL
                  AND member.deleted_at IS NULL
                  AND NOT (
                    json_extract(member.payload_json, '$.settledOverride') IS 'settled'
                    AND json_extract(member.payload_json, '$.settledAt') IS NOT NULL
                  )
                )
              )
          )
        ) AS cold
      `.pipe(Effect.map((rows) => rows[0]?.cold === 1));

    // Pacing leaves time for the family to reopen, so every write checks it again inside its
    // transaction, which the single writer serializes with every other write.
    const whileFamilyCold =
      (rootThreadId: string, idleBefore: string) =>
      <A, E, R>(write: Effect.Effect<A, E, R>) =>
        sql.withTransaction(
          Effect.flatMap(familyIsCold(rootThreadId, idleBefore), (isCold) =>
            isCold ? Effect.asSome(write) : Effect.succeedNone,
          ),
        );

    // Projection rows first, then every event of those items, so a rebuild replays the pruned shape.
    // Each read scans one bounded page; writes run in their own short transaction between pages.
    // Untraced: runs once per chat inside the pass span.
    const pruneThreadToolOutput = Effect.fnUntraced(function* (input: {
      readonly threadId: string;
      readonly rootThreadId: string;
      readonly updatedAt: string;
      readonly idleBefore: string;
      readonly betweenPages: Effect.Effect<void>;
    }) {
      let itemCount = 0;
      let eventCount = 0;
      let unreadableItemCount = 0;
      const done = (pruned: boolean) => ({ pruned, itemCount, eventCount, unreadableItemCount });
      const whileCold = whileFamilyCold(input.rootThreadId, input.idleBefore);
      if (
        !(yield* familyIsCold(input.rootThreadId, input.idleBefore).pipe(
          NodeSqliteClient.readOnly,
          NodeSqliteClient.inBackground,
        ))
      )
        return done(false);
      // Events appended after this read belong to new activity and stay as written.
      const [stream] = yield* sql<{ readonly last_sequence: number | null }>`
        SELECT MAX(sequence) AS last_sequence
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}
      `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
      const lastSequence = stream?.last_sequence ?? 0;

      const prunedItemIds = new Set<string>();
      let ordinalCursor = Number.MIN_SAFE_INTEGER;
      let itemCursor = "";
      while (true) {
        const items = yield* sql<{
          readonly turn_item_id: string;
          readonly ordinal: number;
          readonly status: string;
          readonly updated_at: string;
          readonly payload_json: string | null;
          readonly stored_json: string | null;
        }>`
          SELECT
            turn_item_id,
            ordinal,
            status,
            updated_at,
            CASE
              WHEN type IN ('command_execution', 'dynamic_tool')
                AND status IN ${sql.in(SETTLED_ITEM_STATUSES)}
                AND updated_at < ${input.idleBefore}
              THEN ${sql.literal(turnItemPayloadSql())}
            END AS payload_json,
            CASE
              WHEN type IN ('command_execution', 'dynamic_tool')
                AND status IN ${sql.in(SETTLED_ITEM_STATUSES)}
                AND updated_at < ${input.idleBefore}
              THEN payload_json
            END AS stored_json
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${input.threadId}
            AND (ordinal, turn_item_id) > (${ordinalCursor}, ${itemCursor})
          ORDER BY ordinal, turn_item_id
          LIMIT ${COMPACTION_PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
        const updates: Array<{
          readonly row: (typeof items)[number];
          readonly json: string;
        }> = [];
        for (const row of items) {
          if (row.payload_json === null) continue;
          const pruned = yield* prunedItemPayload(row.payload_json);
          if (pruned === undefined) unreadableItemCount += 1;
          // A pass that stopped before rewriting the events left this row pruned.
          else if (pruned === null) continue;
          else {
            const stored = stripTurnItemPayloadColumns(pruned);
            if (stored === row.stored_json) prunedItemIds.add(row.turn_item_id);
            else updates.push({ row, json: stored });
          }
        }
        yield* Effect.yieldNow;
        if (updates.length > 0) {
          // A row that changed since the read keeps its new payload, and so do its events.
          const updated = yield* whileCold(
            Effect.forEach(
              updates,
              ({ row, json }) => sql<{ readonly turn_item_id: string }>`
                UPDATE orchestration_v2_projection_turn_items
                SET payload_json = ${json}
                WHERE turn_item_id = ${row.turn_item_id}
                  AND status = ${row.status}
                  AND updated_at = ${row.updated_at}
                RETURNING turn_item_id
              `,
            ),
          );
          if (Option.isNone(updated)) return done(false);
          for (const row of updated.value.flat()) {
            prunedItemIds.add(row.turn_item_id);
            itemCount += 1;
          }
          yield* Effect.yieldNow;
        }
        const last = items.at(-1);
        if (last === undefined || items.length < COMPACTION_PAGE_SIZE) break;
        ordinalCursor = last.ordinal;
        itemCursor = last.turn_item_id;
        yield* input.betweenPages;
      }

      let sequenceCursor = 0;
      while (prunedItemIds.size > 0) {
        const events = yield* sql<{
          readonly sequence: number;
          readonly item_id: string | null;
        }>`
          SELECT
            sequence,
            CASE
              WHEN application_event_version = 2 AND event_type = 'turn-item.updated'
              THEN json_extract(payload_json, '$.id')
            END AS item_id
          FROM orchestration_events
          WHERE aggregate_kind = 'thread'
            AND stream_id = ${input.threadId}
            AND sequence > ${sequenceCursor}
            AND sequence <= ${lastSequence}
          ORDER BY sequence
          LIMIT ${COMPACTION_PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
        const matched = events
          .filter((event) => event.item_id !== null && prunedItemIds.has(event.item_id))
          .map((event) => event.sequence);
        if (matched.length > 0) {
          const payloads = yield* sql<{
            readonly sequence: number;
            readonly payload_json: string;
          }>`
            SELECT sequence, payload_json
            FROM orchestration_events
            WHERE sequence IN ${sql.in(matched)}
          `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
          const updates: Array<{ readonly sequence: number; readonly json: string }> = [];
          for (const event of payloads) {
            const pruned = yield* prunedItemPayload(event.payload_json);
            if (pruned === undefined) unreadableItemCount += 1;
            else if (pruned !== null && pruned !== event.payload_json) {
              updates.push({ sequence: event.sequence, json: pruned });
            }
          }
          yield* Effect.yieldNow;
          if (updates.length > 0) {
            const written = yield* whileCold(
              Effect.forEach(
                updates,
                ({ sequence, json }) => sql`
                  UPDATE orchestration_events
                  SET payload_json = ${json}
                  WHERE sequence = ${sequence}
                `,
                { discard: true },
              ),
            );
            if (Option.isNone(written)) return done(false);
            eventCount += updates.length;
            yield* Effect.yieldNow;
          }
        }
        const last = events.at(-1);
        if (last === undefined || events.length < COMPACTION_PAGE_SIZE) break;
        sequenceCursor = last.sequence;
        yield* input.betweenPages;
      }

      // Later activity moves updated_at past this mark and brings the chat back.
      const marked = yield* whileCold(sql`
        INSERT INTO orchestration_v2_thread_output_retention (
          thread_id,
          pruned_through_updated_at
        )
        VALUES (${input.threadId}, ${input.updatedAt})
        ON CONFLICT(thread_id) DO UPDATE SET
          pruned_through_updated_at = excluded.pruned_through_updated_at
      `);
      return done(Option.isSome(marked));
    });

    const pruneColdThreadToolOutput = Effect.fn("ProjectionMaintenance.pruneColdThreadToolOutput")(
      function* (input: {
        readonly idleBefore: DateTime.Utc;
        readonly betweenPages?: Effect.Effect<void>;
      }) {
        const idleBefore = DateTime.formatIso(input.idleBefore);
        const betweenPages = input.betweenPages ?? Effect.void;
        let threadCount = 0;
        let itemCount = 0;
        let eventCount = 0;
        let unreadableItemCount = 0;
        let threadCursor = "";

        while (true) {
          // Every turn, item and message event moves the thread's updated_at.
          const threads = yield* sql<{
            readonly thread_id: string;
            readonly updated_at: string;
            readonly root_thread_id: string | null;
            readonly candidate: number;
          }>`
            WITH page AS (
              SELECT thread_id, updated_at, payload_json
              FROM orchestration_v2_projection_threads
              WHERE thread_id > ${threadCursor}
              ORDER BY thread_id
              LIMIT ${COMPACTION_PAGE_SIZE}
            )
            SELECT
              page.thread_id,
              page.updated_at,
              json_extract(page.payload_json, '$.lineage.rootThreadId') AS root_thread_id,
              (
                page.updated_at < ${idleBefore}
                AND (
                  retention.pruned_through_updated_at IS NULL
                  OR retention.pruned_through_updated_at < page.updated_at
                )
              ) AS candidate
            FROM page
            LEFT JOIN orchestration_v2_thread_output_retention AS retention
              ON retention.thread_id = page.thread_id
            ORDER BY page.thread_id
          `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);

          for (const thread of threads) {
            if (thread.candidate !== 1 || thread.root_thread_id === null) continue;
            const result = yield* pruneThreadToolOutput({
              threadId: thread.thread_id,
              rootThreadId: thread.root_thread_id,
              updatedAt: thread.updated_at,
              idleBefore,
              betweenPages,
            });
            if (result.pruned) threadCount += 1;
            itemCount += result.itemCount;
            eventCount += result.eventCount;
            unreadableItemCount += result.unreadableItemCount;
            yield* betweenPages;
          }

          const last = threads.at(-1);
          if (last === undefined || threads.length < COMPACTION_PAGE_SIZE) break;
          threadCursor = last.thread_id;
          yield* betweenPages;
        }

        return { threadCount, itemCount, eventCount, unreadableItemCount };
      },
      mapError("prune cold thread tool output"),
    );

    // Newest first, so the first event seen for an entity is the one its projection row holds.
    // Untraced: runs once per chat inside the pass span.
    const compactThreadHistory = Effect.fnUntraced(function* (input: {
      readonly threadId: string;
      readonly rootThreadId: string;
      readonly idleBefore: string;
      readonly betweenPages: Effect.Effect<void>;
    }) {
      let deletedEventCount = 0;
      const done = (compacted: boolean) => ({ compacted, deletedEventCount });
      const whileCold = whileFamilyCold(input.rootThreadId, input.idleBefore);
      if (
        !(yield* familyIsCold(input.rootThreadId, input.idleBefore).pipe(
          NodeSqliteClient.readOnly,
          NodeSqliteClient.inBackground,
        ))
      )
        return done(false);
      // Events appended after this read belong to new activity and stay as written.
      const [stream] = yield* sql<{ readonly last_sequence: number | null }>`
        SELECT MAX(sequence) AS last_sequence
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${input.threadId}
      `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
      const lastSequence = stream?.last_sequence ?? 0;
      // Commits with each delete, so a resume from a cursor before it gets a snapshot. Until the
      // pass finishes it covers only what was deleted, so a stopped chat stays a candidate.
      const mark = (throughSequence: number) => sql`
        INSERT INTO orchestration_v2_thread_history_compaction (
          thread_id,
          compacted_through_sequence
        )
        VALUES (${input.threadId}, ${throughSequence})
        ON CONFLICT(thread_id) DO UPDATE SET
          compacted_through_sequence = MAX(
            compacted_through_sequence,
            excluded.compacted_through_sequence
          )
      `;

      const seen = new Set<string>();
      // Provider turns whose newest event has no token usage keep the newest one that has it.
      const missingTokenUsage = new Set<string>();
      let throughSequence = lastSequence;
      while (throughSequence > 0) {
        const rows = yield* sql<{
          readonly sequence: number;
          readonly event_type: string;
          readonly entity_id: string | null;
          readonly commanded: number;
          readonly has_token_usage: number;
        }>`
          SELECT
            sequence,
            event_type,
            CASE
              WHEN event_type IN ${sql.in(LATEST_ONLY_EVENT_TYPES)}
                AND (
                  event_type <> 'turn-item.updated'
                  OR json_extract(payload_json, '$.type') IS NOT 'subagent'
                )
              THEN json_extract(
                payload_json,
                CASE
                  WHEN event_type = 'provider-thread.pinned-instructions-set'
                  THEN '$.providerThreadId'
                  ELSE '$.id'
                END
              )
            END AS entity_id,
            command_id IS NOT NULL AS commanded,
            (
              event_type = 'provider-turn.updated'
              AND json_type(payload_json, '$.tokenUsage') IS NOT NULL
            ) AS has_token_usage
          FROM orchestration_events
          WHERE application_event_version = 2
            AND aggregate_kind = 'thread'
            AND stream_id = ${input.threadId}
            AND sequence <= ${throughSequence}
          ORDER BY sequence DESC
          LIMIT ${COMPACTION_PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
        const obsolete: number[] = [];
        for (const row of rows) {
          if (row.entity_id === null) continue;
          const key = encodeEntityKey([row.event_type, input.threadId, row.entity_id]);
          if (!seen.has(key)) {
            seen.add(key);
            if (row.event_type === "provider-turn.updated" && row.has_token_usage !== 1) {
              missingTokenUsage.add(key);
            }
          } else if (row.has_token_usage === 1 && missingTokenUsage.has(key)) {
            missingTokenUsage.delete(key);
          } else if (row.commanded === 0) {
            // A duplicate command replays every event of its command, so commanded ones stay.
            obsolete.push(row.sequence);
          }
        }
        yield* Effect.yieldNow;
        if (obsolete.length > 0) {
          const deleted = yield* whileCold(
            sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(obsolete)}`.pipe(
              Effect.andThen(mark(obsolete[0]!)),
            ),
          );
          if (Option.isNone(deleted)) return done(false);
          deletedEventCount += obsolete.length;
          yield* Effect.yieldNow;
        }
        const last = rows.at(-1);
        if (last === undefined || rows.length < COMPACTION_PAGE_SIZE) break;
        throughSequence = last.sequence - 1;
        yield* input.betweenPages;
      }

      return done(Option.isSome(yield* whileCold(mark(lastSequence))));
    });

    const compactColdThreadHistory = Effect.fn("ProjectionMaintenance.compactColdThreadHistory")(
      function* (input: {
        readonly idleBefore: DateTime.Utc;
        readonly betweenPages?: Effect.Effect<void>;
      }) {
        const idleBefore = DateTime.formatIso(input.idleBefore);
        const betweenPages = input.betweenPages ?? Effect.void;
        let threadCount = 0;
        let deletedEventCount = 0;
        let threadCursor = "";

        while (true) {
          // A compacted chat comes back once it has events past its mark.
          const threads = yield* sql<{
            readonly thread_id: string;
            readonly root_thread_id: string | null;
            readonly candidate: number;
          }>`
            WITH page AS (
              SELECT thread_id, updated_at, payload_json
              FROM orchestration_v2_projection_threads
              WHERE thread_id > ${threadCursor}
              ORDER BY thread_id
              LIMIT ${COMPACTION_PAGE_SIZE}
            )
            SELECT
              page.thread_id,
              json_extract(page.payload_json, '$.lineage.rootThreadId') AS root_thread_id,
              (
                page.updated_at < ${idleBefore}
                AND COALESCE(history.compacted_through_sequence, 0) < (
                  SELECT COALESCE(MAX(event.sequence), 0)
                  FROM orchestration_events AS event
                  WHERE event.application_event_version = 2
                    AND event.aggregate_kind = 'thread'
                    AND event.stream_id = page.thread_id
                )
              ) AS candidate
            FROM page
            LEFT JOIN orchestration_v2_thread_history_compaction AS history
              ON history.thread_id = page.thread_id
            ORDER BY page.thread_id
          `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);

          for (const thread of threads) {
            if (thread.candidate !== 1 || thread.root_thread_id === null) continue;
            const result = yield* compactThreadHistory({
              threadId: thread.thread_id,
              rootThreadId: thread.root_thread_id,
              idleBefore,
              betweenPages,
            });
            if (result.compacted) threadCount += 1;
            deletedEventCount += result.deletedEventCount;
            yield* betweenPages;
          }

          const last = threads.at(-1);
          if (last === undefined || threads.length < COMPACTION_PAGE_SIZE) break;
          threadCursor = last.thread_id;
          yield* betweenPages;
        }

        return { threadCount, deletedEventCount };
      },
      mapError("compact cold thread history"),
    );

    return ProjectionMaintenanceV2.of({
      verify: mapError("verify")(verify),
      rebuild: mapError("rebuild")(rebuild),
      compactEventStore,
      pruneColdThreadToolOutput,
      compactColdThreadHistory,
    });
  }),
);
