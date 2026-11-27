import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  /** False omits the preview capability wherever the token is honored. Defaults to full access. */
  readonly browserToolsAvailable?: boolean;
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
  readonly subagent?: boolean;
  /** Issues a credential that grants nothing but this assignment's `read_material`. */
  readonly reviewAssignment?: McpProviderSession.ReviewAssignmentSession;
}

export const REVIEW_ASSIGNMENT_MCP_PATH = "/mcp/review-assignment";

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
}

/** What a provider process taken over after a planned update can still use of its MCP access. */
export type RestoredMcpCredential =
  | { readonly _tag: "None" }
  | { readonly _tag: "Usable"; readonly mcpCredentialId: string }
  | { readonly _tag: "Unusable"; readonly reason: string };

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  /** The credential a thread held before the restart; its process kept the raw token. */
  readonly restoredCredentialForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<RestoredMcpCredential>;
  /**
   * Restored credentials authorize nothing until this runs. It keeps the usable ones of kept
   * threads (same endpoint, not expired) and deletes the rest, from memory and SQLite.
   */
  readonly pruneRestored: (keepThreadIds: ReadonlySet<ThreadId>) => Effect.Effect<void>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpThreadInvocationScope | undefined>;
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpThreadInvocationScope;
  readonly lastAliveAt: number;
}

interface QuarantinedCredential extends CredentialRecord {
  /** The endpoint its process was told to call. */
  readonly endpoint: string;
}

interface PersistedCredentialRow {
  readonly token_hash: string;
  readonly provider_session_id: string;
  readonly thread_id: string;
  readonly provider_instance_id: string;
  readonly environment_id: string;
  readonly request_namespace: string;
  readonly subagent: number;
  readonly capabilities_json: string;
  readonly endpoint: string;
  readonly issued_at: number;
  readonly last_alive_at: number;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  readonly now?: () => number;
}

