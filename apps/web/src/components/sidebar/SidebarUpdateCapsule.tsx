import { useAtomValue } from "@effect/atom-react";
import { type ReactNode, useSyncExternalStore } from "react";

import { cn } from "~/lib/utils";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { environmentUpdateStatesAtom } from "~/state/server";
import { decideRestartHold } from "@t3tools/client-runtime/state/server";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useServerUpdate } from "../ServerUpdateAction";
import { waitingOnWorkLabel } from "../restartHold.logic";
import {
  decideHostedRestartHold,
  usePendingLocalInstall,
  usePendingLocalInstallWork,
} from "./localInstallWait";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  describeUpdateCapsule,
  formatUpdateElapsed,
  RUN_STATUS_LABELS,
  resolveUpdateRunMachineStatus,
  type UpdateEverythingRun,
  type UpdateRunLocalState,
  type UpdateRunMachineView,
} from "./updateEverything.logic";
import {
  dismissSettledUpdateRunMachines,
  postponeUpdateRestart,
  retryFailedUpdateRunServers,
} from "./updateEverythingRun";

import { t } from "~/i18n";
function useNow(intervalMs: number | null): number {
  const step = intervalMs ?? 60_000;
  const subscribe = (onChange: () => void) => {
    if (intervalMs === null) return () => {};
    const timer = setInterval(onChange, intervalMs);
    return () => clearInterval(timer);
  };
  return useSyncExternalStore(subscribe, () => Math.floor(Date.now() / step) * step);
}

function useUpdateRunMachineViews(run: UpdateEverythingRun): ReadonlyArray<UpdateRunMachineView> {
  const updateStates = useAtomValue(
    environmentUpdateStatesAtom(
      environmentIdsKey(run.machines.map(({ environmentId }) => environmentId)),
    ),
  );
  return run.machines.map((machine, index) => ({
    machine,
    status: resolveUpdateRunMachineStatus(machine, run.phase, updateStates[index]!),
  }));
}

function localStatusLabel(
  run: UpdateEverythingRun,
  local: UpdateRunLocalState,
  now: number,
  waitingOn: number | null,
) {
  if (run.phase === "countdown" && run.restartAt !== null) {
    return t("restarts in {seconds}s", {
      seconds: Math.max(0, Math.ceil((run.restartAt - now) / 1000)),
    });
  }
  if (run.phase === "installing") {
    return waitingOn === null ? t("restarting") : waitingOnWorkLabel(waitingOn);
  }
  if (local?.status === "downloading") {
    return local.percent === null
      ? t("downloading")
      : t("downloading {percent}%", { percent: Math.floor(local.percent) });
  }
  return t("restarts after the servers");
}

