import { useAtomValue } from "@effect/atom-react";
import { machineAvailabilityLabel } from "@t3tools/client-runtime/connection";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { isThreadWorking, threadAwaitsUser } from "@t3tools/client-runtime/state/thread-inbox";
import {
  collectLimitAccounts,
  collectLimitPools,
  tightestLimitWindow,
} from "@t3tools/shared/usageLimits";
import { memo, useState } from "react";

import { useReconnectEnvironment } from "../../hooks/useReconnectEnvironment";
import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { environmentThreadShells } from "../../state/threads";
import { MachineBadge, MachineLastSeen } from "../MachineBadge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { limitPoolLabel, limitTone, limitWindowLabel } from "../usage/UsageLimitsGlance";
import type { SidebarMachine } from "./SidebarFolderHeader";
import { useSidebarMachines } from "./useSidebarMachines";
import { t, tn } from "~/i18n";

function machineStateLabel(machine: SidebarMachine): string {
  return machine.enabled ? machineAvailabilityLabel(machine.availability) : t("Switched off");
}

/**
 * Every machine at a glance, for users who run more than one. The strip reads only connection
 * state; thread counts and usage limits load while its popover is open.
 */
export const SidebarMachineStrip = memo(function SidebarMachineStrip() {
  const machines = useSidebarMachines();
  if (machines.length < 2) return null;
  // A machine the user switched off is not a problem to report.
  const unreachable = machines.filter((machine) => machine.disconnected && machine.enabled);
  const summary =
    unreachable.length === 0
      ? t("All connected")
      : unreachable.length === 1
        ? t("{name} {state}", {
            name: unreachable[0]!.label,
            state: machineStateLabel(unreachable[0]!).toLocaleLowerCase(),
          })
        : tn(unreachable.length, "{count} unreachable", "{count} unreachable");
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t("Machines: {states}", {
              states: machines
                .map((machine) => `${machine.label} ${machineStateLabel(machine)}`)
                .join(", "),
            })}
            className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-1 rounded-md px-2 text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        {machines.map((machine) => (
          <MachineBadge
            key={machine.environmentId}
            environmentId={machine.environmentId}
            label={machine.label}
            className={cn(machine.disconnected && "opacity-40 grayscale")}
          />
        ))}
        <span
          className={cn(
            "ms-1.5 min-w-0 flex-1 truncate text-xs",
            unreachable.length === 0 ? "text-sidebar-muted-foreground" : "text-sidebar-foreground",
          )}
        >
          {summary}
        </span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" width="md" padding="compact">
        <ul className="flex flex-col gap-1">
          {machines.map((machine) => (
            <MachineStripRow key={machine.environmentId} machine={machine} />
          ))}
        </ul>
      </PopoverPopup>
    </Popover>
  );
});

function MachineStripRow(props: { machine: SidebarMachine }) {
  const { machine } = props;
  const reconnect = useReconnectEnvironment();
  // Mounted when the popover opens, so limits read the clock once per opening.
  const [now] = useState(() => Date.now());
  const threads = useAtomValue(
    environmentThreadShells.environmentThreadsAtom(machine.environmentId),
  );
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const presentation = presentations.get(machine.environmentId);
  const tightest =
    presentation === undefined
      ? null
      : tightestLimitWindow(
          collectLimitPools(
            collectLimitAccounts(new Map([[machine.environmentId, presentation]])),
            now,
          ),
        );
  let working = 0;
  let needsYou = 0;
  for (const raw of threads) {
    if (raw.archivedAt !== null) continue;
    const thread = presentThreadShell(machine.environmentId, raw, null);
    if (threadAwaitsUser(thread)) needsYou += 1;
    else if (isThreadWorking(thread)) working += 1;
  }
  const counts = [
    working > 0 ? tn(working, "{count} working", "{count} working") : null,
    needsYou > 0 ? tn(needsYou, "{count} needs you", "{count} need you") : null,
  ].filter((part) => part !== null);
  return (
    <li className="flex min-w-0 items-start gap-2.5 rounded-md px-1 py-1.5">
      <MachineBadge
        environmentId={machine.environmentId}
        label={machine.label}
        className="mt-0.5"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs">
        <div className="truncate text-sm font-medium text-foreground">{machine.label}</div>
        <div className={machine.disconnected ? "text-warning-foreground" : "text-muted-foreground"}>
          {machineStateLabel(machine)}
          {machine.lastSeenAt !== null ? (
            <>
              {" · "}
              <MachineLastSeen lastSeenAt={machine.lastSeenAt} />
            </>
          ) : null}
        </div>
        {counts.length > 0 ? (
          <div className="text-muted-foreground">
            {machine.disconnected
              ? t("{counts} (last known)", { counts: counts.join(" · ") })
              : counts.join(" · ")}
          </div>
        ) : null}
        {tightest ? (
          <div
            className={cn(
              limitTone(tightest.window.remainingPercent) === "default"
                ? "text-muted-foreground"
                : limitTone(tightest.window.remainingPercent) === "warning"
                  ? "text-warning-foreground"
                  : "text-destructive-foreground",
            )}
          >
            {t("{pool} {window}: {percent}% left", {
              pool: limitPoolLabel(tightest.pool),
              window: limitWindowLabel(tightest.pool, tightest.window),
              percent: tightest.window.remainingPercent,
            })}
          </div>
        ) : null}
      </div>
      {machine.disconnected ? (
        <Button size="xs" variant="outline" onClick={() => void reconnect(machine.environmentId)}>
          {machine.enabled ? t("Reconnect") : t("Switch on")}
        </Button>
      ) : null}
    </li>
  );
}
