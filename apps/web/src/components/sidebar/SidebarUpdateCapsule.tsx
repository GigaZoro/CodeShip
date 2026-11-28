import { t, msg } from "~/i18n";
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
  usePendingLocalInstallTurns,
  usePendingLocalInstallWork,
} from "./localInstallWait";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  describeUpdateCapsule,
  formatUpdateElapsed,
  RUN_STATUS_LABELS,
  resolveRestoredRetry,
  resolveUpdateRunMachineStatus,
  type UpdateEverythingMachine,
  type UpdateEverythingRun,
  type UpdateRunLocalState,
  type UpdateRunMachineView,
} from "./updateEverything.logic";
import {
  dismissSettledUpdateRunMachines,
  postponeUpdateRestart,
  retryFailedUpdateRunServers,
} from "./updateEverythingRun";

function useNow(intervalMs: number | null): number {
  const step = intervalMs ?? 60_000;
  const subscribe = (onChange: () => void) => {
    if (intervalMs === null) return () => {};
    const timer = setInterval(onChange, intervalMs);
    return () => clearInterval(timer);
  };
  return useSyncExternalStore(subscribe, () => Math.floor(Date.now() / step) * step);
}

function useUpdateRunMachineViews(
  run: UpdateEverythingRun,
  current: ReadonlyArray<UpdateEverythingMachine>,
): ReadonlyArray<UpdateRunMachineView> {
  const updateStates = useAtomValue(
    environmentUpdateStatesAtom(
      environmentIdsKey(run.machines.map(({ environmentId }) => environmentId)),
    ),
  );
  return run.machines.map((machine, index) => ({
    machine,
    status: resolveUpdateRunMachineStatus(machine, run.phase, updateStates[index]!),
    restoredRetry: resolveRestoredRetry(machine, current),
  }));
}

function restartSecondsLeft(run: UpdateEverythingRun, now: number): number | null {
  return run.phase === "countdown" && run.restartAt !== null
    ? Math.max(0, Math.ceil((run.restartAt - now) / 1000))
    : null;
}

function localStatusLabel(
  run: UpdateEverythingRun,
  local: UpdateRunLocalState,
  now: number,
  waitingOn: number | null,
  waitingOnTurns = 0,
) {
  const seconds = restartSecondsLeft(run, now);
  if (seconds !== null) return t("restarts in {seconds}s", { seconds });
  if (run.phase === "installing") {
    return waitingOn === null ? t("restarting") : waitingOnWorkLabel(waitingOn, waitingOnTurns);
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
  current,
  local,
  icon,
  onRestart,
}: {
  readonly run: UpdateEverythingRun;
  /** Every server as it is now, to rebuild the retry of a row restored after a relaunch. */
  readonly current: ReadonlyArray<UpdateEverythingMachine>;
  readonly local: UpdateRunLocalState;
  readonly icon: ReactNode;
  readonly onRestart?: () => Promise<void>;
}) {
  const machines = useUpdateRunMachineViews(run, current);
  const pendingInstall = usePendingLocalInstall();
  const pendingWork = usePendingLocalInstallWork();
  const pendingTurns = usePendingLocalInstallTurns();
  const localWaitingOn = pendingInstall === null ? null : pendingWork.length;
  const localWaitingOnTurns = pendingInstall === null ? 0 : pendingTurns.length;
  const hasActiveMachine = machines.some(
    ({ status }) => status !== "done" && status !== "failed" && status !== "waiting",
  );
  const now = useNow(run.phase === "countdown" ? 1_000 : hasActiveMachine ? 30_000 : null);
  const view = describeUpdateCapsule(
    run,
    machines,
    local,
    now,
    localWaitingOn,
    localWaitingOnTurns,
  );
  const updateServer = useServerUpdate();
  const failed = machines.some(({ status }) => status === "failed");
  const settled = !hasActiveMachine && run.localVersion === null;
  const restartSeconds = restartSecondsLeft(run, now);
  const expandedControlClassName =
    restartSeconds === null
      ? "@min-[5rem]/sidebar-update:block"
      : "@min-[12rem]/sidebar-update:block";

  const actionLabel =
    view.action === "later" ? t("Later") : view.action === "retry" ? t("Retry") : t("Dismiss");
  const runAction = () => {
    if (view.action === "later") postponeUpdateRestart();
    else if (view.action === "retry") {
      retryFailedUpdateRunServers(
        updateServer,
        new Map(
          machines.flatMap(({ machine, restoredRetry }) =>
            restoredRetry == null ? [] : [[machine.environmentId, restoredRetry] as const],
          ),
        ),
      );
    } else dismissSettledUpdateRunMachines();
  };

  return (
    <Popover>
      <div
        className={cn(
          "relative ml-auto flex h-8 w-8 shrink-0 items-center justify-end rounded-full bg-sidebar-control-surface text-sidebar-foreground transition-[width] duration-200 ease-out motion-reduce:transition-none",
          restartSeconds === null
            ? "@min-[5rem]/sidebar-update:w-full"
            : "@min-[12rem]/sidebar-update:w-full",
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
        <span
          className={cn(
            "pointer-events-none relative hidden w-0 min-w-0 flex-1 truncate pl-3 text-xs transition-opacity duration-200 ease-out starting:opacity-0 motion-reduce:transition-none",
            expandedControlClassName,
          )}
        >
          <span className={cn(view.tone === "failed" && "text-destructive")}>{view.label}</span>
          {view.slow ? (
            <span className="text-warning tabular-nums"> {view.slow.elapsed}</span>
          ) : null}
        </span>
        {view.action !== null ? (
          <button
            type="button"
            className={cn(
              "relative hidden shrink-0 cursor-pointer pr-3 pl-1.5 text-xs underline decoration-muted-foreground/60 underline-offset-3 hover:decoration-current transition-opacity duration-200 ease-out starting:opacity-0 motion-reduce:transition-none",
              expandedControlClassName,
            )}
            onClick={runAction}
          >
            {actionLabel}
          </button>
        ) : null}
        <span
          className={cn(
            "pointer-events-none relative grid size-8 shrink-0 place-items-center",
            view.action !== null &&
              (restartSeconds === null
                ? "@min-[5rem]/sidebar-update:hidden"
                : "@min-[12rem]/sidebar-update:hidden"),
            restartSeconds !== null &&
              "rounded-full text-xs font-medium tabular-nums ring-1 ring-current/22 ring-inset",
          )}
        >
          {restartSeconds !== null ? t(msg("{seconds}s"), { seconds: restartSeconds }) : icon}
        </span>
      </div>
      <PopoverPopup side="top" align="end" padding="compact" width="sm">
        <div className="flex flex-col gap-1 text-xs">
          {run.localVersion !== null ? (
            <div className="flex items-center justify-between gap-3">
              <span>{t("This app")}</span>
              <span className="text-muted-foreground tabular-nums">
                {localStatusLabel(run, local, now, localWaitingOn, localWaitingOnTurns)}
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
                    ? ` ${formatUpdateElapsed(now - machine.startedAt, t)}`
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
          {view.action !== null ? (
            <div className="mt-1 flex justify-end gap-1">
              <Button size="xs" variant="outline" onClick={runAction}>
                {actionLabel}
              </Button>
              {settled && failed && view.action !== "dismiss" ? (
                <Button size="xs" variant="ghost" onClick={dismissSettledUpdateRunMachines}>
                  {t("Dismiss")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
