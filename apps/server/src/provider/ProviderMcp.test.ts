import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderMcpError,
  type ProviderMcpServer,
  type ProviderMcpServerConfig,
  type ProviderMcpSignInState,
} from "@t3tools/contracts";
import type { ProviderInstance, ProviderMcpManagement } from "@t3tools/provider-core/server/driver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

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
  // The first list announces it started, then waits to be released.
  const firstListStarted = yield* Deferred.make<void>();
  const releaseFirstList = yield* Deferred.make<void>();
  const holdFirstList = yield* Ref.make(false);
  const failLists = yield* Ref.make(false);
  const submitted = yield* Ref.make<ReadonlyArray<string>>([]);
  const edited = yield* Ref.make<ReadonlyArray<readonly [string, ProviderMcpServerConfig]>>([]);
  const signedIn = yield* Deferred.make<void, ProviderMcpError>();
  const mcp: ProviderMcpManagement = {
    list: Ref.updateAndGet(listReads, (count) => count + 1).pipe(
      Effect.tap((reads) =>
        Ref.get(holdFirstList).pipe(
          Effect.flatMap((hold) =>
            hold && reads === 1
              ? Deferred.succeed(firstListStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFirstList)),
                )
              : Effect.void,
          ),
        ),
      ),
      Effect.tap(() =>
        Ref.get(failLists).pipe(
          Effect.flatMap((fail) =>
            fail
              ? Effect.fail(
                  new ProviderMcpError({ operation: "list", instanceId, reason: "providerFailed" }),
                )
              : Effect.void,
          ),
        ),
      ),
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
    read: () =>
      Effect.succeed({
        transport: "http",
        url: "https://alpha.example/mcp?key=secret",
        headers: { Authorization: "Bearer secret" },
      }),
    edit: (name, config) => Ref.update(edited, (all) => [...all, [name, config] as const]),
    setEnabled: () => Effect.void,
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
  return {
    listReads,
    submitted,
    edited,
    signedIn,
    layer,
    holdFirstList,
    failLists,
    firstListStarted,
    releaseFirstList,
  };
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

const minionsNeedsAuth = (listed: Option.Option<ReadonlyArray<ProviderMcpServer>>) =>
  Option.isSome(listed) &&
  listed.value.some((entry) => entry.name === "minions" && entry.status === "needsAuth");

