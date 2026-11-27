import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Detached provider brokers (`__session-host`) outlive planned server updates so a restarting
  // server can verify process identity, reattach over local IPC, and replay buffered frames.
  // The broker's auth token is kept in the server secret store, never in this table.
  yield* sql`
    CREATE TABLE session_hosts (
      id TEXT PRIMARY KEY,
      provider_session_id TEXT NOT NULL,
      provider_thread_id TEXT,
      thread_id TEXT NOT NULL,
      thread_ids_json TEXT NOT NULL DEFAULT '[]',
      driver TEXT NOT NULL,
      socket_path TEXT NOT NULL,
      broker_pid INTEGER,
      broker_identity_json TEXT,
      child_pid INTEGER,
      last_acked_seq INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX session_hosts_status ON session_hosts (status)
  `;
  yield* sql`
    CREATE INDEX session_hosts_thread_id ON session_hosts (thread_id)
  `;
  yield* sql`
    CREATE INDEX session_hosts_provider_session_id ON session_hosts (provider_session_id)
  `;

  // Persist hashed provider MCP credentials so surviving provider processes stay authorized on
  // `/mcp` after a planned server restart without storing raw bearer tokens on disk.
  yield* sql`
    CREATE TABLE mcp_session_credentials (
      token_hash TEXT PRIMARY KEY,
      provider_session_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      request_namespace TEXT NOT NULL,
      subagent INTEGER NOT NULL DEFAULT 0,
      capabilities_json TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      last_alive_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX mcp_session_credentials_thread_id ON mcp_session_credentials (thread_id)
  `;
  yield* sql`
    CREATE INDEX mcp_session_credentials_provider_session_id ON mcp_session_credentials (provider_session_id)
  `;
});
