import { connectionMayStillAnswer } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentProviderEntries } from "../../hooks/useEnvironmentProviderEntries";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { settingsScopeEnvironmentLabel } from "../settings/settingsScopeAxis";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { providerNamingByInstance, type ProviderNaming } from "./providerNaming";

export interface ProviderTarget {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly provider: ProviderInstanceEntry;
  readonly naming: ProviderNaming;
  /** Set only when more than one machine is connected. */
  readonly machine: string | null;
  /** The provider, account, and machine in one line, for prose and dialogs. */
  readonly label: string;
}

/** The provider instances that support one capability, across every machine, and the chosen one. */
export function useProviderTargets(capability: "supportsPlugins" | "supportsMcpServers") {
  const { environments, isReady } = useEnvironments();
  const providerEntries = useEnvironmentProviderEntries();
  const naming = providerNamingByInstance(providerEntries.flatMap(({ entries }) => entries));
  const multipleEnvironments = providerEntries.length > 1;
  const targets = providerEntries.flatMap(({ environmentId, entries }): ProviderTarget[] => {
    const environment = environments.find((candidate) => candidate.environmentId === environmentId);
    const machine =
      multipleEnvironments && environment
        ? settingsScopeEnvironmentLabel(environment, environments)
        : null;
    return entries
      .filter((entry) => entry.enabled && entry.installed && entry.snapshot[capability] === true)
      .map((provider) => {
        const providerNaming = naming.get(provider.instanceId) ?? {
          driverLabel: provider.displayName,
          account: null,
          title: provider.displayName,
        };
        return {
          key: `${environmentId}:${provider.instanceId}`,
          environmentId,
          provider,
          naming: providerNaming,
          machine,
          label: machine ? `${providerNaming.title} · ${machine}` : providerNaming.title,
        };
      });
  });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const target = targets.find((candidate) => candidate.key === selectedKey) ?? targets[0] ?? null;
  // Providers arrive with each machine's config; until one answers, none is not "no provider".
  const connecting =
    target === null &&
    (!isReady ||
      environments.some(
        (environment) =>
          environment.serverConfig === null &&
          connectionMayStillAnswer(environment.connection.phase),
      ));
  return { targets, target, setSelectedKey, connecting };
}

/** Picks which provider instance to manage; renders nothing when there is only one. */
export function ProviderTargetToggle(props: {
  readonly targets: ReadonlyArray<ProviderTarget>;
  readonly target: ProviderTarget;
  readonly onSelect: (key: string) => void;
}) {
  if (props.targets.length < 2) return null;
  return (
    <ToggleGroup
      aria-label="Provider"
      className="max-w-full overflow-x-auto"
      value={[props.target.key]}
      onValueChange={(next) => {
        // Pressing the chosen provider again reports no value; the choice stays.
        if (next[0] !== undefined) props.onSelect(next[0]);
      }}
    >
      {props.targets.map((candidate) => {
        const secondary = [candidate.naming.account, candidate.machine]
          .filter((part) => part !== null)
          .join(" · ");
        return (
          <Toggle key={candidate.key} value={candidate.key}>
            <ProviderInstanceIcon
              driverKind={candidate.provider.driverKind}
              displayName={candidate.provider.displayName}
              accentColor={candidate.provider.accentColor}
              acpRegistryIconUrl={candidate.provider.acpRegistryIconUrl}
              size="compact"
            />
            <span className="truncate">{candidate.naming.driverLabel}</span>
            {secondary ? (
              <span className="truncate font-normal text-muted-foreground">{secondary}</span>
            ) : null}
          </Toggle>
        );
      })}
    </ToggleGroup>
  );
}

/** A provider instance's name with its account as secondary text. */
export function ProviderName(props: { readonly provider: ProviderInstanceEntry }) {
  const providerEntries = useEnvironmentProviderEntries();
  const naming = providerNamingByInstance(providerEntries.flatMap(({ entries }) => entries)).get(
    props.provider.instanceId,
  );
  if (!naming) return <span className="min-w-0 truncate">{props.provider.displayName}</span>;
  return (
    <span className="min-w-0 truncate">
      {naming.driverLabel}
      {naming.account ? (
        <span className="font-normal text-muted-foreground"> · {naming.account}</span>
      ) : null}
    </span>
  );
}

export function ProviderListSkeleton(props: { readonly label: string }) {
  return (
    <div role="status" aria-label={props.label} className="divide-y rounded-lg border">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex flex-col gap-2 px-4 py-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ))}
    </div>
  );
}
