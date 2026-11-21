import type {
  EnvironmentId,
  ServerConfig,
  UsageModelFilter,
  UsageSummary,
  UsageSummaryInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { createEnvironmentPresentationAtoms } from "./presentation.ts";
import { executeAtomQuery, runAtomCommand, squashAtomCommandFailure } from "./runtime.ts";
import type { createServerEnvironmentAtoms } from "./server.ts";

const isEnvironmentRpcUnavailable = Schema.is(EnvironmentRpcUnavailableError);

export function cursorUsageAccess(
  config: Pick<ServerConfig, "providers" | "settings" | "usageLimitSources"> | null,
) {
  const cursor =
    config?.providers.filter((provider) => provider.driver === "cursor" && provider.enabled) ?? [];
  const ready = cursor.filter((provider) => provider.status === "ready");
  const canEnable = config?.settings.cursorKeychainUsageEnabled === false;
  const reports = [
    ...cursor,
    ...(config?.usageLimitSources ?? []).flatMap(({ accounts }) =>
      accounts.filter(({ driver }) => driver === "cursor"),
    ),
  ];
  return {
    keychain:
      canEnable &&
      ready.some(({ cursorKeychainUsageAvailable }) => cursorKeychainUsageAvailable === true)
        ? ("available" as const)
        : canEnable &&
            ready.some(
              ({ cursorKeychainUsageAvailable }) => cursorKeychainUsageAvailable === undefined,
            )
          ? ("legacy" as const)
          : ("unavailable" as const),
    readsCursorAccount: reports.some(
      ({ usageLimits }) =>
        usageLimits !== undefined &&
        usageLimits.unavailable === undefined &&
        usageLimits.windows.length > 0,
    ),
  };
}

export function needsCursorKeychainAccess(
  access: ReturnType<typeof cursorUsageAccess>,
  summary: UsageSummary | null,
): boolean {
  return (
    access.keychain === "available" ||
    (access.keychain === "legacy" &&
      summary?.sources.some(({ action }) => action === "enableCursorKeychain") === true)
  );
}

/**
 * Any environment reading a Cursor account already reports that account's
 * history from every machine, so the prompt only adds duplicates there.
 */
export function cursorKeychainAccessEnvironments<
  E extends {
    readonly summary: UsageSummary | null;
    readonly needsCursorKeychainAccess: boolean;
    readonly readsCursorAccount?: boolean;
  },
>(environments: readonly E[]): readonly E[] {
  const hasCursorAccount = environments.some(
    (environment) =>
      environment.readsCursorAccount ||
      environment.summary?.sources.some(
        (source) =>
          source.fingerprint.provider === "cursor" && source.fingerprint.hostId === "cursor.com",
      ),
  );
  return hasCursorAccount
    ? []
    : environments.filter((environment) => environment.needsCursorKeychainAccess);
}

/** The Usage tab asks each environment with that environment's configured model filter. */
export function usageSummaryInput(
  input: UsageSummaryInput,
  modelFilter: UsageModelFilter | undefined,
): UsageSummaryInput {
  return modelFilter === undefined ? input : { ...input, modelFilter };
}

const limitsRefreshAfter = new Map<EnvironmentId, number>();
const limitsRefreshes = new Map<EnvironmentId, Promise<unknown>>();

export async function refreshUsageLimits<A>(
  environmentId: EnvironmentId,
  refresh: () => Promise<A>,
  automatic = false,
  afterPending = false,
): Promise<A | undefined> {
  const pending = limitsRefreshes.get(environmentId);
  if (pending !== undefined) {
    if (afterPending) {
      try {
        await pending;
      } catch {}
      return refreshUsageLimits(environmentId, refresh, false, true);
    }
    return automatic ? undefined : ((await pending) as A);
  }
  const refreshAfter = limitsRefreshAfter.get(environmentId) ?? 0;
  // @effect-diagnostics-next-line globalDate:off
  if (automatic && Date.now() < refreshAfter) return;
  const current = Promise.resolve()
    .then(refresh)
    .finally(() => {
      limitsRefreshes.delete(environmentId);
      // @effect-diagnostics-next-line globalDate:off
      limitsRefreshAfter.set(environmentId, Date.now() + 5 * 60_000);
    });
  limitsRefreshes.set(environmentId, current);
  return await current;
}

export async function refreshUsage({
  registry,
  server,
  presentations,
  environmentIds,
  input,
}: {
  registry: AtomRegistry.AtomRegistry;
  server: Pick<
    ReturnType<typeof createServerEnvironmentAtoms>,
    "usageSummary" | "refreshUsageRates" | "usageModelFilterAtom"
  >;
  presentations: Pick<ReturnType<typeof createEnvironmentPresentationAtoms>, "presentationAtom">;
  environmentIds: readonly EnvironmentId[];
  input: UsageSummaryInput;
}): Promise<void> {
  await Promise.all(
    environmentIds.map(async (environmentId) => {
      const query = server.usageSummary({
        environmentId,
        input: usageSummaryInput(input, registry.get(server.usageModelFilterAtom(environmentId))),
      });
      const presentation = presentations.presentationAtom(environmentId);
      const controller = new AbortController();
      const abortWhenDisconnected = () => {
        if (registry.get(presentation)?.connection.phase !== "connected") controller.abort();
      };
      const unsubscribe = registry.subscribe(presentation, abortWhenDisconnected);
      abortWhenDisconnected();
      changeUsageRefreshCount(registry, environmentId, 1);
      try {
        const ratesResult = await runAtomCommand(
          registry,
          server.refreshUsageRates,
          { environmentId, input: {} },
          { reportFailure: false },
        );
        const sessionUnavailable =
          ratesResult._tag === "Failure" &&
          isEnvironmentRpcUnavailable(squashAtomCommandFailure(ratesResult));
        registry.refresh(query);
        if (sessionUnavailable || controller.signal.aborted) return;
        await executeAtomQuery(registry, query, {
          reportFailure: false,
          signal: controller.signal,
        });
      } finally {
        unsubscribe();
        changeUsageRefreshCount(registry, environmentId, -1);
      }
    }),
  );
}

const usageRefreshCountsAtom = Atom.make<ReadonlyMap<EnvironmentId, number>>(new Map()).pipe(
  Atom.withLabel("usage-manual-refresh-counts"),
);

export const usageRefreshingEnvironmentIdsAtom = usageRefreshCountsAtom.pipe(
  Atom.map((counts) => new Set(counts.keys())),
  Atom.withLabel("usage-refreshing-environments"),
);

function changeUsageRefreshCount(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  delta: 1 | -1,
) {
  const counts = new Map(registry.get(usageRefreshCountsAtom));
  const next = (counts.get(environmentId) ?? 0) + delta;
  if (next > 0) counts.set(environmentId, next);
  else counts.delete(environmentId);
  registry.set(usageRefreshCountsAtom, counts);
}
