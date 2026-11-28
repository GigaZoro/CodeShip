import { useAtomValue } from "@effect/atom-react";
import {
  decideRestartHold,
  type RestartHoldDecision,
  serverRestartHoldWaitingOnAtom,
  serverRestartHoldWaitingOnTurnsAtom,
} from "@t3tools/client-runtime/state/server";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  type OrchestrationV2RestartHold,
  type OrchestrationV2RestartHoldCommand,
  type OrchestrationV2RestartHoldTurn,
  type OrchestrationV2RestartHoldWork,
} from "@t3tools/contracts";
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

/** An update install of this desktop app that waits for chats' active work to finish. */
export interface PendingLocalInstall {
  readonly version: string | null;
  /** Holds a server-side update drain while waiting for running chats and background work. */
  readonly draining?: true;
}

export const pendingLocalInstallAtom = Atom.make<PendingLocalInstall | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("pending-local-install"),
);

export function usePendingLocalInstall(): PendingLocalInstall | null {
  return useAtomValue(pendingLocalInstallAtom);
}

const EMPTY_WORK: ReadonlyArray<OrchestrationV2RestartHoldWork> = [];
const EMPTY_COMMANDS: ReadonlyArray<OrchestrationV2RestartHoldCommand> = [];
const EMPTY_TURNS: ReadonlyArray<OrchestrationV2RestartHoldTurn> = [];

/** Only servers that advertise the capability can report background work; others have none. */
const reportsRestartHold = (environment: EnvironmentPresentation) =>
  environment.serverConfig?.environment.capabilities.restartHold === true;

const supportsUpdateDrain = (environment: EnvironmentPresentation) =>
  environment.serverConfig?.environment.capabilities.updateDrain === true;

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

/** Keyed by `environmentIdsKey`; the work a pending install still waits on there. */
const waitingOnWorkAtom = Atom.family((environmentIds: string) =>
  Atom.make((get): ReadonlyArray<OrchestrationV2RestartHoldWork> => {
    const ids = environmentIds.split("\n").filter((id) => id !== "");
    if (ids.length === 0) return EMPTY_WORK;
    return ids.flatMap((id) => get(serverRestartHoldWaitingOnAtom(EnvironmentId.make(id))));
  }).pipe(Atom.withLabel(`restart-hold-waiting-on:${environmentIds}`)),
);

/** Keyed by `environmentIdsKey`; the chats answering that a pending install still waits on. */
const waitingOnTurnsAtom = Atom.family((environmentIds: string) =>
  Atom.make((get): ReadonlyArray<OrchestrationV2RestartHoldTurn> => {
    const ids = environmentIds.split("\n").filter((id) => id !== "");
    if (ids.length === 0) return EMPTY_TURNS;
    return ids.flatMap((id) => get(serverRestartHoldWaitingOnTurnsAtom(EnvironmentId.make(id))));
  }).pipe(Atom.withLabel(`restart-hold-waiting-on-turns:${environmentIds}`)),
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

/** Whether any server this app hosts advertises the server-side update drain barrier. */
export function useHostedSupportsUpdateDrain(): boolean {
  const { environments } = useEnvironments();
  return environments.some(
    (environment) => holdsRestart(environment) && supportsUpdateDrain(environment),
  );
}

export function readHostedSupportsUpdateDrain(): boolean {
  return readHostedRestartHoldEnvironmentIds().some((environmentId) => {
    const environment = readEnvironment(environmentId);
    return environment !== null && supportsUpdateDrain(environment);
  });
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

/** The chats answering that a draining install still waits on. */
export function usePendingLocalInstallTurns() {
  const pending = usePendingLocalInstall();
  return useAtomValue(waitingOnTurnsAtom(useHostedRestartHoldKey(pending !== null)));
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

export type HostedDrainRunResult<T> =
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly error: unknown };

/**
 * Drains this app's hosted servers (using `server.drainForUpdate` where supported, or falling back
 * to `server.watchRestartHold` on older servers), runs `onReady` while all manual drain leases
 * remain held across the handoff, and releases every lease cleanly on cancel, failure, or return.
 */
export async function runWithHostedUpdateDrain<T>(
  onReady: () => Promise<T>,
): Promise<HostedDrainRunResult<T>> {
  const environmentIds = readHostedRestartHoldEnvironmentIds();
  if (environmentIds.length === 0) {
    return { status: "completed", value: await onReady() };
  }

  let aborted = false;
  let remaining = environmentIds.length;
  let readyPromise: Promise<T> | null = null;
  let resolveReady!: () => void;
  const allReadyOrAborted = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const abortAll = () => {
    if (aborted) return;
    aborted = true;
    decideHostedRestartHold("cancel");
    resolveReady();
  };

  const results = await Promise.all(
    environmentIds.map(async (environmentId) => {
      const environment = readEnvironment(environmentId);
      const drain = environment !== null && supportsUpdateDrain(environment);
      const result = await runAtomCommand(appAtomRegistry, serverEnvironment.awaitRestartHold, {
        environmentId,
        ...(drain ? { drain: true } : {}),
        holdUntil: async () => {
          remaining -= 1;
          if (remaining === 0 && !aborted) {
            readyPromise = onReady();
            resolveReady();
          }
          await allReadyOrAborted;
          if (readyPromise !== null) {
            // Keep the drain lease held until the handoff settles (or the process exits).
            await readyPromise.catch(() => undefined);
          }
        },
      });
      if (result._tag === "Failure" || result.value === "cancel") {
        abortAll();
      }
      return result;
    }),
  );

  for (const result of results) {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      return { status: "failed", error: squashAtomCommandFailure(result) };
    }
  }
  if (aborted || readyPromise === null) {
    return { status: "cancelled" };
  }
  return { status: "completed", value: await readyPromise };
}
