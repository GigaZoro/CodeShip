import {
  type DetectedManualStep,
  type DetectedManualStepsResult,
  type ProviderInstanceId,
  type ProviderMcpServer,
  type ServerProvider,
} from "@t3tools/contracts";
import { providerLoginExpiry } from "@t3tools/shared/providerLoginExpiry";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderMcp from "./ProviderMcp.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

// Listing a provider's MCP servers starts it, so a poll reuses what the last list found.
const MCP_LIST_MAX_AGE = Duration.minutes(15);
// One request waits this long for a discovery; the discovery itself runs on under the driver's own timeout.
const MCP_LIST_WAIT = Duration.seconds(25);
// A provider that could not list is left alone this long, because each try starts it and its servers.
const MCP_LIST_RETRY_AFTER_FAILURE = Duration.minutes(5);
// Clients on several screens poll together; they share one pass.
const RESULT_TTL = Duration.seconds(20);
const MCP_LIST_CONCURRENCY = 4;

/** Whether the provider can be asked for its MCP servers: signed in, started, and not lapsed. */
const canListMcpServers = (provider: ServerProvider, nowMs: number) =>
  provider.auth.status === "authenticated" &&
  providerLoginExpiry(provider.auth.loginExpiresAt, nowMs)?.state !== "expired";

/** Plugins bundle servers the person never set up, so only their own failures count (see the MCP page). */
const needsMcpSignIn = (server: ProviderMcpServer) =>
  server.status === "needsAuth" && server.canSignIn && server.origin !== "plugin";

/**
 * The sign-ins one machine can see it needs, one step per provider instance, kind and MCP server.
 * A lapsed or ending login replaces the "signed out" step it causes, so one fix is one step.
 */
export function selectDetectedManualSteps(input: {
  readonly machine: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** MCP servers per provider instance, for the instances that could be listed. */
  readonly mcpServers: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ProviderMcpServer>>;
  readonly nowMs: number;
}): ReadonlyArray<DetectedManualStep> {
  const steps = new Map<string, DetectedManualStep>();
  const add = (step: Omit<DetectedManualStep, "id" | "machine">) => {
    const id = [step.kind, step.instanceId, step.serverName ?? ""].join(":");
    steps.set(id, { id, machine: input.machine, ...step });
  };
  for (const provider of input.providers) {
    if (!provider.enabled || !provider.installed || provider.availability === "unavailable") {
      continue;
    }
    const account = {
      instanceId: provider.instanceId,
      driver: provider.driver,
      ...(provider.displayName ? { accountName: provider.displayName } : {}),
    };
    const expiry = providerLoginExpiry(provider.auth.loginExpiresAt, input.nowMs);
    if (expiry?.state === "expired" || expiry?.state === "expiring") {
      add({
        ...account,
        kind: expiry.state === "expired" ? "login-expired" : "login-expiring",
        expiresAt: expiry.expiresAt,
      });
    } else if (provider.auth.status === "unauthenticated") {
      add({ ...account, kind: "signed-out" });
    }
    for (const server of input.mcpServers.get(provider.instanceId) ?? []) {
      if (!needsMcpSignIn(server)) continue;
      add({
        ...account,
        kind: "mcp-needs-auth",
        serverName: server.name,
        ...(server.displayName ? { serverDisplayName: server.displayName } : {}),
      });
    }
  }
  return [...steps.values()];
}

export class DetectedManualSteps extends Context.Service<
  DetectedManualSteps,
  {
    /** The sign-ins this machine needs, found from its own provider status; never reads ThreadPage. */
    readonly list: Effect.Effect<DetectedManualStepsResult>;
  }
>()("t3/provider/DetectedManualSteps") {}

const make = Effect.gen(function* () {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const mcp = yield* ProviderMcp.ProviderMcp;
  const environment = yield* ServerEnvironment.ServerEnvironment;

  const scope = yield* Effect.scope;

  type Discovery = {
    readonly result: Deferred.Deferred<Option.Option<ReadonlyArray<ProviderMcpServer>>>;
    /** Set once the discovery has ended; a failed one is remembered until the retry delay passes. */
    finishedAt: number | undefined;
    failed: boolean;
  };
  const discoveries = new Map<ProviderInstanceId, Discovery>();

  const runDiscovery = (instanceId: ProviderInstanceId, discovery: Discovery) =>
    mcp.listRecent(instanceId, MCP_LIST_MAX_AGE).pipe(
      Effect.map((listed) => Option.some(listed.servers)),
      // A provider that cannot list stays out of the answer; its own card already says why.
      Effect.catch((error) =>
        Effect.logWarning("MCP discovery for manual steps failed", {
          instanceId,
          reason: error.reason,
        }).pipe(Effect.as(Option.none<ReadonlyArray<ProviderMcpServer>>())),
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

  // One discovery per instance, owned by the server instead of the request that asked: a request
  // that gives up waiting leaves it running, and the next poll joins it instead of starting another.
  const discover = Effect.fn("DetectedManualSteps.discover")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const fresh: Discovery = {
      result: yield* Deferred.make<Option.Option<ReadonlyArray<ProviderMcpServer>>>(),
      finishedAt: undefined,
      failed: false,
    };
    const known = discoveries.get(instanceId);
    const reusable =
      known !== undefined &&
      (known.finishedAt === undefined ||
        (known.failed && now - known.finishedAt < Duration.toMillis(MCP_LIST_RETRY_AFTER_FAILURE)));
    if (!reusable) {
      discoveries.set(instanceId, fresh);
      yield* runDiscovery(instanceId, fresh).pipe(Effect.forkIn(scope));
    }
    return yield* Deferred.await((reusable ? known : fresh).result).pipe(
      Effect.timeoutOption(MCP_LIST_WAIT),
      Effect.map(Option.flatten),
    );
  });

  const readMcpServers = (provider: ServerProvider) =>
    discover(provider.instanceId).pipe(
      Effect.map(
        (listed) =>
          [
            provider.instanceId,
            Option.getOrElse(listed, () => [] as ReadonlyArray<ProviderMcpServer>),
          ] as const,
      ),
    );

  const detect = Effect.gen(function* () {
    const providers = yield* registry.getProviders;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const machine = (yield* environment.getDescriptor).label;
    const mcpServers = new Map(
      yield* Effect.forEach(
        providers.filter(
          (provider) =>
            provider.enabled &&
            provider.installed &&
            provider.availability !== "unavailable" &&
            canListMcpServers(provider, nowMs),
        ),
        readMcpServers,
        { concurrency: MCP_LIST_CONCURRENCY },
      ),
    );
    return {
      steps: selectDetectedManualSteps({ machine, providers, mcpServers, nowMs }),
      checkedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies DetectedManualStepsResult;
  }).pipe(Effect.withSpan("DetectedManualSteps.detect"));

  const cache = yield* Cache.makeWith(() => detect, {
    capacity: 1,
    timeToLive: () => RESULT_TTL,
  });
  return DetectedManualSteps.of({ list: Cache.get(cache, "all") });
});

export const layer = Layer.effect(DetectedManualSteps, make);
