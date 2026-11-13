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
import * as AccountRouting from "../orchestration-v2/AccountRouting.ts";
import * as ProviderMcp from "./ProviderMcp.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

// Clients on several screens poll together; they share one pass.
const RESULT_TTL = Duration.seconds(20);
const MCP_LIST_CONCURRENCY = 4;

/**
 * The sign-ins one machine can see it needs, one step per provider instance, kind and MCP server.
 * A lapsed or ending login replaces the "signed out" step it causes, so one fix is one step.
 */
export function selectDetectedManualSteps(input: {
  readonly machine: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** MCP servers per provider instance, for the instances that could be listed. */
  readonly mcpServers: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ProviderMcpServer>>;
  /** Accounts ChatGPT's connected-app cap stopped, with no turn run on them since. */
  readonly appCapped: ReadonlySet<ProviderInstanceId>;
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
    } else if (input.appCapped.has(provider.instanceId)) {
      add({ ...account, kind: "connected-app-cap" });
    }
    for (const server of input.mcpServers.get(provider.instanceId) ?? []) {
      if (!ProviderMcp.needsMcpSignIn(server)) continue;
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
  const routing = yield* AccountRouting.AccountRouting;

  const readMcpServers = (provider: ServerProvider) =>
    mcp
      .discover(provider.instanceId)
      .pipe(
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
        providers.filter((provider) => ProviderMcp.canListMcpServers(provider, nowMs)),
        readMcpServers,
        { concurrency: MCP_LIST_CONCURRENCY },
      ),
    );
    // The thread that hit the cap already says so; without the holds only this step is missing.
    const appCapped = yield* routing.holds.pipe(
      Effect.map(
        (holds) =>
          new Set(holds.filter((hold) => hold.appCap === true).map((hold) => hold.instanceId)),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Usage holds for manual steps unavailable", { cause }).pipe(
          Effect.as(new Set<ProviderInstanceId>()),
        ),
      ),
    );
    return {
      steps: selectDetectedManualSteps({ machine, providers, mcpServers, appCapped, nowMs }),
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
