import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection, ProjectId } from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { resolveInheritedDefaultModelSelection } from "@t3tools/shared/serverSettings";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentServerConfigsAtom } from "./server";

const inheritedDefaultModelSelectionAtom = Atom.family((key: string) => {
  const [environmentId, projectId] = JSON.parse(key) as [EnvironmentId, ProjectId | null];
  let previous: ModelSelection | null = null;
  // Config pushes rebuild the map often; keep the reference so readers do not re-render.
  return Atom.make((get) => {
    const next = resolveInheritedDefaultModelSelection({
      configs: get(environmentServerConfigsAtom),
      environmentId,
      projectId,
      preferredEnvironmentId: get(primaryEnvironmentIdAtom),
    });
    if (next === null || previous === null || !modelSelectionsEqual(next, previous)) {
      previous = next;
    }
    return previous;
  }).pipe(Atom.withLabel(`web-inherited-default-model:${key}`));
});

const noInheritedDefaultModelSelectionAtom = Atom.make<ModelSelection | null>(null);

function inheritedDefaultModelSelectionKey(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
) {
  return JSON.stringify([environmentId, projectId]);
}

/** The default a machine without its own runs, taken from another machine. */
export function useInheritedDefaultModelSelection(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): ModelSelection | null {
  return useAtomValue(
    environmentId === null
      ? noInheritedDefaultModelSelectionAtom
      : inheritedDefaultModelSelectionAtom(
          inheritedDefaultModelSelectionKey(environmentId, projectId),
        ),
  );
}

export function readInheritedDefaultModelSelection(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): ModelSelection | null {
  return appAtomRegistry.get(
    inheritedDefaultModelSelectionAtom(inheritedDefaultModelSelectionKey(environmentId, projectId)),
  );
}