export function SidebarUpdateCapsule({
  run,
  local,
  icon,
  onRestart,
}: {
  readonly run: UpdateEverythingRun;
  readonly local: UpdateRunLocalState;
  readonly icon: ReactNode;
  readonly onRestart?: () => Promise<void>;
}) {
  const machines = useUpdateRunMachineViews(run);
  const pendingInstall = usePendingLocalInstall();
  const pendingWork = usePendingLocalInstallWork();
  const localWaitingOn = pendingInstall === null ? null : pendingWork.length;
  const hasActiveMachine = machines.some(
    ({ status }) => status !== "done" && status !== "failed" && status !== "waiting",
  );
  const now = useNow(run.phase === "countdown" ? 1_000 : hasActiveMachine ? 30_000 : null);
  const view = describeUpdateCapsule(run, machines, local, now, localWaitingOn);
  const updateServer = useServerUpdate();
  const failed = machines.some(({ status }) => status === "failed");
  const settled = !hasActiveMachine && run.localVersion === null;

  const actionLabel =
    view.action === "later" ? t("Later") : view.action === "retry" ? t("Retry") : t("Dismiss");
  const runAction = () => {
    if (view.action === "later") postponeUpdateRestart();
    else if (view.action === "retry") retryFailedUpdateRunServers(updateServer);
    else dismissSettledUpdateRunMachines();
  };

  return (
    <Popover>
      <div
        className={cn(
          "relative flex h-8 flex-1 items-center rounded-full bg-sidebar-control-surface text-sidebar-foreground",
          view.tone === "slow" && "ring-1 ring-warning/40 ring-inset",
          view.tone === "failed" && "ring-1 ring-destructive/40 ring-inset",
        )}
      >
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={
                view.slow
                  ? t("{label} {status} {elapsed}", {
                      label: view.label,
                      status: view.slow.status,
                      elapsed: view.slow.elapsed,
                    })
                  : view.label
              }
              className="absolute inset-0 cursor-pointer rounded-full outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset"
            />
          }
        />
        {/* w-0 keeps the label out of the capsule's minimum width, so a shared footer row
            can squeeze the label but never push the action past the sidebar edge. */}
        <span className="pointer-events-none relative w-0 min-w-0 flex-1 truncate pl-3 text-xs">
          <span className={cn(view.tone === "failed" && "text-destructive-foreground")}>
            {view.label}
          </span>
          {view.slow ? (
            <span className="text-warning tabular-nums"> {view.slow.elapsed}</span>
          ) : null}
        </span>
        {view.action !== null ? (
          <button
            type="button"
            className="relative shrink-0 cursor-pointer pr-3 pl-1.5 text-xs underline decoration-muted-foreground/60 underline-offset-3 hover:decoration-current"
            onClick={runAction}
          >
            {actionLabel}
          </button>
        ) : (
          <span className="pointer-events-none relative grid size-8 shrink-0 place-items-center">
            {icon}
          </span>
        )}
      </div>
      <PopoverPopup side="top" align="end" padding="compact" width="sm">
        <div className="flex flex-col gap-1 text-xs">
          {run.localVersion !== null ? (
            <div className="flex items-center justify-between gap-3">
              <span>{t("This app")}</span>
              <span className="text-muted-foreground tabular-nums">
                {localStatusLabel(run, local, now, localWaitingOn)}
              </span>
            </div>
          ) : onRestart ? (
            <div className="flex items-center justify-between gap-3">
              <span>{t("This app")}</span>
              <Button size="xs" variant="outline" onClick={() => void onRestart()}>
                {t("Restart to update")}
              </Button>
            </div>
          ) : null}
          {localWaitingOn !== null ? (
            <div className="flex justify-end gap-1">
              <Button size="xs" variant="ghost" onClick={() => decideHostedRestartHold("cancel")}>
                {t("Stop waiting")}
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => decideHostedRestartHold("update-now")}
              >
                {t("Update now")}
              </Button>
            </div>
          ) : null}
          {machines.map(({ machine, status }) => (
            <div key={machine.environmentId} className="flex min-w-0 flex-col">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate">{machine.label}</span>
                <span
                  className={cn(
                    "shrink-0 tabular-nums",
                    status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
                  )}
                >
                  {t(RUN_STATUS_LABELS[status])}
                  {status !== "done" && status !== "failed" && status !== "waiting"
                    ? ` ${formatUpdateElapsed(now - machine.startedAt)}`
                    : ""}
                </span>
              </div>
              {status === "background-work" ? (
                <div className="flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      decideRestartHold(appAtomRegistry, machine.environmentId, "update-now")
                    }
                  >
                    {t("Update now")}
                  </Button>
                </div>
              ) : null}
              {machine.failure !== null ? (
                <span className="break-words text-muted-foreground">{machine.failure}</span>
              ) : null}
            </div>
          ))}
          {settled && failed ? (
            <div className="mt-1 flex justify-end gap-1">
              {view.action === "retry" ? (
                <Button size="xs" variant="outline" onClick={runAction}>
                  {t("Retry")}
                </Button>
              ) : null}
              <Button size="xs" variant="ghost" onClick={dismissSettledUpdateRunMachines}>
                {t("Dismiss")}
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
