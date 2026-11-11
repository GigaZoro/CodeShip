import {
  type DetectedManualStep,
  type DetectedManualStepsResult,
  type ProviderInstanceId,
  type ProviderMcpServer,
  type ServerProvider,
} from "@t3tools/contracts";
import { providerLoginExpiry } from "@t3tools/shared/providerLoginExpiry";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderMcp from "./ProviderMcp.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

// Listing a provider's MCP servers starts it, so a poll reuses what the last list found.
const MCP_LIST_MAX_AGE = Duration.minutes(15);
const MCP_LIST_TIMEOUT = Duration.seconds(25);
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

  const readMcpServers = (provider: ServerProvider) =>
    mcp.listRecent(provider.instanceId, MCP_LIST_MAX_AGE).pipe(
      Effect.timeoutOption(MCP_LIST_TIMEOUT),
      // A provider that cannot list stays out of the answer; its own card already says why.
      Effect.catch(() => Effect.succeedNone),
      Effect.map(
        (listed) =>
          [
            provider.instanceId,
            Option.match(listed, {
              onNone: () => [] as ReadonlyArray<ProviderMcpServer>,
              onSome: (result) => result.servers,
            }),
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
