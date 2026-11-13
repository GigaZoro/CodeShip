import {
  ProviderMcpError,
  providerMcpServerSettings,
  resolveProviderMcpServerEdit,
  type ProviderInstanceId,
  type ProviderMcpAddInput,
  type ProviderMcpCompleteSignInInput,
  type ProviderMcpEditInput,
  type ProviderMcpListInput,
  type ProviderMcpListResult,
  type ProviderMcpOperation,
  type ProviderMcpReadResult,
  type ProviderMcpServer,
  type ProviderMcpServerInput,
  type ProviderMcpSetEnabledInput,
  type ProviderMcpSignInState,
  type ServerProvider,
} from "@t3tools/contracts";
import type {
  ProviderMcpManagement,
  ProviderMcpSignIn,
} from "@t3tools/provider-core/server/driver";
import { providerLoginExpiry } from "@t3tools/shared/providerLoginExpiry";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

// Listing starts the provider and connects to every server; a change or a refresh drops the copy.
const LIST_TTL = Duration.seconds(30);
// Both Claude and Codex stop waiting for the browser after five minutes.
const SIGN_IN_TIMEOUT = Duration.minutes(5);

/** How old a list may be when a poller or a launch reads it instead of listing again. */
export const MCP_LIST_MAX_AGE = Duration.minutes(15);
// A discovery's caller waits this long; the discovery itself runs on under the driver's own timeout.
const DISCOVERY_WAIT = Duration.seconds(25);
// A provider that could not list is left alone this long, because each try starts it and its servers.
const DISCOVERY_RETRY_AFTER_FAILURE = Duration.minutes(5);

/** Whether a provider can be asked for its MCP servers: on, installed, signed in and not lapsed. */
export const canListMcpServers = (provider: ServerProvider, nowMs: number) =>
  provider.enabled &&
  provider.installed &&
  provider.availability !== "unavailable" &&
  provider.auth.status === "authenticated" &&
  providerLoginExpiry(provider.auth.loginExpiresAt, nowMs)?.state !== "expired";

const ORIGIN_ORDER: Record<ProviderMcpServer["origin"], number> = {
  config: 0,
  plugin: 1,
  connector: 2,
  managed: 3,
  builtIn: 4,
};

/** The servers people add first, then what plugins, connectors, and policies bring. */
function sortProviderMcpServers(servers: ReadonlyArray<ProviderMcpServer>) {
  return servers.toSorted(
    (left, right) =>
      ORIGIN_ORDER[left.origin] - ORIGIN_ORDER[right.origin] ||
      (left.displayName ?? left.name).localeCompare(right.displayName ?? right.name),
  );
}

/** Plugins bundle servers the person never set up, so only their own failures count (see the MCP page). */
export const needsMcpSignIn = (server: ProviderMcpServer) =>
  server.status === "needsAuth" && server.canSignIn && server.origin !== "plugin";

export class ProviderMcp extends Context.Service<
  ProviderMcp,
  {
    readonly list: (
      input: ProviderMcpListInput,
    ) => Effect.Effect<ProviderMcpListResult, ProviderMcpError>;
    /**
     * The servers of a list no older than MCP_LIST_MAX_AGE, listing again when there is none, for a
     * reader that must not hang on a slow provider. The list belongs to this service, not the
     * caller: a caller waits at most 25 seconds and gets none, the list runs on, and the next caller
     * joins it. None too when the provider could not list; it is not started again for 5 minutes.
     */
    readonly discover: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<Option.Option<ReadonlyArray<ProviderMcpServer>>>;
    /**
     * The last list this server loaded for the instance when it is no older than `maxAge`. Never
     * starts the provider, so a path that must not wait or spend a start reads this instead.
     */
    readonly listLoaded: (
      instanceId: ProviderInstanceId,
      maxAge: Duration.Input,
    ) => Effect.Effect<Option.Option<ReadonlyArray<ProviderMcpServer>>>;
    readonly add: (input: ProviderMcpAddInput) => Effect.Effect<void, ProviderMcpError>;
    readonly remove: (input: ProviderMcpServerInput) => Effect.Effect<void, ProviderMcpError>;
    readonly signOut: (input: ProviderMcpServerInput) => Effect.Effect<void, ProviderMcpError>;
    /** Stays open until the sign-in finishes; unsubscribing cancels it. */
    readonly signIn: (
      input: ProviderMcpServerInput,
    ) => Stream.Stream<ProviderMcpSignInState, ProviderMcpError>;
    readonly completeSignIn: (
      input: ProviderMcpCompleteSignInInput,
    ) => Effect.Effect<void, ProviderMcpError>;
    /** Names only for headers and variables: their values never leave the server. */
    readonly read: (
      input: ProviderMcpServerInput,
    ) => Effect.Effect<ProviderMcpReadResult, ProviderMcpError>;
    /** An empty header or variable value, or a missing address, keeps the stored one. */
    readonly edit: (input: ProviderMcpEditInput) => Effect.Effect<void, ProviderMcpError>;
    /** Turns a server off without deleting what it needs, and on again. */
    readonly setEnabled: (
      input: ProviderMcpSetEnabledInput,
    ) => Effect.Effect<void, ProviderMcpError>;
  }
