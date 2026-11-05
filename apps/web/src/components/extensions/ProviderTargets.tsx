import { connectionMayStillAnswer } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { t, tn } from "~/i18n";
import { useEnvironmentProviderEntries } from "../../hooks/useEnvironmentProviderEntries";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import type { SidebarMachine } from "../sidebar/SidebarFolderHeader";
import { useSidebarMachines } from "../sidebar/useSidebarMachines";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { providerNamingByInstance } from "./providerNaming";
import {
  buildProviderMachines,
  pickProviderMachine,
  pickProviderTarget,
  type ProviderCapability,
  type ProviderMachine,
  type ProviderTarget,
} from "./providerTargets.logic";

export type { ProviderTarget } from "./providerTargets.logic";

export type ProviderTargetMachine = ProviderMachine<SidebarMachine>;

const REMEMBERED_TARGET_KEY = "t3code:extensions:provider-target";
const RememberedTarget = Schema.Struct({
  machine: Schema.NullOr(Schema.String),
  instanceId: Schema.NullOr(Schema.String),
  driverKind: Schema.NullOr(Schema.String),
});
const NOTHING_REMEMBERED = { machine: null, instanceId: null, driverKind: null };

/**
 * The machines with a provider that supports `capability`, the chosen machine, and the chosen
 * provider on it. Plugins and MCP servers share the remembered choice, so switching tabs or
 * leaving the page keeps it.
 */
export function useProviderTargets(capability: ProviderCapability) {
  const { environments, isReady } = useEnvironments();
  const sidebarMachines = useSidebarMachines();
  const providerEntries = useEnvironmentProviderEntries();
  const [remembered, setRemembered] = useLocalStorage(
    REMEMBERED_TARGET_KEY,
    NOTHING_REMEMBERED,
    RememberedTarget,
  );
  const machines = buildProviderMachines({
    machines: sidebarMachines,
    entriesByEnvironment: new Map(
      providerEntries.map(({ environmentId, entries }) => [environmentId, entries]),
    ),
    capability,
  });
  const machine = pickProviderMachine(machines, remembered.machine);
  const target = machine
    ? pickProviderTarget(
        machine.targets,
        remembered.instanceId !== null && remembered.driverKind !== null
          ? { instanceId: remembered.instanceId, driverKind: remembered.driverKind }
          : null,
      )
    : null;
  // Providers arrive with each machine's config; until one answers, none is not "no provider".
  const connecting =
    machine === null &&
    (!isReady ||
      environments.some(
        (environment) =>
          environment.serverConfig === null &&
          connectionMayStillAnswer(environment.connection.phase),
      ));
  return {
    machines,
    machine,
    target,
    connecting,
    selectMachine: (environmentId: EnvironmentId) =>
      setRemembered((current) => ({ ...current, machine: environmentId })),
    selectTarget: (chosen: ProviderTarget) =>
      setRemembered({
        machine: chosen.environmentId,
        instanceId: chosen.provider.instanceId,
        driverKind: chosen.provider.driverKind,
      }),
  };
}

function MachineName(props: { readonly machine: SidebarMachine }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <EnvironmentMachineIcon
        aria-hidden
        kind={props.machine.machineKind}
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 truncate">{props.machine.label}</span>
      {props.machine.disconnected ? (
        <span className="shrink-0 text-muted-foreground text-xs">{t("Offline")}</span>
      ) : null}
    </span>
  );
}

/** Picks the machine whose providers the page manages; renders nothing with only one. */
export function MachinePicker(props: {
  readonly machines: ReadonlyArray<ProviderTargetMachine>;
  readonly machine: ProviderTargetMachine;
  readonly onSelect: (environmentId: EnvironmentId) => void;
}) {
  if (props.machines.length < 2) return null;
  return (
    <div className="w-36 sm:w-48">
      <Select
        value={props.machine.machine.environmentId}
        onValueChange={(next) => {
          const chosen = props.machines.find(({ machine }) => machine.environmentId === next);
          if (chosen) props.onSelect(chosen.machine.environmentId);
        }}
      >
        <SelectTrigger size="sm" aria-label={t("Machine")}>
          <SelectValue>{() => <MachineName machine={props.machine.machine} />}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {props.machines.map(({ machine }) => (
            <SelectItem key={machine.environmentId} value={machine.environmentId}>
              <MachineName machine={machine} />
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

/** Picks which provider on the machine to manage; renders nothing when there is only one. */
export function ProviderTargetToggle(props: {
  readonly targets: ReadonlyArray<ProviderTarget>;
  readonly target: ProviderTarget;
  readonly onSelect: (target: ProviderTarget) => void;
}) {
  if (props.targets.length < 2) return null;
  return (
    <ToggleGroup
      aria-label={t("Provider")}
      className="max-w-full overflow-x-auto"
      value={[props.target.key]}
      onValueChange={(next) => {
        // Pressing the chosen provider again reports no value; the choice stays.
        const chosen = props.targets.find((candidate) => candidate.key === next[0]);
        if (chosen) props.onSelect(chosen);
      }}
    >
      {props.targets.map((candidate) => (
        <Toggle key={candidate.key} value={candidate.key}>
          <ProviderTargetIcon target={candidate} />
          <span className="truncate">{candidate.naming.driverLabel}</span>
          {candidate.naming.account ? (
            <span className="truncate font-normal text-muted-foreground">
              {candidate.naming.account}
            </span>
          ) : null}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

export function ProviderTargetIcon(props: { readonly target: ProviderTarget }) {
  const { provider } = props.target;
  return (
    <ProviderInstanceIcon
      driverKind={provider.driverKind}
      displayName={provider.displayName}
      accentColor={provider.accentColor}
      acpRegistryIconUrl={provider.acpRegistryIconUrl}
      size="compact"
    />
  );
}

/** "2 accounts", explaining that the accounts share one setup; nothing for a single account. */
export function ProviderTargetAccounts(props: { readonly target: ProviderTarget }) {
  const { accounts, naming } = props.target;
  if (accounts.length < 2) return null;
  const names = accounts.map((account) => account.displayName);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="shrink-0 font-normal text-muted-foreground text-xs underline decoration-dotted underline-offset-2" />
        }
      >
        {tn(accounts.length, "{count} account", "{count} accounts")}
      </TooltipTrigger>
      <TooltipPopup>
        {t("{names} share one {driver} setup, so changes here apply to each.", {
          names: names.join(", "),
          driver: naming.driverLabel,
        })}
      </TooltipPopup>
    </Tooltip>
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
        <span className="font-normal text-muted-foreground">
          {" · "}
          {naming.account}
        </span>
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