/**
 * `/mcp` is outside environment auth, so idle tokens stop authenticating.
 * Keep expired records until explicit revocation: a trusted provider turn can
 * refresh the token its subprocess still holds; MCP requests cannot.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const getHttpMcpEndpointHost = (address: NetAddress.IpAddress): string =>
  NetAddress.isUnspecified(address)
    ? "127.0.0.1"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(address));

const PersistedCapabilitiesJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodePersistedCapabilitiesJson = Schema.decodeUnknownOption(PersistedCapabilitiesJson);
const encodePersistedCapabilitiesJson = Schema.encodeSync(PersistedCapabilitiesJson);

const decodePersistedCapabilities = (
  raw: string,
): ReadonlySet<McpInvocationContext.McpCapability> => {
  const parsed = decodePersistedCapabilitiesJson(raw);
  if (Option.isSome(parsed)) {
    return new Set(parsed.value as ReadonlyArray<McpInvocationContext.McpCapability>);
  }
  return new Set<McpInvocationContext.McpCapability>([
    "orchestration",
    "worktree",
    "pull-requests",
  ]);
};

// A failed write leaves SQLite out of step with memory; startup pruning removes what it left behind.
const PERSIST_FAILURE_MESSAGE = "Could not update the saved MCP credentials.";

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
  // Restored credentials authorize nothing until recovery keeps them: if startup fails before
  // pruning, a stray process from before the restart must not still reach `/mcp`.
  const quarantined = new Map<string, QuarantinedCredential>();
  let restoreFailed = false;

  if (Option.isSome(sqlOption)) {
    const sql = sqlOption.value;
    const rows = yield* sql<PersistedCredentialRow>`
      SELECT
        token_hash,
        provider_session_id,
        thread_id,
        provider_instance_id,
        environment_id,
        request_namespace,
        subagent,
        capabilities_json,
        endpoint,
        issued_at,
        last_alive_at
      FROM mcp_session_credentials
    `.pipe(
      Effect.catch((cause) =>
        Effect.logError("Could not read the MCP credentials saved before the restart.", {
          cause,
        }).pipe(
          Effect.andThen(
            Effect.sync(() => {
              restoreFailed = true;
              return [] as ReadonlyArray<PersistedCredentialRow>;
            }),
          ),
        ),
      ),
    );
    for (const row of rows) {
      quarantined.set(row.token_hash, {
        endpoint: row.endpoint,
        tokenHash: row.token_hash,
        lastAliveAt: row.last_alive_at,
        scope: {
          environmentId: EnvironmentId.make(row.environment_id),
          requestNamespace: row.request_namespace,
          thread: {
            threadId: ThreadId.make(row.thread_id),
            providerSessionId: row.provider_session_id,
            providerInstanceId: ProviderInstanceId.make(row.provider_instance_id),
            subagent: row.subagent !== 0,
          },
          client: undefined,
          capabilities: decodePersistedCapabilities(row.capabilities_json),
          issuedAt: row.issued_at,
        },
      });
    }
  }

  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const startedAtMs = yield* currentTimeMillis;
  const origin = NetAddress.isInetAddress(httpServer.address)
    ? `http://${getHttpMcpEndpointHost(httpServer.address.address)}:${httpServer.address.port}`
    : "http://127.0.0.1";
  const endpoint = `${origin}/mcp`;

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      const providerSessionId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const browserToolsAvailable = request.browserToolsAvailable ?? true;
      const reviewAssignment = request.reviewAssignment;
      const capabilities = new Set<McpInvocationContext.McpCapability>(
        reviewAssignment === undefined
          ? [
              "orchestration",
              "worktree",
              "pull-requests",
              ...(request.capabilities ?? (browserToolsAvailable ? (["preview"] as const) : [])),
            ]
          : ["review-assignment"],
      );
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId,
        requestNamespace: providerSessionId,
        thread: {
          threadId: ThreadId.make(request.threadId),
          providerSessionId,
          providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
          subagent: request.subagent === true,
        },
        client: undefined,
        capabilities,
        issuedAt,
        ...(reviewAssignment === undefined
          ? {}
          : { assignment: { handle: reviewAssignment.handle } }),
      };
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(records);
        next.set(tokenHash, { tokenHash, scope, lastAliveAt: issuedAt });
        return { records: next };
      });
      // A restore does not rebuild a review's assignment, and restricted reviews never outlive an update.
      if (Option.isSome(sqlOption) && reviewAssignment === undefined) {
        const sql = sqlOption.value;
        const capabilitiesJson = encodePersistedCapabilitiesJson([...capabilities]);
        yield* sql`
          INSERT OR REPLACE INTO mcp_session_credentials (
            token_hash,
            provider_session_id,
            thread_id,
            provider_instance_id,
            environment_id,
            request_namespace,
            subagent,
            capabilities_json,
            endpoint,
            issued_at,
            last_alive_at
          ) VALUES (
            ${tokenHash},
            ${providerSessionId},
            ${scope.thread.threadId},
            ${scope.thread.providerInstanceId},
            ${environmentId},
            ${scope.requestNamespace},
            ${scope.thread.subagent ? 1 : 0},
            ${capabilitiesJson},
            ${endpoint},
            ${issuedAt},
            ${issuedAt}
          )
        `.pipe(Effect.asVoid, Effect.ignore({ log: "Error", message: PERSIST_FAILURE_MESSAGE }));
      }
      return {
        config: {
          environmentId,
          threadId: scope.thread.threadId,
          providerSessionId,
          providerInstanceId: scope.thread.providerInstanceId,
          endpoint:
            reviewAssignment === undefined ? endpoint : `${origin}${REVIEW_ASSIGNMENT_MCP_PATH}`,
          authorizationHeader: `Bearer ${rawToken}`,
          browserToolsAvailable: scope.capabilities.has("preview"),
          capabilities: scope.capabilities,
          ...(reviewAssignment === undefined ? {} : { reviewAssignment }),
        },
      };
    },
  );

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const timestamp = yield* currentTimeMillis;
      const record = (yield* SynchronizedRef.get(state)).records.get(tokenHash);
      if (!record || timestamp - record.lastAliveAt > livenessWindowMs) return undefined;
      return record.scope;
    },
  );

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const timestamp = yield* currentTimeMillis;
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(records);
        for (const [tokenHash, record] of records) {
          if (record.scope.thread.threadId === threadId) {
            next.set(tokenHash, { ...record, lastAliveAt: timestamp });
          }
        }
        return { records: next };
      });
      if (Option.isSome(sqlOption)) {
        const sql = sqlOption.value;
        yield* sql`
          UPDATE mcp_session_credentials
          SET last_alive_at = ${timestamp}
          WHERE thread_id = ${threadId}
        `.pipe(Effect.asVoid, Effect.ignore({ log: "Error", message: PERSIST_FAILURE_MESSAGE }));
      }
    },
  );

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    Effect.sync(() => {
      for (const [tokenHash, record] of quarantined) {
        if (predicate(record)) quarantined.delete(tokenHash);
      }
    }).pipe(
      Effect.andThen(
        SynchronizedRef.update(state, ({ records }) => ({
          records: new Map(Array.from(records).filter(([, record]) => !predicate(record))),
        })),
      ),
    );

  const restoredCredentialForThread: McpSessionRegistryShape["restoredCredentialForThread"] =
    Effect.fn("McpSessionRegistry.restoredCredentialForThread")(function* (threadId) {
      if (restoreFailed) {
        return {
          _tag: "Unusable",
          reason: "The MCP credentials saved before the restart could not be read.",
        } as const;
      }
      const now = yield* currentTimeMillis;
      const restored = Array.from(quarantined.values()).filter(
        (record) => record.scope.thread.threadId === threadId,
      );
      if (restored.length === 0) return { _tag: "None" } as const;
      const movedFrom = restored
        .map((record) => record.endpoint)
        .find((previous) => previous !== endpoint);
      // The process keeps calling the URL it was given; a server on another port cannot answer it.
      if (movedFrom !== undefined) {
        return {
          _tag: "Unusable",
          reason: `The MCP endpoint moved from ${movedFrom} to ${endpoint}.`,
        } as const;
      }
      const usable = restored.find((record) => now - record.lastAliveAt <= livenessWindowMs);
      return usable === undefined
        ? ({ _tag: "Unusable", reason: "The saved MCP credential has expired." } as const)
        : ({ _tag: "Usable", mcpCredentialId: usable.scope.thread.providerSessionId } as const);
    });

  const pruneRestored: McpSessionRegistryShape["pruneRestored"] = Effect.fn(
    "McpSessionRegistry.pruneRestored",
  )(function* (keepThreadIds) {
    const now = yield* currentTimeMillis;
    const kept: Array<CredentialRecord> = [];
    const removed: Array<string> = [];
    for (const { endpoint: restoredEndpoint, ...record } of quarantined.values()) {
      // Only a credential the kept process can still use survives: same endpoint, not expired.
      if (
        keepThreadIds.has(record.scope.thread.threadId) &&
        restoredEndpoint === endpoint &&
        now - record.lastAliveAt <= livenessWindowMs
      ) {
        kept.push(record);
      } else {
        removed.push(record.tokenHash);
      }
    }
    quarantined.clear();
    yield* SynchronizedRef.update(state, ({ records }) => {
      const next = new Map(records);
      for (const record of kept) next.set(record.tokenHash, record);
      return { records: next };
    });
    if (Option.isNone(sqlOption)) return;
    const sql = sqlOption.value;
    // Rows that could not be read were never restored; only ones issued since startup are kept.
    const deletion = restoreFailed
      ? sql`DELETE FROM mcp_session_credentials WHERE issued_at < ${startedAtMs}`
      : Effect.forEach(
          removed,
          (tokenHash) => sql`DELETE FROM mcp_session_credentials WHERE token_hash = ${tokenHash}`,
          { discard: true },
        );
    yield* deletion.pipe(
      Effect.asVoid,
      Effect.ignore({ log: "Error", message: PERSIST_FAILURE_MESSAGE }),
    );
  });

  return McpSessionRegistry.of({
    issue,
    resolve,
    touch,
    restoredCredentialForThread,
    pruneRestored,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => record.scope.thread.providerSessionId === providerSessionId);
        if (Option.isSome(sqlOption)) {
          const sql = sqlOption.value;
          yield* sql`
            DELETE FROM mcp_session_credentials
            WHERE provider_session_id = ${providerSessionId}
          `.pipe(Effect.asVoid, Effect.ignore({ log: "Error", message: PERSIST_FAILURE_MESSAGE }));
        }
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.scope.thread.threadId === threadId);
      if (Option.isSome(sqlOption)) {
        const sql = sqlOption.value;
        yield* sql`
          DELETE FROM mcp_session_credentials
          WHERE thread_id = ${threadId}
        `.pipe(Effect.asVoid, Effect.ignore({ log: "Error", message: PERSIST_FAILURE_MESSAGE }));
      }
    }),
    revokeAll: Effect.gen(function* () {
      quarantined.clear();
      yield* SynchronizedRef.set(state, { records: new Map() });
      if (Option.isSome(sqlOption)) {
        const sql = sqlOption.value;
        yield* sql`DELETE FROM mcp_session_credentials`.pipe(
          Effect.asVoid,
          Effect.ignore({ log: "Error", message: PERSIST_FAILURE_MESSAGE }),
        );
      }
    }),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

export const __testing = {
  make: makeWithOptions,
};
