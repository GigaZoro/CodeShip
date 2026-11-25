import { OrchestrationV2TurnItemJson, type OrchestrationV2TurnItem } from "@t3tools/contracts";
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

export interface ProjectionMaintenanceV2Shape {
  /** Deletes events the projections already cover once they are older than the retained history. */
  readonly pruneEventStore: (betweenPages?: Effect.Effect<void>) => Effect.Effect<
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
    const familyIsCold = (rootThreadId: string, idleBefore: string) =>
      sql<{ readonly cold: number }>`
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
        ) AS cold
      `.pipe(Effect.map((rows) => rows[0]?.cold === 1));

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
      const cold = familyIsCold(input.rootThreadId, input.idleBefore);
      // Pacing leaves time for the family to reopen, so every write checks it again inside its
      // transaction, which the single writer serializes with every other write.
      const whileCold = <A, E, R>(write: Effect.Effect<A, E, R>) =>
        sql.withTransaction(
          Effect.flatMap(cold, (isCold) => (isCold ? Effect.asSome(write) : Effect.succeedNone)),
        );
      if (!(yield* cold.pipe(NodeSqliteClient.readOnly, NodeSqliteClient.inBackground)))
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

    return ProjectionMaintenanceV2.of({
      pruneColdThreadToolOutput,
      pruneEventStore,
    });
  }),
);
