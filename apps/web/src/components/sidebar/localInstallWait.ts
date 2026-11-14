import { useAtomValue } from "@effect/atom-react";
import {
  decideRestartHold,
  type RestartHoldDecision,
  serverRestartHoldWaitingOnAtom,
} from "@t3tools/client-runtime/state/server";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  type OrchestrationV2RestartHold,
  type OrchestrationV2RestartHoldCommand,
  type OrchestrationV2RestartHoldTurn,
  type OrchestrationV2RestartHoldWork,
} from "@t3tools/contracts";
import { isRestartHoldEmpty } from "@t3tools/shared/restartHold";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentIdsKey } from "~/state/environmentAtomList";
import {
  type EnvironmentPresentation,
  readEnvironment,
  useEnvironments,
} from "~/state/environments";
import { environmentPresentations } from "~/state/presentation";
import { serverEnvironment } from "~/state/server";
import { isHostedByThisApp } from "./useUpdateEverything";

/** An update install of this desktop app that waits for chats' background work to finish. */
export interface PendingLocalInstall {
  readonly version: string | null;
  /** Started by "Install updates automatically when idle", not by the user. */
  readonly automatic?: true;
}

export const pendingLocalInstallAtom = Atom.make<PendingLocalInstall | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("pending-local-install"),
);

export function usePendingLocalInstall(): PendingLocalInstall | null {
  return useAtomValue(pendingLocalInstallAtom);
}

const EMPTY_WORK: ReadonlyArray<OrchestrationV2RestartHoldWork> = [];
const EMPTY_TURNS: ReadonlyArray<OrchestrationV2RestartHoldTurn> = [];
const EMPTY_COMMANDS: ReadonlyArray<OrchestrationV2RestartHoldCommand> = [];

/** Only servers that advertise the capability can report background work; others have none. */
const reportsRestartHold = (environment: EnvironmentPresentation) =>
  environment.serverConfig?.environment.capabilities.restartHold === true;

const holdsRestart = (environment: EnvironmentPresentation) =>
  isHostedByThisApp(environment) && reportsRestartHold(environment);

/** Keyed by `environmentIdsKey`; the latest hold each listed server reported. */
const restartHoldsAtom = Atom.family((environmentIds: string) =>
  Atom.make((get): ReadonlyArray<OrchestrationV2RestartHold> =>
    environmentIds.split("\n").flatMap((id) => {
      if (id === "") return [];
      const hold = AsyncResult.getOrElse(
        get(serverEnvironment.restartHold({ environmentId: EnvironmentId.make(id), input: {} })),
        () => null,
      );
      return hold === null ? [] : [hold];
    }),
  ).pipe(Atom.withLabel(`restart-holds:${environmentIds}`)),
);

/** Keyed by `environmentIdsKey`; the work every listed server's chats wait on. */
const restartHoldWorkAtom = Atom.family((environmentIds: string) =>
  Atom.make((get): ReadonlyArray<OrchestrationV2RestartHoldWork> => {
    const holds = get(restartHoldsAtom(environmentIds));
    return holds.length === 0 ? EMPTY_WORK : holds.flatMap((hold) => hold.work);
  }).pipe(Atom.withLabel(`restart-hold-work:${environmentIds}`)),
);

/** Keyed by `environmentIdsKey`; the chats answering on every listed server. */
const runningTurnsAtom = Atom.family((environmentIds: string) =>
  Atom.make((get): ReadonlyArray<OrchestrationV2RestartHoldTurn> => {
    const holds = get(restartHoldsAtom(environmentIds));
    return holds.length === 0 ? EMPTY_TURNS : holds.flatMap((hold) => hold.runningTurns ?? []);
  }).pipe(Atom.withLabel(`restart-hold-running-turns:${environmentIds}`)),
);

/** Keyed by `environmentIdsKey`; the work a pending install still waits on there. */
const waitingOnWorkAtom = Atom.family((environmentIds: string) =>
  Atom.make((get): ReadonlyArray<OrchestrationV2RestartHoldWork> => {
    const ids = environmentIds.split("\n").filter((id) => id !== "");
    if (ids.length === 0) return EMPTY_WORK;
    return ids.flatMap((id) => get(serverRestartHoldWaitingOnAtom(EnvironmentId.make(id))));
  }).pipe(Atom.withLabel(`restart-hold-waiting-on:${environmentIds}`)),
);

const restartHoldWorkCountAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) => get(restartHoldWorkAtom(environmentIds)).length).pipe(
    Atom.withLabel(`restart-hold-work-count:${environmentIds}`),
  ),
);

/** Keyed by `environmentIdsKey`; the `t3_command_run` commands that carry on through a restart. */
const restartHoldCommandsAtom = Atom.family((environmentIds: string) =>
  Atom.make((get): ReadonlyArray<OrchestrationV2RestartHoldCommand> => {
    const holds = get(restartHoldsAtom(environmentIds));
    return holds.length === 0 ? EMPTY_COMMANDS : holds.flatMap((hold) => hold.commands ?? []);
  }).pipe(Atom.withLabel(`restart-hold-commands:${environmentIds}`)),
);

const restartHoldCommandCountAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) => get(restartHoldCommandsAtom(environmentIds)).length).pipe(
    Atom.withLabel(`restart-hold-command-count:${environmentIds}`),
  ),
);

/** The servers this app hosts that can report background work, as an `environmentIdsKey`. */
export function useHostedRestartHoldKey(enabled = true): string {
  const { environments } = useEnvironments();
  return enabled
    ? environmentIdsKey(environments.filter(holdsRestart).map(({ environmentId }) => environmentId))
    : "";
}

export function useRestartHoldWork(environmentIds: string) {
  return useAtomValue(restartHoldWorkAtom(environmentIds));
}

export function useRestartHoldWorkCount(environmentIds: string) {
  return useAtomValue(restartHoldWorkCountAtom(environmentIds));
}

export function useRestartHoldCommands(environmentIds: string) {
  return useAtomValue(restartHoldCommandsAtom(environmentIds));
}

export function useRestartHoldCommandCount(environmentIds: string) {
  return useAtomValue(restartHoldCommandCountAtom(environmentIds));
}

/** The commands that carry on through a restart of any of these servers, hosted here or not. */
export function useRestartingCommandCount(environmentIds: ReadonlySet<string>): number {
  const { environments } = useEnvironments();
  return useRestartHoldCommandCount(
    environmentIdsKey(
      environments
        .filter(
          (environment) =>
            environmentIds.has(environment.environmentId) && reportsRestartHold(environment),
        )
        .map(({ environmentId }) => environmentId),
    ),
  );
}

/** The work listed when a pending install began that is still running; later work is left out. */
export function usePendingLocalInstallWork() {
  const pending = usePendingLocalInstall();
  return useAtomValue(waitingOnWorkAtom(useHostedRestartHoldKey(pending !== null)));
}

/** The chats an automatic install waits on to finish answering; a manual one waits on none. */
export function usePendingLocalInstallTurns() {
  const pending = usePendingLocalInstall();
  return useAtomValue(runningTurnsAtom(useHostedRestartHoldKey(pending?.automatic === true)));
}

function readHostedRestartHoldEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return [...appAtomRegistry.get(environmentPresentations.presentationsAtom).keys()].filter(
    (environmentId) => {
      const environment = readEnvironment(environmentId);
      return environment !== null && holdsRestart(environment);
    },
  );
}

/** Ends every wait on this app's servers, so one decision applies to all of them. */
export function decideHostedRestartHold(decision: RestartHoldDecision): void {
  for (const environmentId of readHostedRestartHoldEnvironmentIds()) {
    decideRestartHold(appAtomRegistry, environmentId, decision);
  }
}

export type HostedWorkWait =
  | { readonly status: "clear" }
  /** The user chose to update now, whatever still runs. */
  | { readonly status: "update-now" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly error: unknown };

/**
 * Resolves when the work listed on this app's servers has ended, or the user decides first.
 * With `untilIdle`, it waits until no work is left and no chat is answering, work and turns that
 * started meanwhile included.
 */
export async function waitForHostedBackgroundWork(options?: {
  readonly untilIdle?: boolean;
}): Promise<HostedWorkWait> {
  const environmentIds = readHostedRestartHoldEnvironmentIds();
  const results = await Promise.all(
    environmentIds.map(async (environmentId) => {
      const result = await serverEnvironment.awaitRestartHold.run(appAtomRegistry, {
        environmentId,
        ...(options?.untilIdle === true ? { untilIdle: true } : {}),
      });
      // The other servers' waits end with this one, or the install would stay half-decided.
      if (result._tag === "Failure" || result.value === "cancel") decideHostedRestartHold("cancel");
      return result;
    }),
  );
  for (const result of results) {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      return { status: "failed", error: squashAtomCommandFailure(result) };
    }
  }
  const cancelled = results.some(
    (result) =>
      result._tag === "Failure" || (result._tag === "Success" && result.value === "cancel"),
  );
  if (cancelled) return { status: "cancelled" };
  const decidedNow = results.some(
    (result) => result._tag === "Success" && result.value === "update-now",
  );
  return decidedNow ? { status: "update-now" } : { status: "clear" };
}

export type HostedWorkNow =
  | { readonly status: "idle" }
  | { readonly status: "busy" }
  | { readonly status: "failed"; readonly error: unknown };

/** Whether any chat on this app's servers has background work or is answering right now. */
export async function readHostedBackgroundWork(): Promise<HostedWorkNow> {
  const results = await Promise.all(
    readHostedRestartHoldEnvironmentIds().map((environmentId) =>
      serverEnvironment.readRestartHold.run(appAtomRegistry, { environmentId }),
    ),
  );
  for (const result of results) {
    if (result._tag === "Failure")
      return { status: "failed", error: squashAtomCommandFailure(result) };
  }
  return results.some((result) => result._tag === "Success" && !isRestartHoldEmpty(result.value))
    ? { status: "busy" }
    : { status: "idle" };
}
