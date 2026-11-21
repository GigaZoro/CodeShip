import { EnvironmentId } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";

const limitsRefreshStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make({ pending: false, failed: false }).pipe(
    Atom.withLabel(`mobile:limits-refresh-state:${environmentId}`),
  ),
);

export async function refreshEnvironmentLimits(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  options: { readonly automatic?: boolean; readonly afterPending?: boolean } = {},
): Promise<void> {
  // One refresh runs per environment at a time, so results land in the order
  // they were started and the newest outcome always wins.
  await refreshUsageLimits(
    environmentId,
    async () => {
      const atom = limitsRefreshStateAtom(environmentId);
      let failed = registry.get(atom).failed;
      registry.set(atom, { pending: true, failed });
      try {
        const result = await runAtomCommand(
          registry,
          serverEnvironment.refreshProviders,
          { environmentId, input: {} },
          { reportFailure: false },
        );
        failed = result._tag === "Failure";
      } finally {
        registry.set(atom, { pending: false, failed });
      }
    },
    options.automatic,
    options.afterPending,
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
    splitEnvironmentIds(environmentIds).filter(
      (environmentId) => get(limitsRefreshStateAtom(environmentId)).failed,
    ),
  ),
);

export const limitsRefreshingEnvironmentIdsAtom = Atom.family((environmentIds: string) =>
  Atom.make(
    (get) =>
      new Set(
        splitEnvironmentIds(environmentIds).filter(
          (environmentId) => get(limitsRefreshStateAtom(environmentId)).pending,
        ),
      ),
  ),
);
