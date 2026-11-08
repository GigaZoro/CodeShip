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
import { EnvironmentId, type OrchestrationV2RestartHoldWork } from "@t3tools/contracts";
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
}

export const pendingLocalInstallAtom = Atom.make<PendingLocalInstall | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("pending-local-install"),
);

export function usePendingLocalInstall(): PendingLocalInstall | null {
  return useAtomValue(pendingLocalInstallAtom);
}

const EMPTY_WORK: ReadonlyArray<OrchestrationV2RestartHoldWork> = [];

/** Only servers that advertise the capability can report background work; others have none. */
const holdsRestart = (environment: EnvironmentPresentation) =>
  isHostedByThisApp(environment) &&
  environment.serverConfig?.environment.capabilities.restartHold === true;

/** Keyed by `environmentIdsKey`; the work every listed server's chats wait on. */
const restartHoldWorkAtom = Atom.family((environmentIds: string) =>
  Atom.make((get): ReadonlyArray<OrchestrationV2RestartHoldWork> => {
    const ids = environmentIds.split("\n").filter((id) => id !== "");
    if (ids.length === 0) return EMPTY_WORK;
    return ids.flatMap(
      (id) =>
        AsyncResult.getOrElse(
          get(serverEnvironment.restartHold({ environmentId: EnvironmentId.make(id), input: {} })),
          () => null,
        )?.work ?? EMPTY_WORK,
    );
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

const restartHoldWorkCountAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) => get(restartHoldWorkAtom(environmentIds)).length).pipe(
    Atom.withLabel(`restart-hold-work-count:${environmentIds}`),
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

/** The work listed when a pending install began that is still running; later work is left out. */
export function usePendingLocalInstallWork() {
  const pending = usePendingLocalInstall();
  return useAtomValue(waitingOnWorkAtom(useHostedRestartHoldKey(pending !== null)));
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
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly error: unknown };

/** Resolves when the work listed on this app's servers has ended, or the user decides first. */
export async function waitForHostedBackgroundWork(): Promise<HostedWorkWait> {
  const environmentIds = readHostedRestartHoldEnvironmentIds();
  const results = await Promise.all(
    environmentIds.map(async (environmentId) => {
      const result = await serverEnvironment.awaitRestartHold.run(appAtomRegistry, {
        environmentId,
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
  return cancelled ? { status: "cancelled" } : { status: "clear" };
}