>()("t3/provider/ProviderMcp") {}

const make = Effect.gen(function* () {
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;
  const signIns = new Map<
    string,
    { readonly instanceId: ProviderInstanceId; readonly signIn: ProviderMcpSignIn }
  >();

  const management = Effect.fn("ProviderMcp.management")(function* (
    instanceId: ProviderInstanceId,
    operation: ProviderMcpOperation,
  ) {
    const instance = yield* instances.getInstance(instanceId);
    if (instance === undefined) {
      return yield* new ProviderMcpError({ operation, instanceId, reason: "instanceNotFound" });
    }
    if (instance.mcp === undefined) {
      return yield* new ProviderMcpError({ operation, instanceId, reason: "unsupported" });
    }
    return instance.mcp;
  });

  // Survives the cache's short TTL, but not a change: the next reader lists again.
  const loaded = new Map<
    ProviderInstanceId,
    { readonly servers: ReadonlyArray<ProviderMcpServer>; readonly at: number }
  >();

  // A list that began before a change describes the old servers; it must not become `loaded`.
  const generations = new Map<ProviderInstanceId, number>();
  const generationOf = (instanceId: ProviderInstanceId) => generations.get(instanceId) ?? 0;

  const lists = yield* Cache.makeWith(
    (instanceId: ProviderInstanceId) =>
      Effect.sync(() => generationOf(instanceId)).pipe(
        Effect.flatMap((started) =>
          management(instanceId, "list").pipe(
            Effect.flatMap((mcp) => mcp.list),
            Effect.map(sortProviderMcpServers),
            Effect.tap((servers) =>
              Clock.currentTimeMillis.pipe(
                Effect.tap((at) =>
                  Effect.sync(() => {
                    if (generationOf(instanceId) === started) {
                      loaded.set(instanceId, { servers, at });
                    }
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    {
      capacity: 32,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_TTL : Duration.zero),
    },
  );

  const invalidateList = (instanceId: ProviderInstanceId) =>
    Effect.sync(() => {
      generations.set(instanceId, generationOf(instanceId) + 1);
      loaded.delete(instanceId);
    }).pipe(Effect.andThen(Cache.invalidate(lists, instanceId)));

  const change = (
    instanceId: ProviderInstanceId,
    operation: ProviderMcpOperation,
    run: (mcp: ProviderMcpManagement) => Effect.Effect<void, ProviderMcpError>,
  ) =>
    management(instanceId, operation).pipe(
      Effect.flatMap(run),
      Effect.ensuring(
        instances.listInstances.pipe(
          Effect.flatMap((all) =>
            Effect.forEach(
              ProviderInstanceRegistry.instancesSharingHome(all, instanceId),
              invalidateList,
              { discard: true },
            ),
          ),
        ),
      ),
    );

  const openSignIn = Effect.fn("ProviderMcp.openSignIn")(function* (input: ProviderMcpServerInput) {
    yield* Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId });
    const mcp = yield* management(input.instanceId, "signIn");
    const signIn = yield* mcp.signIn(input.name);
    const flowId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    yield* Effect.acquireRelease(
      Effect.sync(() => signIns.set(flowId, { instanceId: input.instanceId, signIn })),
      () => Effect.sync(() => signIns.delete(flowId)),
    );
    const waiting: ProviderMcpSignInState = {
      flowId,
      phase: "waiting",
      ...(signIn.authorizationUrl ? { authorizationUrl: signIn.authorizationUrl } : {}),
    };
    const succeeded: ProviderMcpSignInState = { flowId, phase: "succeeded" };
    return Stream.concat(
      Stream.make(waiting),
      Stream.fromEffect(
        signIn.completed.pipe(
          Effect.timeoutOrElse({
            duration: SIGN_IN_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new ProviderMcpError({
                  operation: "signIn",
                  instanceId: input.instanceId,
                  reason: "providerFailed",
                  providerMessage: "The sign-in expired. Start it again.",
                }),
              ),
          }),
          Effect.ensuring(invalidateList(input.instanceId)),
          Effect.as(succeeded),
        ),
      ),
    );
  });

  const loadedWithin = (instanceId: ProviderInstanceId, maxAge: Duration.Input) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        const known = loaded.get(instanceId);
        return known !== undefined &&
          now - known.at <= Duration.toMillis(Duration.fromInputUnsafe(maxAge))
          ? Option.some(known.servers)
          : Option.none<ReadonlyArray<ProviderMcpServer>>();
      }),
    );

  type Discovery = {
    readonly result: Deferred.Deferred<Option.Option<ReadonlyArray<ProviderMcpServer>>>;
    /** Set once the discovery has ended; a failed one is remembered until the retry delay passes. */
    finishedAt: number | undefined;
    failed: boolean;
  };
  const discoveries = new Map<ProviderInstanceId, Discovery>();

  // Forked into this scope rather than the caller's: when its last waiter left, the cache would
  // interrupt a list run under the caller, and a provider slower than the wait would never finish.
  const runDiscovery = (instanceId: ProviderInstanceId, discovery: Discovery) =>
    loadedWithin(instanceId, MCP_LIST_MAX_AGE).pipe(
      Effect.flatMap((known) =>
        Option.isSome(known) ? Effect.succeed(known.value) : Cache.get(lists, instanceId),
      ),
      Effect.asSome,
      // A provider that cannot list stays out of the answer; its own card already says why.
      Effect.catch((error) =>
        Effect.logWarning("MCP discovery failed", { instanceId, reason: error.reason }).pipe(
          Effect.as(Option.none<ReadonlyArray<ProviderMcpServer>>()),
        ),
      ),
      Effect.tap((listed) =>
        Clock.currentTimeMillis.pipe(
          Effect.tap((now) =>
            Effect.sync(() => {
              discovery.finishedAt = now;
              discovery.failed = Option.isNone(listed);
            }),
          ),
        ),
      ),
      Effect.flatMap((listed) => Deferred.succeed(discovery.result, listed)),
    );

  return ProviderMcp.of({
    list: Effect.fn("ProviderMcp.list")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId });
      if (input.refresh === true) yield* invalidateList(input.instanceId);
      return { servers: yield* Cache.get(lists, input.instanceId) };
    }),
    discover: Effect.fn("ProviderMcp.discover")(function* (instanceId) {
      yield* Effect.annotateCurrentSpan({ "provider.instance_id": instanceId });
      const now = yield* Clock.currentTimeMillis;
      const known = discoveries.get(instanceId);
      const reusable =
        known !== undefined &&
        (known.finishedAt === undefined ||
          (known.failed &&
            now - known.finishedAt < Duration.toMillis(DISCOVERY_RETRY_AFTER_FAILURE)));
      let discovery: Discovery;
      if (reusable) {
        discovery = known;
      } else {
        discovery = {
          result: yield* Deferred.make<Option.Option<ReadonlyArray<ProviderMcpServer>>>(),
          finishedAt: undefined,
          failed: false,
        };
        discoveries.set(instanceId, discovery);
        yield* runDiscovery(instanceId, discovery).pipe(Effect.forkIn(scope));
      }
      return yield* Deferred.await(discovery.result).pipe(
        Effect.timeoutOption(DISCOVERY_WAIT),
        Effect.map(Option.flatten),
      );
    }),
    listLoaded: loadedWithin,
    add: Effect.fn("ProviderMcp.add")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId });
      yield* change(input.instanceId, "add", (mcp) => mcp.add(input.name, input.server));
    }),
    remove: Effect.fn("ProviderMcp.remove")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId });
      yield* change(input.instanceId, "remove", (mcp) => mcp.remove(input.name));
    }),
    signOut: Effect.fn("ProviderMcp.signOut")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId });
      yield* change(input.instanceId, "signOut", (mcp) => mcp.signOut(input.name));
    }),
    signIn: (input) => Stream.unwrap(openSignIn(input)),
    completeSignIn: Effect.fn("ProviderMcp.completeSignIn")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId });
      const open = signIns.get(input.flowId);
      if (open === undefined || open.instanceId !== input.instanceId) {
        return yield* new ProviderMcpError({
          operation: "signIn",
          instanceId: input.instanceId,
          reason: "signInClosed",
        });
      }
      yield* open.signIn.submitCallbackUrl(input.callbackUrl);
    }),
    read: Effect.fn("ProviderMcp.read")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId });
      const mcp = yield* management(input.instanceId, "read");
      return { server: providerMcpServerSettings(yield* mcp.read(input.name)) };
    }),
    edit: Effect.fn("ProviderMcp.edit")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId });
      yield* change(input.instanceId, "edit", (mcp) =>
        mcp.read(input.name).pipe(
          Effect.flatMap((stored) => {
            const resolved = resolveProviderMcpServerEdit(stored, input.server);
            return "server" in resolved
              ? mcp.edit(input.name, resolved.server)
              : Effect.fail(
                  new ProviderMcpError({
                    operation: "edit",
                    instanceId: input.instanceId,
                    reason: "providerFailed",
                    providerMessage: `Enter a value for ${resolved.missing}.`,
                  }),
                );
          }),
        ),
      );
    }),
    setEnabled: Effect.fn("ProviderMcp.setEnabled")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId });
      yield* change(input.instanceId, "setEnabled", (mcp) =>
        mcp.setEnabled(input.name, input.enabled),
      );
    }),
  });
});

export const layer = Layer.effect(ProviderMcp, make);
