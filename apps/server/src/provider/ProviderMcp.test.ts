import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type ProviderMcpError,
  type ProviderMcpServer,
  type ProviderMcpSignInState,
} from "@t3tools/contracts";
import type { ProviderInstance, ProviderMcpManagement } from "@t3tools/provider-core/server/driver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderMcp from "./ProviderMcp.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const siblingInstanceId = ProviderInstanceId.make("claudeAgent_work");
const otherInstanceId = ProviderInstanceId.make("codex");

const server = (
  overrides: Partial<ProviderMcpServer> & Pick<ProviderMcpServer, "name" | "origin">,
): ProviderMcpServer => ({
  status: "connected",
  canSignIn: false,
  canSignOut: false,
  removable: false,
  ...overrides,
});

const makeHarness = Effect.gen(function* () {
  const listReads = yield* Ref.make(0);
  const submitted = yield* Ref.make<ReadonlyArray<string>>([]);
  const signedIn = yield* Deferred.make<void, ProviderMcpError>();
  const mcp: ProviderMcpManagement = {
    list: Ref.update(listReads, (count) => count + 1).pipe(
      Effect.as([
        server({ name: "plugin:tools:zeta", displayName: "zeta", origin: "plugin" }),
        server({ name: "codex_apps", origin: "builtIn" }),
        server({ name: "minions", origin: "config", status: "needsAuth", canSignIn: true }),
        server({ name: "alpha", origin: "config" }),
      ]),
    ),
    add: () => Effect.void,
    remove: () => Effect.void,
    signOut: () => Effect.void,
    signIn: (name) =>
      Effect.succeed({
        authorizationUrl: `https://auth.example/${name}`,
        completed: Deferred.await(signedIn),
        submitCallbackUrl: (url) => Ref.update(submitted, (urls) => [...urls, url]),
      }),
  };
  // Only the fields ProviderMcp reads; the rest of an instance is irrelevant here.
  const claudeHome = {
    driverKind: "claudeAgent",
    continuationKey: "claude:home:/Users/me/.claude",
  };
  const instances = {
    claudeAgent: {
      instanceId,
      mcp,
      continuationIdentity: claudeHome,
    } as unknown as ProviderInstance,
    claudeAgent_work: {
      instanceId: siblingInstanceId,
      mcp,
      continuationIdentity: claudeHome,
    } as unknown as ProviderInstance,
    codex: {
      instanceId: otherInstanceId,
      mcp,
      continuationIdentity: { driverKind: "codex", continuationKey: "codex:home:/Users/me/.codex" },
    } as unknown as ProviderInstance,
    cursor: { instanceId: ProviderInstanceId.make("cursor") } as unknown as ProviderInstance,
  };
  const layer = ProviderMcp.layer.pipe(
    Layer.provide(
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: (id) => Effect.succeed(instances[id as keyof typeof instances]),
        listInstances: Effect.succeed([
          instances.claudeAgent,
          instances.claudeAgent_work,
          instances.codex,
        ]),
      }),
    ),
    Layer.provide(NodeCrypto.layer),
  );
  return { listReads, submitted, signedIn, layer };
});

it.effect("ProviderMcp lists config servers first and reads again after a change", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const service = yield* ProviderMcp.ProviderMcp;
      const listed = yield* service.list({ instanceId });
      assert.deepEqual(
        listed.servers.map((entry) => entry.name),
        ["alpha", "minions", "plugin:tools:zeta", "codex_apps"],
      );
      yield* service.list({ instanceId });
      assert.equal(yield* Ref.get(harness.listReads), 1);
      yield* service.list({ instanceId: siblingInstanceId });
      yield* service.list({ instanceId: otherInstanceId });
      assert.equal(yield* Ref.get(harness.listReads), 3);

      // Accounts on the same home share its servers, so the change reaches each of their lists.
      yield* service.remove({ instanceId, name: "alpha" });
      yield* service.list({ instanceId });
      yield* service.list({ instanceId: siblingInstanceId });
      yield* service.list({ instanceId: otherInstanceId });
      assert.equal(yield* Ref.get(harness.listReads), 5);

      const unsupported = yield* service
        .list({ instanceId: ProviderInstanceId.make("cursor") })
        .pipe(Effect.flip);
      assert.equal(unsupported.reason, "unsupported");
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("ProviderMcp hands a pasted callback only to the open sign-in it belongs to", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const service = yield* ProviderMcp.ProviderMcp;
      yield* service.list({ instanceId: siblingInstanceId });
      const states = yield* Queue.unbounded<ProviderMcpSignInState>();
      const signIn = yield* service.signIn({ instanceId, name: "minions" }).pipe(
        Stream.runForEach((state) => Queue.offer(states, state)),
        Effect.forkChild,
      );

      const waiting = yield* Queue.take(states);
      assert.equal(waiting.phase, "waiting");
      assert.equal(waiting.authorizationUrl, "https://auth.example/minions");

      const otherProvider = yield* service
        .completeSignIn({
          instanceId: otherInstanceId,
          flowId: waiting.flowId,
          callbackUrl: "http://localhost:1/callback?code=x&state=y",
        })
        .pipe(Effect.flip);
      assert.equal(otherProvider.reason, "signInClosed");
      yield* service.completeSignIn({
        instanceId,
        flowId: waiting.flowId,
        callbackUrl: "http://localhost:1/callback?code=x&state=y",
      });
      assert.deepEqual(yield* Ref.get(harness.submitted), [
        "http://localhost:1/callback?code=x&state=y",
      ]);

      yield* Deferred.succeed(harness.signedIn, undefined);
      const succeeded = yield* Queue.take(states);
      assert.deepEqual(succeeded, { flowId: waiting.flowId, phase: "succeeded" });
      yield* Fiber.join(signIn);
      // Claude accounts on one home share sign-ins, so the sign-in reaches each of their lists.
      yield* service.list({ instanceId: siblingInstanceId });
      assert.equal(yield* Ref.get(harness.listReads), 2);

      const closed = yield* service
        .completeSignIn({
          instanceId,
          flowId: waiting.flowId,
          callbackUrl: "http://localhost:1/callback?code=x&state=y",
        })
        .pipe(Effect.flip);
      assert.equal(closed.reason, "signInClosed");
    }).pipe(Effect.provide(harness.layer));
  }),
);
