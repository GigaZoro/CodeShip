import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
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

it.effect(
  "a reused bearer retains only the demand common to all its turns and freezes each request",
  () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(() => 1_000);
      const issue = registry.issue({
        threadId: ThreadId.make("thread:several-turns"),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      const tokenOf = (credential: McpSessionRegistry.McpIssuedCredential) =>
        credential.config.authorizationHeader.replace(/^Bearer\s+/, "");
      const first = yield* issue;
      const token = tokenOf(first);
      const credentialId = first.config.providerSessionId;
      const demand = `demand:${"a".repeat(64)}`;
      const other = `demand:${"b".repeat(64)}`;
      const before = yield* registry.resolve(token);
      expect(before?.thread.demandId).toBeUndefined();
      yield* registry.bindTurn(credentialId, demand, RunId.make("run:one"));
      const admitted = yield* registry.resolve(token);
      yield* registry.bindTurn(credentialId, demand, RunId.make("run:one"));
      yield* registry.bindTurn(credentialId, demand, RunId.make("run:one-followup"));
      const admittedFollowup = yield* registry.resolve(token);
      expect(admittedFollowup?.thread.demandId).toBe(demand);
      expect(admittedFollowup?.thread.runId).toBe("run:one-followup");
      yield* registry.bindTurn(credentialId, other, RunId.make("run:two"));
      yield* registry.bindTurn(credentialId, other, RunId.make("run:two"));
      expect((yield* registry.resolve(token))?.thread.demandId).toBeNull();
      expect(admitted?.thread.demandId).toBe(demand);
      expect(admitted?.thread.runId).toBe("run:one");
      expect(admittedFollowup?.thread.runId).toBe("run:one-followup");
      expect((yield* registry.resolve(token))?.thread.runId).toBe("run:two");
      expect(before?.thread.demandId).toBeUndefined();

      const replacement = yield* issue;
      yield* registry.revokeProviderSession(credentialId);
      yield* registry.bindTurn(credentialId, other, RunId.make("run:two"));
      expect((yield* registry.resolve(tokenOf(replacement)))?.thread.demandId).toBeUndefined();
      yield* registry.bindTurn(replacement.config.providerSessionId, null, RunId.make("run:three"));
      yield* registry.bindTurn(replacement.config.providerSessionId, demand, RunId.make("run:one"));
      expect((yield* registry.resolve(tokenOf(replacement)))?.thread.demandId).toBeNull();
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
