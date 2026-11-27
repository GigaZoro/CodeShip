// A node's payload keys that its row's columns already hold. They are left out of payload_json
// and put back by `nodePayloadSql` on read: about 800 of its 1.3 KB repeated them.
const NODE_PAYLOAD_COLUMNS = [
  ["id", "node_id"],
  ["threadId", "thread_id"],
  ["runId", "run_id"],
  ["parentNodeId", "parent_node_id"],
  ["rootNodeId", "root_node_id"],
  ["kind", "kind"],
  ["status", "status"],
  ["providerThreadId", "provider_thread_id"],
  ["providerTurnId", "provider_turn_id"],
  ["startedAt", "started_at"],
  ["completedAt", "completed_at"],
] as const;

export function stripNodePayloadColumns(payload: Record<string, unknown>): string {
  const rest = { ...payload };
  for (const [key] of NODE_PAYLOAD_COLUMNS) delete rest[key];
  return JSON.stringify(rest);
}

// json_set with a NULL column writes JSON null, which the node schema's NullOr keys decode.
// Fall back to splicing json_object(...) when payload_json exceeds SQLite's JSON nesting limit.
export function nodePayloadSql(alias?: string): string {
  const prefix = alias === undefined ? "" : `${alias}.`;
  const sets = NODE_PAYLOAD_COLUMNS.map(([key, column]) => `'$.${key}', ${prefix}${column}`);
  const cols = NODE_PAYLOAD_COLUMNS.map(([key, column]) => `'${key}', ${prefix}${column}`);
  const trimmed = `rtrim(${prefix}payload_json)`;
  const fallback = `CASE WHEN ${trimmed} = '{}' THEN json_object(${cols.join(", ")}) WHEN substr(${trimmed}, -1) = '}' THEN substr(${trimmed}, 1, length(${trimmed}) - 1) || ',' || substr(json_object(${cols.join(", ")}), 2) ELSE ${prefix}payload_json END`;
  return `CASE WHEN json_valid(${prefix}payload_json) THEN json_set(${prefix}payload_json, ${sets.join(", ")}) ELSE ${fallback} END`;
}
