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
export function nodePayloadSql(alias?: string): string {
  const prefix = alias === undefined ? "" : `${alias}.`;
  const sets = NODE_PAYLOAD_COLUMNS.map(([key, column]) => `'$.${key}', ${prefix}${column}`);
  return `json_set(${prefix}payload_json, ${sets.join(", ")})`;
}
