import {
  ManualStepsListError,
  WS_METHODS,
  type EnvironmentId,
  type ManualStep,
  type ManualStepsListFailure,
  type ManualStepsListResult,
  type ServerConfig,
} from "@t3tools/contracts";
import { msg, t, type Message } from "@t3tools/shared/i18n";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** One machine's answer. `offline` covers a server that could not be asked. */
export type ManualStepsSource =
  | { readonly status: "loading" }
  | { readonly status: "not-connected" }
  | { readonly status: "listed"; readonly steps: ReadonlyArray<ManualStep> }
  | { readonly status: "failed"; readonly reason: ManualStepsListFailure | "offline" };

export interface ManualStepGroup {
  readonly machine: string;
  readonly steps: ReadonlyArray<ManualStep>;
}

export type ManualStepsView =
  | { readonly status: "loading" }
  /** No machine has a ThreadPage token. */
  | { readonly status: "not-connected" }
  | { readonly status: "failed"; readonly reason: ManualStepsListFailure | "offline" }
  | {
      readonly status: "listed";
      readonly groups: ReadonlyArray<ManualStepGroup>;
      readonly count: number;
    };

export interface ManualStepsState {
  readonly view: ManualStepsView;
  /** A machine is reading ThreadPage now, on open, on a timer or on Refresh. */
  readonly refreshing: boolean;
}

const FAILURE_MESSAGES: Record<ManualStepsListFailure | "offline", Message> = {
  "token-rejected": msg("ThreadPage refused the token. Save a new one in Settings."),
  "access-denied": msg(
    "The ThreadPage token cannot read threads. Give its connection Read access.",
  ),
  paused: msg(
    "The ThreadPage connection is paused. Resume it in ThreadPage Settings, Connections.",
  ),
  "rate-limited": msg("ThreadPage is busy. Try again in a minute."),
  "no-inbox": msg("The ThreadPage token sees no Machine inbox folder."),
  unreachable: msg("Could not reach ThreadPage."),
  offline: msg("Could not reach the machine that reads ThreadPage."),
};

export const manualStepsFailureMessage = (reason: ManualStepsListFailure | "offline") =>
  t(FAILURE_MESSAGES[reason]);

const byUrgency = (left: ManualStep, right: ManualStep) =>
  Number(right.kind === "needs-you") - Number(left.kind === "needs-you") ||
  right.updatedAt.localeCompare(left.updatedAt) ||
  left.title.localeCompare(right.title);

/**
 * Every machine reads the same ThreadPage lists, so a step can arrive from several; it shows once.
 * Machines are grouped with money decisions first, then by name; inside a group money decisions
 * come first, then the most recently updated.
 */
function groupManualSteps(steps: ReadonlyArray<ManualStep>): ReadonlyArray<ManualStepGroup> {
  const byThread = new Map<string, ManualStep>();
  for (const step of steps) {
    const known = byThread.get(step.threadId);
    if (known === undefined || step.updatedAt > known.updatedAt) byThread.set(step.threadId, step);
  }
  const byMachine = new Map<string, ManualStep[]>();
  for (const step of byThread.values()) {
    byMachine.set(step.machine, [...(byMachine.get(step.machine) ?? []), step]);
  }
  const groups = [...byMachine].map(([machine, machineSteps]) => ({
    machine,
    steps: machineSteps.sort(byUrgency),
  }));
  const hasMoney = (group: ManualStepGroup) =>
    group.steps.some((step) => step.kind === "needs-you");
  return groups.sort(
    (left, right) =>
      Number(hasMoney(right)) - Number(hasMoney(left)) || left.machine.localeCompare(right.machine),
  );
}

/** One machine's list is enough to show; a failure shows only when no machine listed. */
export function combineManualSteps(sources: ReadonlyArray<ManualStepsSource>): ManualStepsView {
  const listed = sources.flatMap((source) => (source.status === "listed" ? [source.steps] : []));
  if (listed.length > 0) {
    const groups = groupManualSteps(listed.flat());
    return {
      status: "listed",
      groups,
      count: groups.reduce((total, group) => total + group.steps.length, 0),
    };
  }
  if (sources.some((source) => source.status === "loading")) return { status: "loading" };
  const failures = sources.flatMap((source) => (source.status === "failed" ? [source] : []));
  const failure = failures.find((source) => source.reason !== "offline") ?? failures[0];
  return failure === undefined ? { status: "not-connected" } : failure;
}

const isManualStepsListError = Schema.is(ManualStepsListError);

function manualStepsSource(
  result: AsyncResult.AsyncResult<ManualStepsListResult, unknown>,
): ManualStepsSource {
  const value = AsyncResult.value(result);
  if (Option.isSome(value)) {
    return value.value._tag === "NotConnected"
      ? { status: "not-connected" }
      : { status: "listed", steps: value.value.steps };
  }
  if (result._tag !== "Failure") return { status: "loading" };
  const error = Cause.findErrorOption(result.cause);
  return {
    status: "failed",
    reason:
      Option.isSome(error) && isManualStepsListError(error.value) ? error.value.reason : "offline",
  };
}

/** The key of `view` for the connected servers that serve the list, or null when none does. */
export function manualStepsEnvironmentIdsKey(
  serverConfigs: ReadonlyMap<EnvironmentId, Pick<ServerConfig, "environment">>,
): string | null {
  const environmentIds = [...serverConfigs]
    .filter(([, config]) => config.environment.capabilities.manualSteps === true)
    .map(([environmentId]) => environmentId);
  return environmentIds.length === 0 ? null : JSON.stringify(environmentIds);
}

export function createManualStepsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:manual-steps:list",
    tag: WS_METHODS.manualStepsList,
    // Each read asks ThreadPage for every machine folder, so an open panel shares one briefly.
    staleTimeMs: 60_000,
    refreshIntervalMs: 5 * 60_000,
  });
  /** Keyed by a JSON array of the environment ids that serve `manualSteps.list`. */
  const view = Atom.family((environmentIdsKey: string) => {
    const atoms = (JSON.parse(environmentIdsKey) as ReadonlyArray<EnvironmentId>).map(
      (environmentId) => list({ environmentId, input: {} }),
    );
    return Atom.readable(
      (get): ManualStepsState => {
        const results = atoms.map((atom) => get(atom));
        return {
          view: combineManualSteps(results.map(manualStepsSource)),
          refreshing: results.some((result) => result.waiting),
        };
      },
      (refresh) => {
        for (const atom of atoms) refresh(atom);
      },
    ).pipe(Atom.withLabel(`environment-data:manual-steps:view:${environmentIdsKey}`));
  });
  return { list, view };
}
