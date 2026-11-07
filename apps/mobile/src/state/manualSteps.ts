import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  createManualStepsEnvironmentAtoms,
  manualStepsEnvironmentIdsKey,
  type ManualStepsState,
} from "@t3tools/client-runtime/state/manualSteps";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";

const manualStepsEnvironment = createManualStepsEnvironmentAtoms(connectionAtomRuntime);

const NO_MANUAL_STEPS_ATOM = Atom.make<ManualStepsState | null>(null).pipe(
  Atom.withLabel("mobile:manual-steps:none"),
);

/** Null when no connected machine serves the list; one machine with a token fills it. */
export function useManualSteps(): {
  readonly state: ManualStepsState | null;
  readonly refresh: () => void;
} {
  const environmentIdsKey = manualStepsEnvironmentIdsKey(useServerConfigs());
  const atom =
    environmentIdsKey === null
      ? NO_MANUAL_STEPS_ATOM
      : manualStepsEnvironment.view(environmentIdsKey);
  return { state: useAtomValue(atom), refresh: useAtomRefresh(atom) };
}
