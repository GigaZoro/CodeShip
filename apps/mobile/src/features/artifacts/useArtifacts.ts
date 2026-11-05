import { useAtomValue } from "@effect/atom-react";
import {
  ORCHESTRATION_V2_HTML_RENDER_LIST_MAX,
  type EnvironmentId,
  type OrchestrationV2HtmlRenderList,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { orchestrationEnvironment } from "../../state/orchestration";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { sortArtifactsNewestFirst, type EnvironmentArtifact } from "./artifactList";
import { t } from "../../lib/i18n";

const rendersAtom = (environmentId: EnvironmentId) =>
  orchestrationEnvironment.htmlRenders({
    environmentId,
    input: { limit: ORCHESTRATION_V2_HTML_RENDER_LIST_MAX },
  });

const refreshArtifacts = (environmentIds: ReadonlyArray<EnvironmentId>) => {
  for (const environmentId of environmentIds) appAtomRegistry.refresh(rendersAtom(environmentId));
};

export const refreshConnectedArtifacts = () =>
  refreshArtifacts(appAtomRegistry.get(connectedEnvironmentIdsAtom));

const environmentRendersAtom = Atom.family((key: string) =>
  Atom.make((get) =>
    key === ""
      ? []
      : (key.split("\n") as EnvironmentId[]).map(
          (environmentId) => [environmentId, get(rendersAtom(environmentId))] as const,
        ),
  ).pipe(Atom.withLabel(`mobile:artifacts:${key}`)),
);

function failureMessage(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : t("The environment request failed.");
}

/** Every connected environment's published pages, newest first. */
export function useArtifacts(environmentIds: ReadonlyArray<EnvironmentId>) {
  const key = environmentIds.join("\n");
  const results = useAtomValue(environmentRendersAtom(key));
  const refresh = useCallback(
    () => refreshArtifacts(key === "" ? [] : (key.split("\n") as EnvironmentId[])),
    [key],
  );
  const artifacts: Array<EnvironmentArtifact> = [];
  let error: string | null = null;
  let isLoading = false;
  for (const [environmentId, result] of results) {
    if (result.waiting) isLoading = true;
    if (result._tag === "Failure") if (error === null) error = failureMessage(result.cause);
    const list: OrchestrationV2HtmlRenderList | null = AsyncResult.getOrElse(result, () => null);
    if (list === null) continue;
    for (const render of list.renders) artifacts.push({ ...render, environmentId });
  }
  return {
    artifacts: sortArtifactsNewestFirst(artifacts),
    error,
    isLoading,
    refresh,
  };
}
