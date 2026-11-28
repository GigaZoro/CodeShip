import {
  type ThreadId,
  type OrchestrationV2DomainEvent,
  OrchestrationV2TurnItemJson,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { mcpAppFromToolItem } from "@t3tools/shared/toolOutput";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import {
  EVENT_LOG_PRUNE_MARK,
  EVENT_LOG_PRUNED_THROUGH,
} from "../persistence/OrchestrationEventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { stripTurnItemPayloadColumns, turnItemPayloadSql } from "./TurnItemPayloadColumns.ts";
import { projectTurnItemForWire } from "./WireProjection.ts";

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
  /**
   * Deletes events the projections already cover once they are older than the retained history,
   * then purges any deleted thread that still holds conversation content.
   */
  readonly pruneEventStore: (betweenPages?: Effect.Effect<void>) => Effect.Effect<
    {
      readonly deletedEventCount: number;
      readonly deletedReceiptCount: number;
      readonly purgedRowCount: number;
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
  /**
   * Removes a deleted thread's conversation, and that of deleted run-fork sources it alone kept.
   * Returns the number of rows removed.
   */
  readonly purgeDeletedThread: (
    threadId: ThreadId,
  ) => Effect.Effect<number, ProjectionMaintenanceError>;
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

// Reconnect replay and command-id retries read this tail; older cursors resync from a snapshot.
const RETAINED_EVENT_HISTORY = Duration.days(1);
// Small pages bound work on the reader worker and synchronous fallback.
const PAGE_SIZE = 50;
const REFERENCE_SCAN_WINDOW = 1000;
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
  "run.output-submitted": "all",
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
  "thread.visit-recorded": "all",
  "thread.marked-unread": "all",
  "thread.metadata-updated": "all",
  "thread.pull-request-synced": "all",
  "thread.issue-synced": "all",
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

const encodeEntityKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.NullOr(Schema.String)])),
);

// Bounds how long one purge statement holds the writer: on a real database a 500-row batch of
// turn items took about 400 ms, index and count-trigger work included.
const PURGE_BATCH_SIZE = 50;
// Titles default to the first message, so a tombstone cannot keep the real one.
export const DELETED_THREAD_TITLE = "Deleted thread";

// Every thread_id table that holds conversation text. The thread row stays as the tombstone, and
// the metadata that storage cleanup and usage history still read (checkpoints, provider sessions,
// provider turns, run attempts, context transfers) stays with it.
export const DELETED_THREAD_CONTENT_TABLES = [
  "orchestration_v2_turn_item_positions",
  "orchestration_v2_projection_turn_items",
  "orchestration_v2_projection_messages",
  "orchestration_v2_projection_nodes",
  "orchestration_v2_projection_runs",
  "orchestration_v2_projection_subagents",
  "orchestration_v2_projection_context_handoffs",
  "orchestration_v2_projection_runtime_requests",
  "orchestration_v2_projection_plans",
  "mcp_app_model_context",
  // A legacy thread's transcript source; deleting it means the importer has nothing to restore.
  "projection_thread_messages",
] as const;

type MetadataRow = {
  readonly projection_name: string;
  readonly last_sequence: number;
  readonly updated_at: string;
};

// Projection rows and turn-item.updated event payloads share this encoding.
const TurnItemPayload = Schema.fromJsonString(OrchestrationV2TurnItemJson);
const decodeTurnItemPayload = Schema.decodeUnknownEffect(TurnItemPayload);
const encodeTurnItemPayload = Schema.encodeEffect(TurnItemPayload);

const SETTLED_ITEM_STATUSES = ["completed", "failed", "cancelled", "interrupted"];
// The MCP App frame renders from the full input and output.
const keepsFullOutput = (item: OrchestrationV2TurnItem) =>
  (item.type !== "command_execution" && item.type !== "dynamic_tool") ||
  (item.type === "dynamic_tool" && mcpAppFromToolItem(item) !== undefined);

