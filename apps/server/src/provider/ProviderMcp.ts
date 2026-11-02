import {
  ProviderMcpError,
  type ProviderInstanceId,
  type ProviderMcpAddInput,
  type ProviderMcpCompleteSignInInput,
  type ProviderMcpListInput,
  type ProviderMcpListResult,
  type ProviderMcpOperation,
  type ProviderMcpServer,
  type ProviderMcpServerInput,
  type ProviderMcpSignInState,
} from "@t3tools/contracts";
import type {
  ProviderMcpManagement,
  ProviderMcpSignIn,
} from "@t3tools/provider-core/server/driver";
import * as Cache from "effect/Cache";
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

  const lists = yield* Cache.makeWith(
    (instanceId: ProviderInstanceId) =>
      management(instanceId, "list").pipe(
        Effect.flatMap((mcp) => mcp.list),
        Effect.map(sortProviderMcpServers),
      ),
    {
      capacity: 32,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_TTL : Duration.zero),
    },
  );

  const change = (
    instanceId: ProviderInstanceId,
    operation: ProviderMcpOperation,
    run: (mcp: ProviderMcpManagement) => Effect.Effect<void, ProviderMcpError>,
  ) =>
    management(instanceId, operation).pipe(
      Effect.flatMap(run),
      Effect.ensuring(Cache.invalidate(lists, instanceId)),
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
          Effect.ensuring(Cache.invalidate(lists, input.instanceId)),
          Effect.as(succeeded),
        ),
      ),
    );
  });

  return ProviderMcp.of({
    list: Effect.fn("ProviderMcp.list")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId });
      if (input.refresh === true) yield* Cache.invalidate(lists, input.instanceId);
      return { servers: yield* Cache.get(lists, input.instanceId) };
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
  });
});

export const layer = Layer.effect(ProviderMcp, make);
