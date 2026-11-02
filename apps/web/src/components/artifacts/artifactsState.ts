import { useAtomValue } from "@effect/atom-react";
import {
  ORCHESTRATION_V2_HTML_RENDER_LIST_MAX,
  type EnvironmentId,
  type OrchestrationV2HtmlRenderListItem,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentAtomList, environmentIdsKey } from "~/state/environmentAtomList";
import { orchestrationEnvironment } from "~/state/orchestration";

export interface Artifact extends OrchestrationV2HtmlRenderListItem {
  readonly environmentId: EnvironmentId;
}

export const artifactKey = (artifact: Pick<Artifact, "environmentId" | "attachmentId">) =>
  `${artifact.environmentId}:${artifact.attachmentId}`;

const rendersAtom = (environmentId: EnvironmentId) =>
  orchestrationEnvironment.htmlRenders({
    environmentId,
    input: { limit: ORCHESTRATION_V2_HTML_RENDER_LIST_MAX },
  });

const rendersByEnvironmentAtom = environmentAtomList("web:artifacts", rendersAtom);

/** Every connected environment's pages, newest first. */
export function useArtifacts(environmentIds: ReadonlyArray<EnvironmentId>) {
  const results = useAtomValue(rendersByEnvironmentAtom(environmentIdsKey(environmentIds)));
  const artifacts: Array<Artifact> = [];
  const failedEnvironmentIds: Array<EnvironmentId> = [];
  let isLoading = false;
  let truncated = false;
  for (const [index, result] of results.entries()) {
    const environmentId = environmentIds[index]!;
    if (result.waiting) isLoading = true;
    if (result._tag === "Failure") failedEnvironmentIds.push(environmentId);
    const list = AsyncResult.getOrElse(result, () => null);
    if (list === null) continue;
    if (list.truncated) truncated = true;
    for (const render of list.renders) artifacts.push({ ...render, environmentId });
  }
  artifacts.sort(
    (left, right) =>
      right.publishedAt.localeCompare(left.publishedAt) ||
      artifactKey(left).localeCompare(artifactKey(right)),
  );
  return {
    artifacts,
    failedEnvironmentIds,
    isLoading,
    truncated,
    refresh: () => {
      for (const environmentId of environmentIds)
        appAtomRegistry.refresh(rendersAtom(environmentId));
    },
  };
}