export const layer: Layer.Layer<ProjectionMaintenanceV2, never, SqlClient.SqlClient> = Layer.effect(
  ProjectionMaintenanceV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const writeMetadata = (name: string, sequence: number, at: DateTime.Utc) => sql`
      INSERT INTO orchestration_v2_projection_metadata (
        projection_name, schema_version, last_sequence, updated_at
      )
      VALUES (
        ${name},
        ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
        ${sequence},
        ${DateTime.formatIso(at)}
      )
      ON CONFLICT(projection_name) DO UPDATE SET
        last_sequence = excluded.last_sequence,
        updated_at = excluded.updated_at
    `;

    // Collects anchors whose prompt later rows borrow through promptSequence.
    const readPromptReferences = Effect.fnUntraced(function* (
      afterSequence: number,
      throughSequence: number,
      betweenPages: Effect.Effect<void>,
    ) {
      const referenced = new Set<number>();
      for (let cursor = afterSequence; cursor < throughSequence;) {
        const windowEnd = Math.min(cursor + REFERENCE_SCAN_WINDOW, throughSequence);
        const rows = yield* sql<{ readonly prompt_sequence: number }>`
          SELECT json_extract(payload_json, '$.promptSequence') AS prompt_sequence
          FROM orchestration_events
          WHERE sequence > ${cursor}
            AND sequence <= ${windowEnd}
            AND event_type IN ('subagent.updated', 'turn-item.updated')
            AND json_type(payload_json, '$.promptSequence') = 'integer'
        `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
        for (const row of rows) referenced.add(row.prompt_sequence);
        cursor = windowEnd;
        yield* betweenPages;
      }
      return referenced;
    });

    const pruneEvents = Effect.fnUntraced(function* (
      throughSequence: number,
      head: number,
      betweenPages: Effect.Effect<void>,
    ) {
      const referenced = yield* readPromptReferences(throughSequence, head, betweenPages);
      // Stream heads at or below the boundary are kept, so the anchors they borrow must stay too.
      const keptHeadReferences = yield* sql<{ readonly prompt_sequence: number }>`
        SELECT json_extract(event.payload_json, '$.promptSequence') AS prompt_sequence
        FROM (
          SELECT MAX(sequence) AS sequence FROM orchestration_events
          GROUP BY aggregate_kind, stream_id
        ) AS heads
        JOIN orchestration_events AS event ON event.sequence = heads.sequence
        WHERE heads.sequence <= ${throughSequence}
          AND event.event_type IN ('subagent.updated', 'turn-item.updated')
          AND json_type(event.payload_json, '$.promptSequence') = 'integer'
      `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
      for (const row of keptHeadReferences) referenced.add(row.prompt_sequence);
      yield* betweenPages;
      let referencesThrough = head;
      let deleted = 0;
      let cursor = 0;
      while (cursor < throughSequence) {
        const rows = yield* sql<{ readonly sequence: number; readonly prunable: number }>`
          SELECT
            event.sequence,
            CASE
              WHEN event.application_event_version = 1 THEN 0
              -- The legacy importer treats a thread without thread.created as not yet imported.
              WHEN event.event_type = 'thread.created' THEN 0
              -- Codex usage history reads the selection a run attempt started with.
              WHEN event.event_type = 'run.updated'
                AND json_extract(event.payload_json, '$.status') = 'running' THEN 0
              -- The newest row keeps each stream's high water, stream_version, and snapshot sequence.
              WHEN event.sequence = (
                SELECT MAX(newer.sequence) FROM orchestration_events AS newer
                WHERE newer.aggregate_kind = event.aggregate_kind
                  AND newer.stream_id = event.stream_id
              ) THEN 0
              ELSE 1
            END AS prunable
          FROM orchestration_events AS event
          WHERE event.sequence > ${cursor}
            AND event.sequence <= ${throughSequence}
          ORDER BY event.sequence ASC
          LIMIT ${PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
        const candidates = rows.filter((row) => row.prunable === 1).map((row) => row.sequence);
        // Never hold a transaction or the reader lock across a yield or a rest.
        yield* Effect.yieldNow;
        if (candidates.length > 0) {
          deleted += yield* sql.withTransaction(
            Effect.gen(function* () {
              // Rows appended since the reference scan may borrow a prompt from a candidate.
              const appended = yield* sql<{
                readonly sequence: number;
                readonly prompt_sequence: number | null;
              }>`
                SELECT
                  sequence,
                  CASE
                    WHEN event_type IN ('subagent.updated', 'turn-item.updated')
                      AND json_type(payload_json, '$.promptSequence') = 'integer'
                    THEN json_extract(payload_json, '$.promptSequence')
                  END AS prompt_sequence
                FROM orchestration_events
                WHERE sequence > ${referencesThrough}
              `;
              for (const row of appended) {
                if (row.prompt_sequence !== null) referenced.add(row.prompt_sequence);
                referencesThrough = Math.max(referencesThrough, row.sequence);
              }
              const obsolete = candidates.filter((sequence) => !referenced.has(sequence));
              if (obsolete.length === 0) return 0;
              yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(obsolete)}`;
              return obsolete.length;
            }),
          );
          yield* Effect.yieldNow;
        }
        // Rest after every page, including the last, so the next loop starts a fresh slice.
        yield* betweenPages;
        if (rows.length < PAGE_SIZE) break;
        cursor = rows.at(-1)?.sequence ?? throughSequence;
      }
      return deleted;
    });

    // Imported legacy threads are served from v2 rows; their v1 events and receipts have no reader.
    const pruneImportedLegacyHistory = Effect.fnUntraced(function* (
      throughSequence: number,
      throughReceiptRowId: number,
      betweenPages: Effect.Effect<void>,
    ) {
      let deletedEventCount = 0;
      let deletedReceiptCount = 0;
      for (let cursor = 0; ;) {
        const rows = yield* sql<{ readonly sequence: number; readonly imported: number }>`
          SELECT
            event.sequence,
            event.aggregate_kind = 'thread' AND EXISTS (
              SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
              WHERE legacy_import.thread_id = event.stream_id
                AND legacy_import.transcript_imported_at IS NOT NULL
            ) AS imported
          FROM orchestration_events AS event
            INDEXED BY idx_orchestration_events_application_sequence
          WHERE event.application_event_version = 1
            AND event.sequence > ${cursor}
            AND event.sequence <= ${throughSequence}
          ORDER BY event.sequence ASC
          LIMIT ${PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
        const obsolete = rows.filter((row) => row.imported === 1).map((row) => row.sequence);
        yield* Effect.yieldNow;
        if (obsolete.length > 0) {
          yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(obsolete)}`;
          deletedEventCount += obsolete.length;
          yield* Effect.yieldNow;
        }
        yield* betweenPages;
        if (rows.length < PAGE_SIZE) break;
        cursor = rows.at(-1)?.sequence ?? cursor;
      }
      for (let cursor = 0; ;) {
        const rows = yield* sql<{
          readonly row_id: number;
          readonly command_id: string;
          readonly imported: number;
        }>`
          SELECT
            receipt.rowid AS row_id,
            receipt.command_id,
            receipt.command_type = 'legacy' AND receipt.aggregate_kind = 'thread' AND EXISTS (
              SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
              WHERE legacy_import.thread_id = receipt.aggregate_id
                AND legacy_import.transcript_imported_at IS NOT NULL
            ) AS imported
          FROM orchestration_command_receipts AS receipt
          WHERE receipt.rowid > ${cursor} AND receipt.rowid <= ${throughReceiptRowId}
          ORDER BY receipt.rowid ASC
          LIMIT ${PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
        const obsolete = rows.filter((row) => row.imported === 1).map((row) => row.command_id);
        yield* Effect.yieldNow;
        if (obsolete.length > 0) {
          yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id IN ${sql.in(obsolete)}`;
          deletedReceiptCount += obsolete.length;
          yield* Effect.yieldNow;
        }
        yield* betweenPages;
        if (rows.length < PAGE_SIZE) break;
        cursor = rows.at(-1)?.row_id ?? cursor;
      }
      return { deletedEventCount, deletedReceiptCount };
    });

    // Sources read by live run forks or pending merge-backs, including their ancestors.
    const referencedSources = sql`referenced_sources(thread_id) AS (
        SELECT json_extract(fork.payload_json, '$.forkedFrom.threadId')
        FROM orchestration_v2_projection_threads AS fork
        WHERE fork.deleted_at IS NULL
          AND CASE WHEN json_valid(fork.payload_json)
            THEN json_extract(fork.payload_json, '$.forkedFrom.type') END = 'run'
        UNION
        SELECT transfer.source_thread_id
        FROM orchestration_v2_projection_context_transfers AS transfer
        JOIN orchestration_v2_projection_threads AS target
          ON target.thread_id = transfer.target_thread_id
        WHERE transfer.type = 'merge_back' AND transfer.status = 'pending'
          AND target.deleted_at IS NULL
        UNION
        SELECT json_extract(fork.payload_json, '$.forkedFrom.threadId')
        FROM referenced_sources
        JOIN orchestration_v2_projection_threads AS fork ON fork.thread_id = referenced_sources.thread_id
        WHERE CASE WHEN json_valid(fork.payload_json)
          THEN json_extract(fork.payload_json, '$.forkedFrom.type') END = 'run'
      )`;

    // A run fork shows its source's history without copying it, through any chain of forks, and a
    // pending merge-back still reads its source. Such a deleted thread keeps its content until
    // every live thread that shows it is deleted too.
    const purgeableThreads = (deletedThreadId: ThreadId | undefined) =>
      sql<{
        readonly thread_id: string;
      }>`
      WITH RECURSIVE ${referencedSources},
      candidate(thread_id) AS (${
        deletedThreadId === undefined
          ? sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL`
          : // Deleting a fork can release the deleted sources it was the last to show.
            sql`
              SELECT ${deletedThreadId}
              UNION
              SELECT json_extract(fork.payload_json, '$.forkedFrom.threadId')
              FROM candidate
              JOIN orchestration_v2_projection_threads AS fork
                ON fork.thread_id = candidate.thread_id
              WHERE CASE WHEN json_valid(fork.payload_json)
                THEN json_extract(fork.payload_json, '$.forkedFrom.type') END = 'run'
            `
      })
      SELECT thread.thread_id
      FROM candidate
      JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = candidate.thread_id
      WHERE thread.deleted_at IS NOT NULL
        AND thread.thread_id NOT IN (SELECT thread_id FROM referenced_sources WHERE thread_id IS NOT NULL)
        -- Earlier effects still read the thread; a later purge or sweep takes it.
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_effect_outbox AS effect
          WHERE effect.thread_id = thread.thread_id
            AND effect.status IN ('pending', 'running')
            -- Title generation has its own lane and needs nothing the purge removes.
            AND effect.effect_type NOT IN ('thread-content.purge', 'thread-title.generate')
        )
        -- A live parent settles its delegated task from this child's runs.
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_subagents AS task
          JOIN orchestration_v2_projection_threads AS parent ON parent.thread_id = task.thread_id
          WHERE task.child_thread_id = thread.thread_id
            AND task.status IN ('idle', 'pending', 'running', 'waiting')
            AND parent.deleted_at IS NULL
        )
        -- The delete's own purge always runs; the sweep only takes threads with something left.
        AND ${
          deletedThreadId !== undefined
            ? sql`1 = 1`
            : sql.or([
                sql`thread.title <> ${DELETED_THREAD_TITLE}`,
                // A thread renamed to the placeholder still has its first title in thread.created.
                sql`EXISTS (
            SELECT 1 FROM orchestration_events
              INDEXED BY idx_orchestration_events_agent_stream_sequence
            WHERE application_event_version = 2
              AND aggregate_kind = 'thread'
              AND stream_id = thread.thread_id
              AND event_type IN ('thread.created', 'thread.deleted')
              AND json_extract(payload_json, '$.title') IS NOT ${DELETED_THREAD_TITLE}
          )`,
                sql`json_type(thread.payload_json, '$.guestShare') IS NOT NULL`,
                // An interrupted pass leaves events the purge does not keep.
                sql`EXISTS (
                  SELECT 1 FROM orchestration_events
                    INDEXED BY idx_orchestration_events_agent_stream_sequence
                  WHERE application_event_version = 2
                    AND aggregate_kind = 'thread'
                    AND stream_id = thread.thread_id
                    AND event_type NOT IN ('thread.created', 'thread.deleted')
                    AND NOT (
                      event_type = 'run.updated'
                      AND json_extract(payload_json, '$.status') = 'running'
                    )
                )`,
                // The purge deletes settled requests and clears a failed one's error.
                sql`EXISTS (
                  SELECT 1 FROM orchestration_v2_effect_outbox AS effect
                  WHERE effect.thread_id = thread.thread_id
                    AND effect.effect_type <> 'thread-content.purge'
                    AND (
                      effect.status IN ('succeeded', 'cancelled')
                      OR (effect.status = 'failed' AND effect.last_error IS NOT NULL)
                    )
                )`,
                ...DELETED_THREAD_CONTENT_TABLES.map(
                  (table) =>
                    sql`EXISTS (SELECT 1 FROM ${sql(table)} WHERE thread_id = thread.thread_id)`,
                ),
              ])
        }
    `.pipe(NodeSqliteClient.readOnly);

    const purgeThreads = Effect.fnUntraced(function* (
      deletedThreadId: ThreadId | undefined,
      betweenPages: Effect.Effect<void>,
    ) {
      const threads = yield* purgeableThreads(deletedThreadId);
      const now = DateTime.formatIso(yield* DateTime.now);
      let purged = 0;
      // Each statement commits on its own, so a huge thread never holds the writer for long.
      const drain = Effect.fnUntraced(function* (
        deleteBatch: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>,
      ) {
        for (;;) {
          const rows = yield* deleteBatch;
          purged += rows.length;
          yield* Effect.yieldNow;
          yield* betweenPages;
          if (rows.length < PURGE_BATCH_SIZE) return;
        }
      });
      for (const { thread_id: threadId } of threads) {
        const tombstone = sql`(
          SELECT json_remove(json_set(payload_json, '$.title', ${DELETED_THREAD_TITLE}), '$.guestShare')
          FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
        )`;
        yield* sql`
          UPDATE orchestration_events
          SET payload_json = json_remove(
            json_set(payload_json, '$.title', ${DELETED_THREAD_TITLE}),
            '$.guestShare'
          )
          WHERE application_event_version = 2
            AND aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND event_type IN ('thread.created', 'thread.deleted')
        `;
        // The head row only holds the stream's position, so any other head becomes the tombstone.
        // First, so the head never borrows a prompt from an anchor already deleted below.
        yield* sql`
          UPDATE orchestration_events
          SET event_type = 'thread.deleted', payload_json = ${tombstone}, metadata_json = '{}'
          WHERE sequence = (
              SELECT MAX(sequence) FROM orchestration_events
              WHERE application_event_version = 2
                AND aggregate_kind = 'thread'
                AND stream_id = ${threadId}
            )
            AND event_type NOT IN ('thread.created', 'thread.deleted')
            AND NOT (
              event_type = 'run.updated' AND json_extract(payload_json, '$.status') = 'running'
            )
        `;
        for (const table of DELETED_THREAD_CONTENT_TABLES) {
          yield* drain(sql`
            DELETE FROM ${sql(table)}
            WHERE rowid IN (
              SELECT rowid FROM ${sql(table)} WHERE thread_id = ${threadId} LIMIT ${PURGE_BATCH_SIZE}
            )
            RETURNING 1 AS purged
          `);
        }
        // Keep only what the pruner keeps for any stream: replay still delivers the deletion.
        yield* drain(sql`
          DELETE FROM orchestration_events
          WHERE sequence IN (
            SELECT sequence FROM orchestration_events
              INDEXED BY idx_orchestration_events_agent_stream_sequence
            WHERE application_event_version = 2
              AND aggregate_kind = 'thread'
              AND stream_id = ${threadId}
              AND event_type NOT IN ('thread.created', 'thread.deleted')
              AND NOT (
                event_type = 'run.updated' AND json_extract(payload_json, '$.status') = 'running'
              )
              AND sequence < (
                SELECT MAX(sequence) FROM orchestration_events
                WHERE application_event_version = 2
                  AND aggregate_kind = 'thread'
                  AND stream_id = ${threadId}
              )
            -- Newest first: a row borrowing its prompt goes before the anchor it borrows from.
            ORDER BY sequence DESC
            LIMIT ${PURGE_BATCH_SIZE}
          )
          RETURNING 1 AS purged
        `);
        // Settled requests can hold answers, feedback, and titles. A failed one stays as the
        // marker that keeps a deleted thread's worktree, so only its text goes.
        yield* sql`
          DELETE FROM orchestration_v2_effect_outbox
          WHERE thread_id = ${threadId} AND status IN ('succeeded', 'cancelled')
        `;
        yield* sql`
          UPDATE orchestration_v2_effect_outbox
          SET payload_json = CASE
            WHEN json_type(payload_json, '$.title') = 'text'
              THEN json_set(payload_json, '$.title', ${DELETED_THREAD_TITLE})
            ELSE json_remove(payload_json, '$.feedback', '$.answers')
          END,
            last_error = NULL
          WHERE thread_id = ${threadId} AND status = 'failed'
        `;
        // Its v1 events then go with the imported-history prune, and no import refills it.
        yield* sql`
          UPDATE orchestration_v2_legacy_imports
          SET transcript_imported_at = ${now}
          WHERE thread_id = ${threadId} AND transcript_imported_at IS NULL
        `;
        // Last, because the new title is what marks the purge as done.
        yield* sql`
          UPDATE projection_threads SET title = ${DELETED_THREAD_TITLE} WHERE thread_id = ${threadId}
        `;
        yield* sql`
          UPDATE orchestration_v2_projection_threads
          SET title = ${DELETED_THREAD_TITLE}, payload_json = ${tombstone}
          WHERE thread_id = ${threadId}
        `;
      }
      return purged;
    });

    const purgeDeletedThread: ProjectionMaintenanceV2Shape["purgeDeletedThread"] = (threadId) =>
      purgeThreads(threadId, Effect.void).pipe(
        Effect.withSpan("ProjectionMaintenance.purgeDeletedThread"),
        Effect.mapError(
          (cause) => new ProjectionMaintenanceError({ operation: "purge deleted thread", cause }),
        ),
      );

    // A pass prunes through the mark the previous pass left once that mark is a day old, so
    // at least RETAINED_EVENT_HISTORY of events always remains. Receipts stay for idempotency.
    const pruneEventStore = Effect.fn("ProjectionMaintenance.pruneEventStore")(
      function* (betweenPages: Effect.Effect<void> = Effect.void) {
        const now = yield* DateTime.now;
        const metadata = yield* sql<MetadataRow>`
          SELECT projection_name, last_sequence, updated_at
          FROM orchestration_v2_projection_metadata
          WHERE projection_name IN (
            'thread-projections', ${EVENT_LOG_PRUNE_MARK}, ${EVENT_LOG_PRUNED_THROUGH}
          )
        `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
        const read = (name: string) => metadata.find((row) => row.projection_name === name);
        const projected = read("thread-projections")?.last_sequence ?? 0;
        const mark = read(EVENT_LOG_PRUNE_MARK);
        const prunedThrough = read(EVENT_LOG_PRUNED_THROUGH)?.last_sequence ?? 0;
        // Fixed bounds: foreground commits during the pass wait for the next one.
        const bounds = yield* sql<{ readonly sequence: number; readonly receipt_row_id: number }>`
          SELECT
            COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) AS sequence,
            COALESCE((SELECT MAX(rowid) FROM orchestration_command_receipts), 0) AS receipt_row_id
        `.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground);
        const head = bounds[0]?.sequence ?? 0;

        let deletedEventCount = 0;
        const markIsDue =
          mark !== undefined &&
          DateTime.toEpochMillis(now) - Date.parse(mark.updated_at) >=
            Duration.toMillis(RETAINED_EVENT_HISTORY);
        if (mark !== undefined && markIsDue) {
          const throughSequence = Math.max(Math.min(mark.last_sequence, projected), prunedThrough);
          if (throughSequence > prunedThrough) {
            // Publish the boundary first so resuming clients take a snapshot, never a partial replay.
            yield* writeMetadata(EVENT_LOG_PRUNED_THROUGH, throughSequence, now);
          }
          deletedEventCount += yield* pruneEvents(throughSequence, head, betweenPages);
        }
        if (mark === undefined || markIsDue) yield* writeMetadata(EVENT_LOG_PRUNE_MARK, head, now);

        // Catches threads deleted before purging existed, and any purge a crash interrupted.
        // It runs first so the legacy prune below takes the v1 events of threads it marks.
        const purgedRowCount = yield* purgeThreads(undefined, betweenPages);

        const legacy = yield* pruneImportedLegacyHistory(
          head,
          bounds[0]?.receipt_row_id ?? 0,
          betweenPages,
        );
        deletedEventCount += legacy.deletedEventCount;

        const freelistRows = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
        const pageSizeRows = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
        const reclaimableBytes =
          (freelistRows[0]?.freelist_count ?? 0) * (pageSizeRows[0]?.page_size ?? 0);

        return {
          deletedEventCount,
          deletedReceiptCount: legacy.deletedReceiptCount,
          purgedRowCount,
          reclaimableBytes,
        };
      },
      Effect.mapError(
        (cause) => new ProjectionMaintenanceError({ operation: "prune event store", cause }),
      ),
    );

    const mapError =
      (operation: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.mapError((cause) => new ProjectionMaintenanceError({ operation, cause })),
        );

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
    const familyIsCold = (threadId: string, rootThreadId: string, idleBefore: string) =>
      sql<{ readonly cold: number }>`
        WITH RECURSIVE ${referencedSources}
        SELECT (
          EXISTS (
            SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${rootThreadId}
          )
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_v2_projection_threads AS member
            -- Migration 89's root_thread_idx key: the same expression, or SQLite scans every chat.
            WHERE CASE WHEN json_valid(member.payload_json)
              THEN json_extract(member.payload_json, '$.lineage.rootThreadId') END = ${rootThreadId}
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
          AND NOT EXISTS (SELECT 1 FROM referenced_sources WHERE thread_id = ${threadId})
        ) AS cold
      `.pipe(Effect.map((rows) => rows[0]?.cold === 1));

    // Pacing leaves time for the family to reopen, so every write checks it again inside its
    // transaction, which the single writer serializes with every other write.
    const whileFamilyCold =
      (threadId: string, rootThreadId: string, idleBefore: string) =>
      <A, E, R>(write: Effect.Effect<A, E, R>) =>
        sql.withTransaction(
          Effect.flatMap(familyIsCold(threadId, rootThreadId, idleBefore), (isCold) =>
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
      const whileCold = whileFamilyCold(input.threadId, input.rootThreadId, input.idleBefore);
      if (
        !(yield* familyIsCold(input.threadId, input.rootThreadId, input.idleBefore).pipe(
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
          LIMIT ${PAGE_SIZE}
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
        if (last === undefined || items.length < PAGE_SIZE) break;
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
          LIMIT ${PAGE_SIZE}
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
        if (last === undefined || events.length < PAGE_SIZE) break;
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
              LIMIT ${PAGE_SIZE}
            )
            SELECT
              page.thread_id,
              page.updated_at,
              CASE WHEN json_valid(page.payload_json)
                THEN json_extract(page.payload_json, '$.lineage.rootThreadId') END AS root_thread_id,
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
          if (last === undefined || threads.length < PAGE_SIZE) break;
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
      const whileCold = whileFamilyCold(input.threadId, input.rootThreadId, input.idleBefore);
      if (
        !(yield* familyIsCold(input.threadId, input.rootThreadId, input.idleBefore).pipe(
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
          LIMIT ${PAGE_SIZE}
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
        if (last === undefined || rows.length < PAGE_SIZE) break;
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
              LIMIT ${PAGE_SIZE}
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
          if (last === undefined || threads.length < PAGE_SIZE) break;
          threadCursor = last.thread_id;
          yield* betweenPages;
        }

        return { threadCount, deletedEventCount };
      },
      mapError("compact cold thread history"),
    );

    return ProjectionMaintenanceV2.of({
      pruneColdThreadToolOutput,
      pruneEventStore,
      purgeDeletedThread,
      compactColdThreadHistory,
    });
  }),
);
