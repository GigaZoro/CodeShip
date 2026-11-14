import {
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

export interface ProjectionMaintenanceV2Shape {
  readonly verify: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  readonly rebuild: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  readonly compactEventStore: (betweenPages?: Effect.Effect<void>) => Effect.Effect<
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
    // Older clients skip tag events, so these supersede only each other.
    const TAG_THREAD_EVENT_TYPE = "thread.tags-updated";

    const supersedableThreadEventTypes = new Set(SUPERSEDABLE_THREAD_EVENT_TYPES);
    const readStateThreadEventTypes = new Set(READ_STATE_THREAD_EVENT_TYPES);
    // Subagent snapshots stay intact because later rows can reference an earlier prompt.
    // Commanded turn items stay for command-result replay.
    // Small pages bound work on the reader worker and synchronous fallback.
    const COMPACTION_PAGE_SIZE = 50;

    // Keep first/latest keyed events for replay order; page every event to bound sparse scans.
    const compactEventStore = Effect.fn("ProjectionMaintenance.compactEventStore")(function* (
      betweenPages: Effect.Effect<void> = Effect.void,
    ) {
      const bounds = yield* sql<{
        readonly event_sequence: number;
        readonly receipt_row_id: number;
      }>`
        SELECT
          COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) AS event_sequence,
          COALESCE((SELECT MAX(rowid) FROM orchestration_command_receipts), 0) AS receipt_row_id
      `.pipe(NodeSqliteClient.readOnly);
      let throughSequence = bounds[0]?.event_sequence ?? 0;
      let throughReceiptRowId = bounds[0]?.receipt_row_id ?? 0;
      const retainedThreadIds = new Set<string>();
      const retainedReadStateThreadIds = new Set<string>();
      const retainedTagThreadIds = new Set<string>();
      // Retain each key's oldest candidate, deleting it only when an older event appears.
      const oldestCandidateByEntityKey = new Map<string, number | null>();
      let deletedEventCount = 0;
      let deletedReceiptCount = 0;

      while (throughSequence > 0) {
        const rows = yield* sql<{
          readonly sequence: number;
          readonly application_event_version: number;
          readonly aggregate_kind: string;
          readonly stream_id: string;
          readonly event_type: string;
          readonly entity_id: string | null;
          readonly imported_legacy_thread: number;
        }>`
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
              THEN json_array(json_extract(event.payload_json, '$.host'),
                json_extract(event.payload_json, '$.repository'),
                json_extract(event.payload_json, '$.number'))
              ELSE NULL
            END AS entity_id,
            CASE
              WHEN event.application_event_version = 1 AND event.aggregate_kind = 'thread'
              THEN EXISTS (
                SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
                WHERE legacy_import.thread_id = event.stream_id
                  AND legacy_import.transcript_imported_at IS NOT NULL
              )
              ELSE 0
            END AS imported_legacy_thread
          FROM orchestration_events AS event
          WHERE event.sequence <= ${throughSequence}
          ORDER BY event.sequence DESC
          LIMIT ${COMPACTION_PAGE_SIZE + 1}
        `.pipe(NodeSqliteClient.readOnly);
        const page = rows.slice(0, COMPACTION_PAGE_SIZE);
        const obsolete: number[] = [];
        for (const row of page) {
          if (row.imported_legacy_thread === 1) {
            obsolete.push(row.sequence);
          } else if (row.application_event_version === 2) {
            if (
              row.aggregate_kind === "thread" &&
              supersedableThreadEventTypes.has(row.event_type)
            ) {
              if (retainedThreadIds.has(row.stream_id)) obsolete.push(row.sequence);
              else retainedThreadIds.add(row.stream_id);
            } else if (
              row.aggregate_kind === "thread" &&
              readStateThreadEventTypes.has(row.event_type)
            ) {
              if (
                retainedThreadIds.has(row.stream_id) ||
                retainedReadStateThreadIds.has(row.stream_id)
              ) {
                obsolete.push(row.sequence);
              } else retainedReadStateThreadIds.add(row.stream_id);
            } else if (
              row.aggregate_kind === "thread" &&
              row.event_type === TAG_THREAD_EVENT_TYPE
            ) {
              if (retainedThreadIds.has(row.stream_id) || retainedTagThreadIds.has(row.stream_id)) {
                obsolete.push(row.sequence);
              } else retainedTagThreadIds.add(row.stream_id);
            } else if (
              row.event_type === "thread.pull-request-link-updated" &&
              retainedThreadIds.has(row.stream_id)
            ) {
              // A newer whole-thread payload already carries this link's state.
              obsolete.push(row.sequence);
            } else if (
              row.event_type === "thread.pull-request-link-updated" ||
              row.event_type === "message.updated" ||
              row.event_type === "node.updated" ||
              (row.event_type === "turn-item.updated" && row.entity_id !== null)
            ) {
              const key = encodeEntityKey([row.event_type, row.stream_id, row.entity_id]);
              const candidate = oldestCandidateByEntityKey.get(key);
              if (candidate === undefined) oldestCandidateByEntityKey.set(key, null);
              else {
                if (candidate !== null) obsolete.push(candidate);
                oldestCandidateByEntityKey.set(key, row.sequence);
              }
            }
          }
        }
        // Never hold a transaction or the reader lock across a yield or a rest.
        yield* Effect.yieldNow;
        if (obsolete.length > 0) {
          yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(obsolete)}`;
          deletedEventCount += obsolete.length;
          yield* Effect.yieldNow;
        }
        throughSequence =
          rows.length <= COMPACTION_PAGE_SIZE ? 0 : (page.at(-1)?.sequence ?? 1) - 1;
        if (throughSequence > 0 || throughReceiptRowId > 0) yield* betweenPages;
      }

      while (throughReceiptRowId > 0) {
        const rows = yield* sql<{
          readonly row_id: number;
          readonly command_id: string;
          readonly imported_legacy_thread: number;
        }>`
          SELECT
            receipt.rowid AS row_id,
            receipt.command_id,
            CASE
              WHEN receipt.command_type = 'legacy' AND receipt.aggregate_kind = 'thread'
              THEN EXISTS (
                SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
                WHERE legacy_import.thread_id = receipt.aggregate_id
                  AND legacy_import.transcript_imported_at IS NOT NULL
              )
              ELSE 0
            END AS imported_legacy_thread
          FROM orchestration_command_receipts AS receipt
          WHERE receipt.rowid <= ${throughReceiptRowId}
          ORDER BY receipt.rowid DESC
          LIMIT ${COMPACTION_PAGE_SIZE + 1}
        `.pipe(NodeSqliteClient.readOnly);
        const page = rows.slice(0, COMPACTION_PAGE_SIZE);
        const obsolete = page
          .filter((row) => row.imported_legacy_thread === 1)
          .map((row) => row.command_id);
        yield* Effect.yieldNow;
        if (obsolete.length > 0) {
          yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id IN ${sql.in(obsolete)}`;
          deletedReceiptCount += obsolete.length;
          yield* Effect.yieldNow;
        }
        throughReceiptRowId = (page.at(-1)?.row_id ?? 1) - 1;
        if (rows.length <= COMPACTION_PAGE_SIZE) break;
        yield* betweenPages;
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
      if (!(yield* cold.pipe(NodeSqliteClient.readOnly))) return done(false);
      // Events appended after this read belong to new activity and stay as written.
      const [stream] = yield* sql<{ readonly last_sequence: number | null }>`
        SELECT MAX(sequence) AS last_sequence
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}
      `.pipe(NodeSqliteClient.readOnly);
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
              THEN payload_json
            END AS payload_json
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${input.threadId}
            AND (ordinal, turn_item_id) > (${ordinalCursor}, ${itemCursor})
          ORDER BY ordinal, turn_item_id
          LIMIT ${COMPACTION_PAGE_SIZE}
        `.pipe(NodeSqliteClient.readOnly);
        const updates: Array<{
          readonly row: (typeof items)[number];
          readonly json: string;
        }> = [];
        for (const row of items) {
          if (row.payload_json === null) continue;
          const pruned = yield* prunedItemPayload(row.payload_json);
          if (pruned === undefined) unreadableItemCount += 1;
          // A pass that stopped before rewriting the events left this row pruned.
          else if (pruned === row.payload_json) prunedItemIds.add(row.turn_item_id);
          else if (pruned !== null) updates.push({ row, json: pruned });
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
        `.pipe(NodeSqliteClient.readOnly);
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
          `.pipe(NodeSqliteClient.readOnly);
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
          `.pipe(NodeSqliteClient.readOnly);

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

    return ProjectionMaintenanceV2.of({
      verify: mapError("verify")(verify),
      rebuild: mapError("rebuild")(rebuild),
      compactEventStore,
      pruneColdThreadToolOutput,
    });
  }),
);
