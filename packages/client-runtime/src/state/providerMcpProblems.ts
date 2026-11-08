import type { ProviderMcpListResult, ProviderMcpServer } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { QueryAnswerHandler } from "./runtime.ts";

export interface ProviderMcpProblem {
  readonly name: string;
  readonly displayName?: string;
  readonly status: "failed" | "needsAuth";
}

/** Plugins bundle servers the user never set up, so only a failure counts for those. */
export function providerMcpProblemOf(server: ProviderMcpServer): ProviderMcpProblem | null {
  if (
    server.status !== "failed" &&
    !(server.status === "needsAuth" && server.origin !== "plugin")
  ) {
    return null;
  }
  return {
    name: server.name,
    ...(server.displayName === undefined ? {} : { displayName: server.displayName }),
    status: server.status,
  };
}

export const providerMcpProblemsKey = (environmentId: string, instanceId: string) =>
  JSON.stringify([environmentId, instanceId]);

/**
 * What the last MCP list this app loaded found wrong, per provider instance. Listing starts the
 * provider, so the sidebar reads this instead of asking.
 */
export const providerMcpProblemsAtom = Atom.make<
  ReadonlyMap<string, ReadonlyArray<ProviderMcpProblem>>
>(new Map()).pipe(Atom.keepAlive, Atom.withLabel("provider-mcp-problems"));

export const recordProviderMcpProblems: QueryAnswerHandler<
  { readonly instanceId: string },
  ProviderMcpListResult
> = ({ environmentId, input }, answer, registry) =>
  Effect.sync(() => {
    const problems = answer.servers.flatMap((server) => providerMcpProblemOf(server) ?? []);
    registry.update(providerMcpProblemsAtom, (known) => {
      const next = new Map(known);
      next.set(providerMcpProblemsKey(environmentId, input.instanceId), problems);
      return next;
    });
  });
