import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: NetAddress.inetAddressFromIpStringUnsafe(hostname, port),
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now?: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      ...(now === undefined ? {} : { now }),
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.thread.threadId).toBe(threadId);
    expect(resolved?.capabilities).toEqual(
      new Set(["preview", "orchestration", "worktree", "pull-requests"]),
    );

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("always grants pull-requests and gates browser and device access independently", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const withPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const withoutPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-no-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(),
    });
    const withDevice = yield* registry.issue({
      threadId: ThreadId.make("thread-device"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["device"]),
    });
    const capabilitiesOf = (issued: typeof withPreview) =>
      registry
        .resolve(issued.config.authorizationHeader.replace(/^Bearer\s+/, ""))
        .pipe(Effect.map((scope) => [...(scope?.capabilities ?? [])].sort()));

    expect(yield* capabilitiesOf(withPreview)).toEqual([
      "orchestration",
      "preview",
      "pull-requests",
      "worktree",
    ]);
    expect(yield* capabilitiesOf(withoutPreview)).toEqual([
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
    expect(yield* capabilitiesOf(withDevice)).toEqual([
      "device",
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
  }),
);

// regression: #3114 use bound host for MCP endpoint
it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["::", "http://127.0.0.1:43123/mcp"],
      ["::1", "http://[::1]:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("MCP requests do not renew a token; only a trusted touch does", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry();
    const threadId = ThreadId.make("thread-polling");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    for (let step = 0; step < 3; step++) {
      yield* TestClock.adjust(50);
      yield* registry.touch(threadId);
      expect(yield* registry.resolve(token)).toBeDefined();
    }

    for (let step = 0; step < 2; step++) {
      yield* TestClock.adjust(50);
      expect(yield* registry.resolve(token)).toBeDefined();
    }
    yield* TestClock.adjust(1);
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("only a trusted touch restores an expired token with its original scope", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-idle");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const scope = yield* registry.resolve(token);
    expect(scope).toBeDefined();

    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
    const otherThreadId = ThreadId.make("thread-active");
    const other = yield* registry.issue({
      threadId: otherThreadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["device"]),
    });
    yield* registry.touch(otherThreadId);
    expect(
      (yield* registry.resolve(other.config.authorizationHeader.replace(/^Bearer\s+/, "")))?.thread
        .threadId,
    ).toBe(otherThreadId);
    expect(yield* registry.resolve("unknown-token")).toBeUndefined();
    expect(yield* registry.resolve(token)).toBeUndefined();

    yield* registry.touch(threadId);
    expect(yield* registry.resolve(token)).toEqual(scope);
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect.each(["provider-session", "thread", "all"] as const)(
  "never restores an expired token after %s revocation",
  (revocation) =>
    Effect.gen(function* () {
      let timestamp = 1_000;
      const registry = yield* makeRegistry(() => timestamp);
      const threadId = ThreadId.make("thread-revoked");
      const issued = yield* registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
      });
      const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

      timestamp += 101;
      yield* {
        "provider-session": registry.revokeProviderSession(issued.config.providerSessionId),
        thread: registry.revokeThread(threadId),
        all: registry.revokeAll,
      }[revocation];
      yield* registry.touch(threadId);
      expect(yield* registry.resolve(token)).toBeUndefined();
    }),
);

it.effect("persists only token hashes in SQLite and reloads live credentials after restart", () =>
  Effect.gen(function* () {
    let timestamp = 10_000;
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const threadId = ThreadId.make("thread-durable-restart");

    const registryBeforeRestart = yield* makeRegistry(() => timestamp);
    const issued = yield* registryBeforeRestart.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview", "device"]),
      subagent: true,
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(token));
    const expectedHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");

    const rows = yield* sql<{
      readonly token_hash: string;
      readonly provider_session_id: string;
      readonly thread_id: string;
      readonly subagent: number;
      readonly last_alive_at: number;
    }>`
      SELECT token_hash, provider_session_id, thread_id, subagent, last_alive_at
      FROM mcp_session_credentials
      WHERE provider_session_id = ${issued.config.providerSessionId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(expectedHash);
    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect(rows[0]?.subagent).toBe(1);

    // Advance clock and touch before simulated restart.
    timestamp += 80;
    yield* registryBeforeRestart.touch(threadId);

    // Simulate a server restart by constructing a brand-new registry against the same SQLite DB.
    timestamp += 50;
    const registryAfterRestart = yield* makeRegistry(() => timestamp);
    // A restored token stays unusable until recovery confirms its process was taken over.
    expect(yield* registryAfterRestart.resolve(token)).toBeUndefined();
    yield* registryAfterRestart.pruneRestored(new Set([threadId]));
    const resolved = yield* registryAfterRestart.resolve(token);
    expect(resolved?.thread.threadId).toBe(threadId);
    expect(resolved?.thread.providerSessionId).toBe(issued.config.providerSessionId);
    expect(resolved?.thread.subagent).toBe(true);
    expect(resolved?.capabilities).toEqual(
      new Set(["preview", "device", "orchestration", "worktree", "pull-requests"]),
    );

    // Revoking deletes the durable row so a subsequent restart also rejects the token.
    yield* registryAfterRestart.revokeProviderSession(issued.config.providerSessionId);
    const remaining = yield* sql`
      SELECT token_hash
      FROM mcp_session_credentials
      WHERE provider_session_id = ${issued.config.providerSessionId}
    `;
    expect(remaining).toHaveLength(0);

    const registryAfterRevoke = yield* makeRegistry(() => timestamp);
    expect(yield* registryAfterRevoke.resolve(token)).toBeUndefined();
  }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, NodeServices.layer))),
);

it.effect(
  "after a restart keeps only the credentials of threads whose process was taken over",
  () =>
    Effect.gen(function* () {
      let timestamp = 10_000;
      const sql = yield* SqlClient.SqlClient;
      const adoptedThread = ThreadId.make("thread-adopted");
      const staleThread = ThreadId.make("thread-stale");
      const before = yield* makeRegistry(() => timestamp);
      const adopted = yield* before.issue({
        threadId: adoptedThread,
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      const stale = yield* before.issue({
        threadId: staleThread,
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      const tokenOf = (issued: McpSessionRegistry.McpIssuedCredential) =>
        issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

      timestamp += 10;
      const after = yield* makeRegistry(() => timestamp);
      expect(yield* after.resolve(tokenOf(adopted))).toBeUndefined();
      expect(yield* after.resolve(tokenOf(stale))).toBeUndefined();
      expect(yield* after.restoredCredentialForThread(adoptedThread)).toEqual({
        _tag: "Usable",
        mcpCredentialId: adopted.config.providerSessionId,
      });
      const issuedAfterStart = yield* after.issue({
        threadId: ThreadId.make("thread-new"),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      yield* after.pruneRestored(new Set([adoptedThread]));

      expect((yield* after.resolve(tokenOf(adopted)))?.thread.threadId).toBe(adoptedThread);
      expect(yield* after.resolve(tokenOf(stale))).toBeUndefined();
      expect((yield* after.resolve(tokenOf(issuedAfterStart)))?.thread.threadId).toBe("thread-new");
      expect(yield* after.restoredCredentialForThread(staleThread)).toEqual({ _tag: "None" });
      const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM mcp_session_credentials ORDER BY thread_id
    `;
      expect(rows.map((row) => row.thread_id)).toEqual(["thread-adopted", "thread-new"]);
      // The next restart cannot bring the pruned credential back either.
      const later = yield* makeRegistry(() => timestamp);
      expect(yield* later.resolve(tokenOf(stale))).toBeUndefined();
    }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, NodeServices.layer))),
);