it.effect("ProviderMcp.discover reuses an old list until it ages out or a change drops it", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const service = yield* ProviderMcp.ProviderMcp;
      yield* service.list({ instanceId });
      // Past the cache's 30 s but inside MCP_LIST_MAX_AGE: no second list.
      yield* TestClock.adjust("5 minutes");
      assert.isTrue(minionsNeedsAuth(yield* service.discover(instanceId)));
      assert.equal(yield* Ref.get(harness.listReads), 1);

      yield* TestClock.adjust("11 minutes");
      assert.isTrue(minionsNeedsAuth(yield* service.discover(instanceId)));
      assert.equal(yield* Ref.get(harness.listReads), 2);

      yield* service.setEnabled({ instanceId, name: "alpha", enabled: false });
      yield* service.discover(instanceId);
      assert.equal(yield* Ref.get(harness.listReads), 3);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("ProviderMcp.discover does not take a list that began before a change as fresh", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Ref.set(harness.holdFirstList, true);
    yield* Effect.gen(function* () {
      const service = yield* ProviderMcp.ProviderMcp;
      const early = yield* service.discover(instanceId).pipe(Effect.forkChild);
      yield* Deferred.await(harness.firstListStarted);
      // The cache stores the in-flight lookup right after it starts parked on the gate.
      yield* Effect.yieldNow;

      yield* service.setEnabled({ instanceId, name: "alpha", enabled: false });
      yield* Deferred.succeed(harness.releaseFirstList, undefined);
      yield* Fiber.join(early);

      yield* service.discover(instanceId);
      assert.equal(yield* Ref.get(harness.listReads), 2);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("ProviderMcp.discover keeps a slow list running after its caller gives up", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Ref.set(harness.holdFirstList, true);
    yield* Effect.gen(function* () {
      const service = yield* ProviderMcp.ProviderMcp;
      const first = yield* service.discover(instanceId).pipe(Effect.forkChild);
      yield* Deferred.await(harness.firstListStarted);
      yield* TestClock.adjust("26 seconds");
      assert.isTrue(Option.isNone(yield* Fiber.join(first)));

      // The next caller joins the list still running instead of starting the provider again.
      const second = yield* service.discover(instanceId).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(harness.releaseFirstList, undefined);
      assert.isTrue(minionsNeedsAuth(yield* Fiber.join(second)));
      assert.equal(yield* Ref.get(harness.listReads), 1);
      assert.isTrue(minionsNeedsAuth(yield* service.listLoaded(instanceId, "15 minutes")));
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("ProviderMcp.discover does not start a provider that failed again for 5 minutes", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Ref.set(harness.failLists, true);
    yield* Effect.gen(function* () {
      const service = yield* ProviderMcp.ProviderMcp;
      assert.isTrue(Option.isNone(yield* service.discover(instanceId)));
      yield* TestClock.adjust("1 minute");
      assert.isTrue(Option.isNone(yield* service.discover(instanceId)));
      yield* TestClock.adjust("3 minutes");
      assert.isTrue(Option.isNone(yield* service.discover(instanceId)));
      assert.equal(yield* Ref.get(harness.listReads), 1);

      yield* Ref.set(harness.failLists, false);
      yield* TestClock.adjust("1 minute");
      assert.isTrue(minionsNeedsAuth(yield* service.discover(instanceId)));
      assert.equal(yield* Ref.get(harness.listReads), 2);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("ProviderMcp.listLoaded returns only a loaded list inside its age and never lists", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const service = yield* ProviderMcp.ProviderMcp;
      assert.isTrue(Option.isNone(yield* service.listLoaded(instanceId, "15 minutes")));
      assert.equal(yield* Ref.get(harness.listReads), 0);

      yield* service.list({ instanceId });
      yield* TestClock.adjust("5 minutes");
      const loaded = yield* service.listLoaded(instanceId, "15 minutes");
      assert.isTrue(
        Option.isSome(loaded) &&
          loaded.value.some((entry) => entry.name === "minions" && entry.status === "needsAuth"),
      );

      yield* TestClock.adjust("11 minutes");
      assert.isTrue(Option.isNone(yield* service.listLoaded(instanceId, "15 minutes")));

      yield* service.list({ instanceId, refresh: true });
      yield* service.setEnabled({ instanceId, name: "alpha", enabled: false });
      assert.isTrue(Option.isNone(yield* service.listLoaded(instanceId, "15 minutes")));
      assert.equal(yield* Ref.get(harness.listReads), 2);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it("needsMcpSignIn counts a signable needs-auth server unless a plugin brought it", () => {
  const needing = server({
    name: "minions",
    origin: "config",
    status: "needsAuth",
    canSignIn: true,
  });
  assert.isTrue(ProviderMcp.needsMcpSignIn(needing));
  assert.isFalse(ProviderMcp.needsMcpSignIn({ ...needing, origin: "plugin" }));
  assert.isFalse(ProviderMcp.needsMcpSignIn({ ...needing, canSignIn: false }));
  assert.isFalse(ProviderMcp.needsMcpSignIn({ ...needing, status: "connected" }));
});

it.effect("ProviderMcp hands a pasted callback only to the open sign-in it belongs to", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const service = yield* ProviderMcp.ProviderMcp;
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

it.effect(
  "ProviderMcp keeps stored secrets out of a read and in an edit that leaves them empty",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* ProviderMcp.ProviderMcp;
        assert.deepEqual(yield* service.read({ instanceId, name: "alpha" }), {
          server: {
            transport: "http",
            url: "https://alpha.example/mcp",
            urlHasSecret: true,
            headerNames: ["Authorization"],
          },
        });

        yield* service.list({ instanceId });
        yield* service.edit({
          instanceId,
          name: "alpha",
          server: { transport: "http", headers: { Authorization: "" } },
        });
        assert.deepEqual(yield* Ref.get(harness.edited), [
          [
            "alpha",
            {
              transport: "http",
              url: "https://alpha.example/mcp?key=secret",
              headers: { Authorization: "Bearer secret" },
            },
          ],
        ]);
        const missing = yield* service
          .edit({
            instanceId,
            name: "alpha",
            server: { transport: "http", headers: { "X-Key": "" } },
          })
          .pipe(Effect.flip);
        assert.equal(missing.message, "Enter a value for X-Key.");

        // An edit or a switch is a change, so the next list asks the provider again.
        yield* service.list({ instanceId });
        yield* service.setEnabled({ instanceId, name: "alpha", enabled: false });
        yield* service.list({ instanceId });
        assert.equal(yield* Ref.get(harness.listReads), 3);
      }).pipe(Effect.provide(harness.layer));
    }),
);
