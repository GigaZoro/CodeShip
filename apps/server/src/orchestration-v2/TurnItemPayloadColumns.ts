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
export function turnItemPayloadSql(alias?: string): string {
  const prefix = alias === undefined ? "" : `${alias}.`;
  const sets = TURN_ITEM_PAYLOAD_COLUMNS.map(([key, column]) => `'$.${key}', ${prefix}${column}`);
  return `json_set(${prefix}payload_json, ${sets.join(", ")})`;
}

// Strips inside SQLite, so a streamed item's payload is not parsed again in JavaScript on every write.
export const TURN_ITEM_PAYLOAD_REMOVE_PATHS: string = TURN_ITEM_PAYLOAD_COLUMN_KEYS.map(
  (key) => `'$.${key}'`,
).join(", ");
