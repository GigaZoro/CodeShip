import { EnvironmentId } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";

const limitsRefreshPendingAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(false).pipe(Atom.keepAlive, Atom.withLabel(`mobile:limits-pending:${environmentId}`)),
);
const limitsRefreshFailedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(false).pipe(Atom.withLabel(`mobile:limits-failed:${environmentId}`)),
);

export async function refreshEnvironmentLimits(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  options: { readonly automatic?: boolean } = {},
): Promise<void> {
  // One refresh runs per environment at a time, so results land in the order
  // they were started and the newest outcome always wins.
  await refreshUsageLimits(
    environmentId,
    async () => {
      const pending = limitsRefreshPendingAtom(environmentId);
      registry.set(pending, true);
      try {
        const result = await runAtomCommand(
          registry,
          serverEnvironment.refreshProviders,
          { environmentId, input: {} },
          { reportFailure: false },
        );
        registry.set(limitsRefreshFailedAtom(environmentId), result._tag === "Failure");
      } finally {
        registry.set(pending, false);
      }
    },
    options.automatic,
  );
}

// Mounting starts an automatic refresh, which refreshUsageLimits throttles to
// one every few minutes per environment.
const limitsAutoRefreshAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    void refreshEnvironmentLimits(get.registry, environmentId, { automatic: true });
  }).pipe(Atom.withLabel(`mobile:limits-auto-refresh:${environmentId}`)),
);

export function environmentIdsKey(environmentIds: Iterable<EnvironmentId>): string {
  return [...environmentIds].sort().join(",");
}

function splitEnvironmentIds(key: string): EnvironmentId[] {
  return key === "" ? [] : key.split(",").map((id) => EnvironmentId.make(id));
}

/** Keyed by a sorted, comma-joined id list so equal selections share one atom. */
export const limitsAutoRefreshSetAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) => {
    for (const environmentId of splitEnvironmentIds(environmentIds)) {
      get(limitsAutoRefreshAtom(environmentId));
    }
  }),
);

export const limitsRefreshFailuresAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) =>
    splitEnvironmentIds(environmentIds).filter((environmentId) =>
      get(limitsRefreshFailedAtom(environmentId)),
    ),
  ),
);

export const limitsRefreshingEnvironmentIdsAtom = Atom.family((environmentIds: string) =>
  Atom.make(
    (get) =>
      new Set(
        splitEnvironmentIds(environmentIds).filter((environmentId) =>
          get(limitsRefreshPendingAtom(environmentId)),
        ),
      ),
  ),
);
