import { useAtomValue } from "@effect/atom-react";
import {
  describeCpu,
  describeFreeSpace,
  describeUptime,
  describeUsedSpace,
  presentHostResources,
  resourceTone,
  type HostResourcesView,
  type ResourceTone,
} from "@t3tools/client-runtime/host-resources";
import type { EnvironmentId } from "@t3tools/contracts";
import { formatPercent } from "@t3tools/shared/usageFormat";
import { useSyncExternalStore, type ReactNode } from "react";

import { useReconnectEnvironment } from "../../hooks/useReconnectEnvironment";
import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { MachineBadge, MachineLastSeen } from "../MachineBadge";
import type { SidebarMachine } from "../sidebar/SidebarFolderHeader";
import { machineStateLabel } from "../sidebar/SidebarMachineStrip";
import { useSidebarMachines } from "../sidebar/useSidebarMachines";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { t } from "~/i18n";

const FILL_CLASS_NAME: Record<ResourceTone, string> = {
  default: "bg-foreground/72",
  warning: "bg-warning",
  error: "bg-error",
};

const TEXT_CLASS_NAME: Record<ResourceTone, string> = {
  default: "text-foreground",
  warning: "text-warning-foreground",
  error: "text-destructive-foreground",
};

/** Polls the machine every few seconds while mounted; null until the first answer. */
function useLiveHostResources(environmentId: EnvironmentId) {
  const result = useAtomValue(serverEnvironment.liveHostResources({ environmentId, input: {} }));
  if (result._tag === "Success") {
    return { view: presentHostResources(result.value), failed: false };
  }
  return { view: null, failed: result._tag === "Failure" };
}

function MeterRow(props: {
  readonly label: string;
  readonly fraction: number | null;
  readonly value: string;
  readonly detail?: ReactNode;
}) {
  const tone = resourceTone(props.fraction);
  const percent = props.fraction === null ? null : Math.min(100, props.fraction * 100);
  return (
    <>
      <span className="text-muted-foreground">{props.label}</span>
      {percent === null ? (
        <span className="h-1.5 rounded-full bg-muted" aria-hidden />
      ) : (
        <span
          role="meter"
          aria-label={props.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          aria-valuetext={props.value}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <span
            className={cn("block h-full rounded-full", FILL_CLASS_NAME[tone])}
            style={{ width: `${percent}%` }}
          />
        </span>
      )}
      <span className={cn("text-end whitespace-nowrap tabular-nums", TEXT_CLASS_NAME[tone])}>
        {props.value}
      </span>
      {props.detail ? (
        <span className="col-span-2 col-start-2 -mt-1.5 text-muted-foreground tabular-nums">
          {props.detail}
        </span>
      ) : null}
    </>
  );
}

function ResourceMeters(props: { readonly view: HostResourcesView; readonly narrow: boolean }) {
  const { view } = props;
  const notReported = t("Not reported");
  return (
    <div
      className={cn(
        "grid items-center gap-y-2.5 text-xs",
        // A side panel is too narrow for the fixed label column, so labels and values take their width.
        props.narrow
          ? "grid-cols-[auto_minmax(2rem,1fr)_auto] gap-x-2"
          : "grid-cols-[4.5rem_minmax(3rem,1fr)_auto] gap-x-3",
      )}
    >
      <MeterRow
        label={t("CPU")}
        fraction={view.cpuFraction}
        value={view.cpuFraction === null ? notReported : formatPercent(view.cpuFraction, 0)}
        detail={describeCpu(view)}
      />
      <MeterRow
        label={t("Memory")}
        fraction={view.memory?.fraction ?? null}
        value={view.memory ? describeUsedSpace(view.memory) : notReported}
      />
      {view.swap ? (
        <MeterRow
          label={t("Swap")}
          fraction={view.swap.totalBytes > 0 ? view.swap.fraction : null}
          value={view.swap.totalBytes > 0 ? describeUsedSpace(view.swap) : t("None in use")}
        />
      ) : null}
      <MeterRow
        label={t("Disk")}
        fraction={view.disk?.fraction ?? null}
        value={view.disk ? describeFreeSpace(view.disk) : notReported}
      />
    </div>
  );
}

function ConnectedMachineResources(props: {
  readonly environmentId: EnvironmentId;
  readonly narrow?: boolean;
}) {
  const { view, failed } = useLiveHostResources(props.environmentId);
  if (view) return <ResourceMeters view={view} narrow={props.narrow ?? false} />;
  if (failed) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("Couldn't read this machine's resources.")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-full" />
    </div>
  );
}

