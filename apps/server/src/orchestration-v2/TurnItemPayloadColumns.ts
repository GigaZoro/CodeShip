// A turn item's payload keys that its row's columns already hold. They are left out of payload_json
// and put back by `turnItemPayloadSql` on read.
const TURN_ITEM_PAYLOAD_COLUMNS = [
  ["id", "turn_item_id"],
  ["threadId", "thread_id"],
  ["runId", "run_id"],
  ["nodeId", "node_id"],
  ["providerThreadId", "provider_thread_id"],
  ["providerTurnId", "provider_turn_id"],
  ["parentItemId", "parent_item_id"],
  ["ordinal", "ordinal"],
  ["type", "type"],
  ["status", "status"],
  ["updatedAt", "updated_at"],
] as const;

export const TURN_ITEM_PAYLOAD_COLUMN_KEYS: ReadonlyArray<string> = TURN_ITEM_PAYLOAD_COLUMNS.map(
  ([key]) => key,
);

export function stripTurnItemPayloadColumns(payload: Record<string, unknown> | string): string {
  const rest = {
    ...(typeof payload === "string" ? (JSON.parse(payload) as Record<string, unknown>) : payload),
  };
  for (const key of TURN_ITEM_PAYLOAD_COLUMN_KEYS) delete rest[key];
  return JSON.stringify(rest);
}

// json_set with a NULL column writes JSON null, which the item schema's NullOr keys decode.
// Fall back to splicing json_object(...) when payload_json exceeds SQLite's JSON nesting limit.
export function turnItemPayloadSql(alias?: string): string {
  const prefix = alias === undefined ? "" : `${alias}.`;
  const sets = TURN_ITEM_PAYLOAD_COLUMNS.map(([key, column]) => `'$.${key}', ${prefix}${column}`);
  const cols = TURN_ITEM_PAYLOAD_COLUMNS.map(([key, column]) => `'${key}', ${prefix}${column}`);
  const trimmed = `rtrim(${prefix}payload_json)`;
  const fallback = `CASE WHEN ${trimmed} = '{}' THEN json_object(${cols.join(", ")}) WHEN substr(${trimmed}, -1) = '}' THEN substr(${trimmed}, 1, length(${trimmed}) - 1) || ',' || substr(json_object(${cols.join(", ")}), 2) ELSE ${prefix}payload_json END`;
  return `CASE WHEN json_valid(${prefix}payload_json) THEN json_set(${prefix}payload_json, ${sets.join(", ")}) ELSE ${fallback} END`;
}

// Strips inside SQLite, so a streamed item's payload is not parsed again in JavaScript on every write.
export const TURN_ITEM_PAYLOAD_REMOVE_PATHS: string = TURN_ITEM_PAYLOAD_COLUMN_KEYS.map(
  (key) => `'$.${key}'`,
).join(", ");
