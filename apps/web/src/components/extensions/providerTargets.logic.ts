import type { EnvironmentId } from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { providerNamingByInstance, type ProviderNaming } from "./providerNaming";

export type ProviderCapability = "supportsPlugins" | "supportsMcpServers";

export interface ProviderTarget {
  /** Unique across machines. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  /** The account the page talks to. */
  readonly provider: ProviderInstanceEntry;
  /** Every account that shares this config, `provider` first. */
  readonly accounts: ReadonlyArray<ProviderInstanceEntry>;
  readonly naming: ProviderNaming;
  /** The provider and account, plus the machine when there are several. For prose and dialogs. */
  readonly label: string;
}

export interface ProviderMachine<M> {
  readonly machine: M;
  readonly targets: ReadonlyArray<ProviderTarget>;
}

interface MachineLike {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/**
 * Each machine's providers that support `capability`. Accounts that share a home also share their
 * plugins and MCP servers, so they become one target named by the provider alone, unless
 * `mergeAccounts` says that machine keeps something per account, such as MCP sign-ins.
 * Machines without such a provider are left out.
 */
export function buildProviderMachines<M extends MachineLike>(input: {
  readonly machines: ReadonlyArray<M>;
  readonly entriesByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<ProviderInstanceEntry>>;
  readonly capability: ProviderCapability;
  readonly mergeAccounts: (environmentId: EnvironmentId) => boolean;
}): ReadonlyArray<ProviderMachine<M>> {
  const grouped = input.machines.map((machine) => {
    const merge = input.mergeAccounts(machine.environmentId);
    const groups = new Map<string, Array<ProviderInstanceEntry>>();
    for (const entry of input.entriesByEnvironment.get(machine.environmentId) ?? []) {
      if (!entry.enabled || !entry.installed || entry.snapshot[input.capability] !== true) continue;
      const home = merge ? (entry.continuationGroupKey ?? entry.instanceId) : entry.instanceId;
      const key = `${entry.driverKind}\u0000${home}`;
      const group = groups.get(key);
      if (group) group.push(entry);
      else groups.set(key, [entry]);
    }
    return { machine, groups: [...groups.values()] };
  });
  // Only the account that represents each group is named, so merged accounts read as one provider.
  const naming = providerNamingByInstance(
    grouped.flatMap(({ groups }) => groups.map((accounts) => accounts[0]!)),
  );
  const multipleMachines = grouped.filter(({ groups }) => groups.length > 0).length > 1;
  return grouped
    .filter(({ groups }) => groups.length > 0)
    .map(({ machine, groups }) => ({
      machine,
      targets: groups.map((accounts): ProviderTarget => {
        const provider = accounts[0]!;
        const providerNaming = naming.get(provider.instanceId) ?? {
          driverLabel: provider.displayName,
          account: null,
          title: provider.displayName,
        };
        return {
          key: `${machine.environmentId}:${provider.instanceId}`,
          environmentId: machine.environmentId,
          provider,
          accounts,
          naming: providerNaming,
          label: multipleMachines
            ? `${providerNaming.title} on ${machine.label}`
            : providerNaming.title,
        };
      }),
    }));
}

/** The remembered machine while it is still listed, otherwise the first one (this machine). */
export function pickProviderMachine<M extends MachineLike>(
  machines: ReadonlyArray<ProviderMachine<M>>,
  remembered: string | null,
): ProviderMachine<M> | null {
  return (
    machines.find(({ machine }) => machine.environmentId === remembered) ?? machines[0] ?? null
  );
}

/**
 * The remembered provider on the chosen machine. Instance ids repeat across machines, so a choice
 * made on one machine carries over; failing that, the same kind of provider, then the first.
 */
export function pickProviderTarget(
  targets: ReadonlyArray<ProviderTarget>,
  remembered: { readonly instanceId: string; readonly driverKind: string } | null,
): ProviderTarget | null {
  if (remembered === null) return targets[0] ?? null;
  return (
    targets.find((target) =>
      target.accounts.some((account) => account.instanceId === remembered.instanceId),
    ) ??
    targets.find((target) => target.provider.driverKind === remembered.driverKind) ??
    targets[0] ??
    null
  );
}
