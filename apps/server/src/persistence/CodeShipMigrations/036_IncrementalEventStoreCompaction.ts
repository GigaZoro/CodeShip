import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The global compaction pass classifies only events past the stored mark. A chat keeps a few
// thread-state events below it, which the pass reads through the partial index when the chat
// gains newer ones. The type list matches THREAD_STATE_EVENT_TYPES in ProjectionMaintenance.ts:
// the pass names this index, so a list that drifts fails there until a migration rebuilds it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_event_store_compaction (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      compacted_through_sequence INTEGER NOT NULL
    )
  `;
  // No application_event_version term: that column is stored after payload_json, so testing it
  // would make this build read every event's payload. The pass filters the version itself.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_events_v2_thread_state_idx
    ON orchestration_events(stream_id)
    WHERE aggregate_kind = 'thread'
      AND event_type IN (
        'thread.archived',
        'thread.unarchived',
        'thread.settled',
        'thread.unsettled',
        'thread.snoozed',
        'thread.unsnoozed',
        'thread.pinned',
        'thread.auto-settle-set',
        'thread.later-set',
        'thread.unpinned',
        'thread.pin-reordered',
        'thread.active-reordered',
        'thread.metadata-updated',
        'thread.pull-request-synced',
        'thread.runtime-mode-updated',
        'thread.interaction-mode-updated',
        'thread.model-selection-updated',
        'thread.provider-switched',
        'thread.guest-share-updated',
        'thread.visited',
        'thread.marked-unread',
        'thread.tags-updated',
        'thread.folder-updated',
        'thread.notification-level-updated',
        'thread.color-updated',
        'thread.pull-request-link-updated'
      )
  `;
  // Set once the pass has deleted the imported chat's v1 events and legacy receipts.
  yield* sql`
    ALTER TABLE orchestration_v2_legacy_imports ADD COLUMN legacy_rows_compacted_at TEXT
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_legacy_imports_pending_compaction_idx
    ON orchestration_v2_legacy_imports(thread_id)
    WHERE transcript_imported_at IS NOT NULL AND legacy_rows_compacted_at IS NULL
  `;
});
