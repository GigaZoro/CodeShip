import type { ProviderInstanceEntry } from "../../providerInstances";
import { providerClients } from "../settings/providerDriverMeta";

export interface ProviderNaming {
  /** The provider itself, such as "Claude". */
  readonly driverLabel: string;
  /** The instance's own name when the driver has several and this one is not the plain default. */
  readonly account: string | null;
  /** "Claude · akucheri", or just "Claude". */
  readonly title: string;
}

type NamedEntry = Pick<ProviderInstanceEntry, "instanceId" | "driverKind" | "displayName">;

/**
 * Names each instance by its provider first. An instance's own display name is often an account
 * handle, so it only follows as secondary text, and only when its driver has more than one instance.
 * Instance ids repeat across machines, so they count once.
 */
export function providerNamingByInstance(
  entries: ReadonlyArray<NamedEntry>,
): ReadonlyMap<string, ProviderNaming> {
  const unique = new Map(entries.map((entry) => [entry.instanceId as string, entry] as const));
  const instancesPerDriver = new Map<string, number>();
  for (const { driverKind } of unique.values()) {
    instancesPerDriver.set(driverKind, (instancesPerDriver.get(driverKind) ?? 0) + 1);
  }
  return new Map(
    [...unique].map(([instanceId, entry]) => {
      // A registry agent is named by itself; its driver label is only "ACP".
      const driverLabel =
        entry.driverKind === "acpRegistry"
          ? entry.displayName
          : (providerClients.get(entry.driverKind)?.label ?? entry.displayName);
      const handle = entry.displayName.trim();
      const account =
        (instancesPerDriver.get(entry.driverKind) ?? 0) > 1 &&
        handle !== "" &&
        handle.toLowerCase() !== driverLabel.toLowerCase()
          ? handle
          : null;
      return [
        instanceId,
        { driverLabel, account, title: account ? `${driverLabel} · ${account}` : driverLabel },
      ] as const;
    }),
  );
}