it.effect("keeps a review assignment's credential out of SQLite so no restart restores it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread-review-assignment");
    const registry = yield* makeRegistry(() => 10_000);
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      reviewAssignment: { handle: "assignment-1", cwd: "/tmp/review", attest: () => Effect.void },
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect((yield* registry.resolve(token))?.assignment?.handle).toBe("assignment-1");
    expect(
      yield* sql`SELECT token_hash FROM mcp_session_credentials WHERE thread_id = ${threadId}`,
    ).toHaveLength(0);

    const registryAfterRestart = yield* makeRegistry(() => 10_050);
    yield* registryAfterRestart.pruneRestored(new Set([threadId]));
    expect(yield* registryAfterRestart.resolve(token)).toBeUndefined();
  }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, NodeServices.layer))),
);

it.effect("refuses a restored credential once the MCP endpoint has moved", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-moved");
    const before = yield* makeRegistry(() => 10_000);
    yield* before.issue({ threadId, providerInstanceId: ProviderInstanceId.make("codex") });
    const after = yield* makeRegistry(() => 10_010, makeFakeHttpServer("127.0.0.1", 43124));
    expect(yield* after.restoredCredentialForThread(threadId)).toEqual({
      _tag: "Unusable",
      reason:
        "The MCP endpoint moved from http://127.0.0.1:43123/mcp to http://127.0.0.1:43124/mcp.",
    });
  }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, NodeServices.layer))),
);

it.effect("treats unreadable saved credentials as unusable and deletes them when pruning", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread-unreadable");
    const before = yield* makeRegistry(() => 10_000);
    yield* before.issue({ threadId, providerInstanceId: ProviderInstanceId.make("codex") });
    yield* sql`ALTER TABLE mcp_session_credentials RENAME COLUMN endpoint TO endpoint_old`;
    const after = yield* makeRegistry(() => 10_010);
    expect((yield* after.restoredCredentialForThread(threadId))._tag).toBe("Unusable");
    yield* sql`ALTER TABLE mcp_session_credentials RENAME COLUMN endpoint_old TO endpoint`;
    yield* after.pruneRestored(new Set([threadId]));
    expect(yield* sql`SELECT token_hash FROM mcp_session_credentials`).toHaveLength(0);
  }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, NodeServices.layer))),
);

it.effect("prunes a kept thread's restored credential once its endpoint moved or it expired", () =>
  Effect.gen(function* () {
    let timestamp = 10_000;
    const sql = yield* SqlClient.SqlClient;
    const movedThread = ThreadId.make("thread-moved-kept");
    const expiredThread = ThreadId.make("thread-expired-kept");
    const tokenOf = (issued: McpSessionRegistry.McpIssuedCredential) =>
      issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const before = yield* makeRegistry(() => timestamp);
    const expired = yield* before.issue({
      threadId: expiredThread,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    timestamp += 200;
    const moved = yield* before.issue({
      threadId: movedThread,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const after = yield* makeRegistry(() => timestamp, makeFakeHttpServer("127.0.0.1", 43124));
    yield* after.pruneRestored(new Set([movedThread, expiredThread]));
    expect(yield* after.resolve(tokenOf(moved))).toBeUndefined();
    expect(yield* after.resolve(tokenOf(expired))).toBeUndefined();
    expect(yield* sql`SELECT token_hash FROM mcp_session_credentials`).toHaveLength(0);
  }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, NodeServices.layer))),
);