/** Only a connected machine answers; one still connecting would leave its meters loading. */
function machineAnswersLoad(machine: Pick<SidebarMachine, "availability">): boolean {
  return machine.availability === "live";
}

function GlanceValue(props: { readonly label: string; readonly fraction: number | null }) {
  if (props.fraction === null) return null;
  return (
    <span>
      {props.label}{" "}
      <span className={cn("tabular-nums", TEXT_CLASS_NAME[resourceTone(props.fraction)])}>
        {formatPercent(props.fraction, 0)}
      </span>
    </span>
  );
}

function GlanceRow(props: { readonly machine: SidebarMachine }) {
  const { machine } = props;
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
        <MachineBadge environmentId={machine.environmentId} label={machine.label} />
        <span className="truncate">{machine.label}</span>
      </span>
      {machineAnswersLoad(machine) ? (
        <ConnectedGlanceValues environmentId={machine.environmentId} />
      ) : (
        <span className="text-muted-foreground">{machineStateLabel(machine)}</span>
      )}
    </li>
  );
}

function ConnectedGlanceValues(props: { readonly environmentId: EnvironmentId }) {
  const { view, failed } = useLiveHostResources(props.environmentId);
  if (!view) {
    return (
      <span className="text-muted-foreground">
        {failed ? t("Couldn't read this machine's resources.") : t("Loading…")}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap gap-x-2 text-muted-foreground">
      <GlanceValue label={t("CPU")} fraction={view.cpuFraction} />
      <GlanceValue label={t("Memory")} fraction={view.memory?.fraction ?? null} />
      <GlanceValue label={t("Disk")} fraction={view.disk?.fraction ?? null} />
    </span>
  );
}

/** The rail tooltip; it mounts only while open, so machines are polled only then. */
export function MachinesGlance(props: { readonly machines: readonly SidebarMachine[] }) {
  return (
    <div className="flex w-64 max-w-full flex-col gap-2 py-1">
      <span className="font-medium text-foreground">{t("Machines")}</span>
      <ul className="flex flex-col gap-2">
        {props.machines.map((machine) => (
          <GlanceRow key={machine.environmentId} machine={machine} />
        ))}
      </ul>
    </div>
  );
}

function MachineUptime(props: { readonly environmentId: EnvironmentId }) {
  const { view } = useLiveHostResources(props.environmentId);
  return view?.uptimeSeconds == null ? null : ` · ${describeUptime(view.uptimeSeconds)}`;
}

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** A background tab or minimized window shows nothing, so its machines are not polled. */
function usePageVisible() {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible");
}

/** True while the machine is connected and the page is visible, the only time its load is polled. */
export function useMachineLoadPollable(environmentId: EnvironmentId): boolean {
  const machine = useSidebarMachines().find((entry) => entry.environmentId === environmentId);
  const pageVisible = usePageVisible();
  return machine !== undefined && machineAnswersLoad(machine) && pageVisible;
}

/** One machine's meters for a narrow side panel, without the card around them; mount only while it is pollable. */
export function MachineLoadMeters(props: { readonly environmentId: EnvironmentId }) {
  return <ConnectedMachineResources environmentId={props.environmentId} narrow />;
}

export function MachineResourcesCard(props: { readonly machine: SidebarMachine }) {
  const { machine } = props;
  const reconnect = useReconnectEnvironment();
  const pageVisible = usePageVisible();
  const polling = machineAnswersLoad(machine) && pageVisible;
  return (
    <section
      aria-label={machine.label}
      className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 text-card-foreground"
    >
      <header className="flex min-w-0 items-start gap-2.5">
        <MachineBadge
          environmentId={machine.environmentId}
          label={machine.label}
          className="mt-0.5"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="truncate text-sm font-medium text-foreground">{machine.label}</h2>
          {machine.disconnected ? (
            <p className="text-xs text-warning-foreground">
              {machineStateLabel(machine)}
              {machine.lastSeenAt !== null ? (
                <>
                  {" · "}
                  <MachineLastSeen lastSeenAt={machine.lastSeenAt} />
                </>
              ) : null}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {machineStateLabel(machine)}
              {polling ? <MachineUptime environmentId={machine.environmentId} /> : null}
            </p>
          )}
        </div>
        {machine.disconnected ? (
          <Button size="xs" variant="outline" onClick={() => void reconnect(machine.environmentId)}>
            {machine.enabled ? t("Reconnect") : t("Switch on")}
          </Button>
        ) : null}
      </header>
      {polling ? <ConnectedMachineResources environmentId={machine.environmentId} /> : null}
    </section>
  );
}
