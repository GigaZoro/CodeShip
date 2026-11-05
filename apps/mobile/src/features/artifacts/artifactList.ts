import type { EnvironmentId, OrchestrationV2HtmlRenderListItem } from "@t3tools/contracts";

export interface EnvironmentArtifact extends OrchestrationV2HtmlRenderListItem {
  readonly environmentId: EnvironmentId;
}

export const artifactKey = (
  artifact: Pick<EnvironmentArtifact, "environmentId" | "attachmentId">,
) => `${artifact.environmentId}:${artifact.attachmentId}`;

/** Newest first across environments; the key breaks ties so the order is stable. */
export function sortArtifactsNewestFirst(artifacts: ReadonlyArray<EnvironmentArtifact>) {
  return [...artifacts].sort(
    (left, right) =>
      right.publishedAt.localeCompare(left.publishedAt) ||
      artifactKey(left).localeCompare(artifactKey(right)),
  );
}

export function filterArtifacts(artifacts: ReadonlyArray<EnvironmentArtifact>, query: string) {
  const folded = query.trim().toLocaleLowerCase();
  if (folded === "") return artifacts;
  return artifacts.filter((artifact) =>
    [artifact.title, artifact.threadTitle, artifact.projectTitle ?? ""].some((text) =>
      text.toLocaleLowerCase().includes(folded),
    ),
  );
}
