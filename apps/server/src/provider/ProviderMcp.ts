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
} from "@t3tools/contracts";
import type {
  ProviderMcpManagement,
  ProviderMcpSignIn,
} from "@t3tools/provider-core/server/driver";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

// Listing starts the provider and connects to every server; a change or a refresh drops the copy.
const LIST_TTL = Duration.seconds(30);
// Both Claude and Codex stop waiting for the browser after five minutes.
const SIGN_IN_TIMEOUT = Duration.minutes(5);

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

export class ProviderMcp extends Context.Service<
  ProviderMcp,
  {
    readonly list: (
      input: ProviderMcpListInput,
    ) => Effect.Effect<ProviderMcpListResult, ProviderMcpError>;
    /**
     * The last list this server loaded for the instance when it is no older than `maxAge`, else a
     * fresh one. Lets a poller read what the MCP page found without starting the provider each time.
     */
    readonly listRecent: (
      instanceId: ProviderInstanceId,
      maxAge: Duration.Input,
    ) => Effect.Effect<ProviderMcpListResult, ProviderMcpError>;
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

  return ProviderMcp.of({
    list: Effect.fn("ProviderMcp.list")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId });
      if (input.refresh === true) yield* invalidateList(input.instanceId);
      return { servers: yield* Cache.get(lists, input.instanceId) };
    }),
    listRecent: Effect.fn("ProviderMcp.listRecent")(function* (instanceId, maxAge) {
      yield* Effect.annotateCurrentSpan({ "provider.instance_id": instanceId });
      const known = loaded.get(instanceId);
      const now = yield* Clock.currentTimeMillis;
      if (
        known !== undefined &&
        now - known.at <= Duration.toMillis(Duration.fromInputUnsafe(maxAge))
      ) {
        return { servers: known.servers };
      }
      return { servers: yield* Cache.get(lists, instanceId) };
    }),
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
